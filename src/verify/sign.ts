import { ResolvedConfig } from '../core/config.js'
import { VouchflowError } from '../core/errors.js'
import { HttpClient } from '../transport/http.js'
import { bytesToBase64 } from '../core/encoding.js'
import { canonicalize } from './canonicalize.js'
import { bytesToBase64url, utf8ToBytes } from '../core/encoding.js'
import { webauthnGet } from './webauthn-get.js'
import { performEnroll } from '../enroll/enroll.js'
import { StateStore } from '../core/state-store.js'
import { Confidence, SignResult } from '../types.js'

export interface SignContext {
  config: ResolvedConfig
  http: HttpClient
  store: StateStore
}

export interface SignArgs {
  context: string
  payload: unknown
  userHandle?: string
  minConfidence?: Confidence
  signal?: AbortSignal
  prfSalt?: Uint8Array
}

interface InitiateResponse {
  session_id: string
  challenge: string
  expires_at: string
  payload_sha256: string
}

interface CompleteResponse {
  verified: boolean
  confidence: Confidence
  device_token: string
  signing_device_id: string
  signed_at: string
  assertion: string
  session_id: string
}

export async function performSignPayload(
  ctx: SignContext,
  args: SignArgs,
): Promise<SignResult> {
  const userHandle = args.userHandle ?? '__default__'
  let device = await ctx.store.get(userHandle)

  // Auto-enroll on first sign just like verify(), so signPayload() is a
  // self-sufficient call.
  if (!device || device.credentials.length === 0) {
    const enrolled = await performEnroll(
      { config: ctx.config, http: ctx.http, store: ctx.store },
      { userHandle, signal: args.signal },
    )
    device = enrolled.device
  }

  const minConfidence = args.minConfidence ?? 'high'
  const canonicalized = canonicalize(args.payload)
  // Replay-safe key — the SDK retries POSTs up to 3× on 5xx; without an
  // idempotency_key a dropped response would mint two sign sessions for
  // the same payload (two distinct valid JWS assertions, different iat).
  const idemBuf = new Uint8Array(16)
  crypto.getRandomValues(idemBuf)
  const idempotencyKey = `sk_${bytesToBase64url(idemBuf)}`

  const init = await ctx.http.request<InitiateResponse>({
    method: 'POST',
    path: '/v1/sign',
    body: {
      device_token: device.deviceId,
      context: args.context,
      canonicalized_payload: canonicalized,
      minimum_confidence: minConfidence,
      idempotency_key: idempotencyKey,
    },
    signal: args.signal,
  })

  // RFC §3: signing_input = SHA-256(canonical_payload_bytes || challenge_bytes).
  // The WebAuthn ceremony's challenge is base64url(signing_input). Server
  // verifies the WebAuthn-bound challenge equals that hash — payload binding
  // is cryptographic, not just server-enforced via payload_sha256.
  const challengeBytes = base64ToBytes(init.challenge)
  const canonicalBytes = utf8ToBytes(canonicalized)
  const signingInputBytes = new Uint8Array(canonicalBytes.byteLength + challengeBytes.byteLength)
  signingInputBytes.set(canonicalBytes, 0)
  signingInputBytes.set(challengeBytes, canonicalBytes.byteLength)
  const signingInputAb = new ArrayBuffer(signingInputBytes.byteLength)
  new Uint8Array(signingInputAb).set(signingInputBytes)
  const signingInputHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', signingInputAb),
  )

  const credentialIds = device.credentials.map((c) => c.credentialId)
  const assertion = await webauthnGet({
    config: ctx.config,
    challenge: signingInputHash,
    credentialIds,
    signal: args.signal,
    prfSalt: args.prfSalt,
  }).catch((err: unknown) => {
    if (err instanceof VouchflowError) {
      if (err.code === 'biometric_cancelled' || err.code === 'biometric_failed') {
        throw new VouchflowError({
          code: err.code,
          message: err.message,
          sessionId: init.session_id,
          cause: err.cause,
        })
      }
    }
    throw err
  })

  const complete = await ctx.http.request<CompleteResponse>({
    method: 'POST',
    path: `/v1/sign/${init.session_id}/complete`,
    body: {
      device_token: device.deviceId,
      signed_challenge: bytesToBase64(new Uint8Array(assertion.signature)),
      client_data_json: bytesToBase64(new Uint8Array(assertion.clientDataJSON)),
      authenticator_data: bytesToBase64(new Uint8Array(assertion.authenticatorData)),
      credential_id: assertion.credentialId,
    },
    signal: args.signal,
  })

  if (!complete.verified) {
    throw new VouchflowError({
      code: 'invalid_signature',
      message: 'Server rejected sign assertion',
      sessionId: init.session_id,
    })
  }

  return {
    payload: canonicalized,
    signature: bytesToBase64url(new Uint8Array(assertion.signature)),
    algorithm: 'ES256',  // SDK requested ES256/RS256/EdDSA — server doesn't echo back
    deviceToken: complete.device_token,
    signingDeviceId: complete.signing_device_id,
    signedAt: complete.signed_at,
    confidence: complete.confidence,
    assertion: complete.assertion,
    sessionId: complete.session_id,
    prfResult: assertion.prfResult ? new Uint8Array(assertion.prfResult) : undefined,
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

