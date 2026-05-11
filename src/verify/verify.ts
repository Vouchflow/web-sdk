import { ResolvedConfig } from '../core/config.js'
import { VouchflowError } from '../core/errors.js'
import { HttpClient } from '../transport/http.js'
import {
  base64urlToBytes,
  bytesToBase64,
  base64ToBase64url,
  base64urlToBase64,
} from '../core/encoding.js'
import { webauthnGet } from './webauthn-get.js'
import { performEnroll } from '../enroll/enroll.js'
import { StateStore } from '../core/state-store.js'
import { Confidence, VerifyResult } from '../types.js'

export interface VerifyContext {
  config: ResolvedConfig
  http: HttpClient
  store: StateStore
}

export interface VerifyArgs {
  context: string
  userHandle?: string
  minConfidence?: Confidence
  signal?: AbortSignal
}

interface InitiateResponse {
  session_id: string
  challenge: string
  expires_at: string
  session_state: string
}

interface CompleteResponse {
  verified: boolean
  confidence: Confidence
  session_state: string
  device_token: string
  device_age_days: number
  network_verifications: number
  first_seen: string
  signals: {
    keychain_persistent: boolean
    biometric_used: boolean
    cross_app_history: boolean
    anomaly_flags: string[]
    attestation_verified: boolean
  }
  fallback_used: boolean
  context: string
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

export async function performVerify(
  ctx: VerifyContext,
  args: VerifyArgs,
): Promise<VerifyResult> {
  const userHandle = args.userHandle ?? '__default__'
  let device = await ctx.store.get(userHandle)

  // Auto-enroll if no local state. The mobile SDKs do the same on first call —
  // it's the documented zero-config UX.
  if (!device || device.credentials.length === 0) {
    const enrolled = await performEnroll(
      { config: ctx.config, http: ctx.http, store: ctx.store },
      { userHandle, signal: args.signal },
    )
    device = enrolled.device
  }

  if (device.configuredRpId !== ctx.config.rpId) {
    // The rpId changed since enrollment — WebAuthn will reject the assertion.
    // Surface as invalid_config rather than letting it look like a server bug.
    throw new VouchflowError({
      code: 'invalid_config',
      message: `Stored device was enrolled under rpId="${device.configuredRpId}" but config.rpId is "${ctx.config.rpId}"`,
    })
  }

  const minConfidence = args.minConfidence ?? 'medium'

  // 1. Initiate verify session — server returns a fresh challenge
  const initBody: Record<string, unknown> = {
    device_token: device.deviceId,
    context: args.context,
    minimum_confidence: minConfidence,
  }

  let init: InitiateResponse
  try {
    init = await ctx.http.request<InitiateResponse>({
      method: 'POST',
      path: '/v1/verify',
      body: initBody,
      signal: args.signal,
    })
  } catch (err) {
    if (err instanceof VouchflowError && err.code === 'minimum_confidence_unmet') {
      throw new VouchflowError({
        code: 'minimum_confidence_unmet',
        message: err.message,
        actualConfidence: undefined,  // server doesn't return ceiling on rejection
        cause: err,
      })
    }
    throw err
  }

  // 2. Run WebAuthn ceremony with the server-issued challenge.
  // Server returns base64; WebAuthn challenges are bytes.
  const challengeBytes = base64ToBytes(init.challenge)

  const credentialIds = device.credentials.map((c) => c.credentialId)
  const assertion = await webauthnGet({
    config: ctx.config,
    challenge: challengeBytes,
    credentialIds,
    signal: args.signal,
  }).catch((err: unknown) => {
    if (err instanceof VouchflowError) {
      // Annotate biometric failures with the session_id so callers can pass
      // it to requestFallback.
      if (err.code === 'biometric_cancelled' || err.code === 'biometric_failed') {
        throw new VouchflowError({
          code: err.code,
          message: err.message,
          sessionId: init.session_id,
          cause: err.cause,
        })
      }
      throw err
    }
    throw err
  })

  // 3. Complete the session
  const complete = await ctx.http.request<CompleteResponse>({
    method: 'POST',
    path: `/v1/verify/${init.session_id}/complete`,
    body: {
      device_token: device.deviceId,
      signed_challenge: bytesToBase64(new Uint8Array(assertion.signature)),
      biometric_used: true,
      client_data_json: bytesToBase64(new Uint8Array(assertion.clientDataJSON)),
      authenticator_data: bytesToBase64(new Uint8Array(assertion.authenticatorData)),
      credential_id: assertion.credentialId,
    },
    signal: args.signal,
  })

  if (!complete.verified) {
    throw new VouchflowError({
      code: 'invalid_signature',
      message: 'Server rejected WebAuthn assertion',
      sessionId: init.session_id,
    })
  }

  // Enforce minConfidence client-side too — defense in depth (server already
  // rejects below ceiling, but a downgraded server response shouldn't slip past).
  if (CONFIDENCE_RANK[complete.confidence] < CONFIDENCE_RANK[minConfidence]) {
    throw new VouchflowError({
      code: 'minimum_confidence_unmet',
      message: `Got confidence=${complete.confidence}, required at least ${minConfidence}`,
      sessionId: init.session_id,
      actualConfidence: complete.confidence,
    })
  }

  // Persist last-verified timestamp
  await ctx.store.put({ ...device, lastVerifiedAt: new Date().toISOString() })

  return {
    verified: true,
    confidence: complete.confidence,
    deviceToken: complete.device_token,
    sessionId: init.session_id,
    biometricUsed: complete.signals.biometric_used,
    signals: {
      keychainPersistent: complete.signals.keychain_persistent,
      anomalyFlags: complete.signals.anomaly_flags,
      deviceAgeDays: complete.device_age_days,
      crossAppHistory: complete.signals.cross_app_history,
      attestationVerified: complete.signals.attestation_verified,
    },
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// Re-exports to keep imports clean
export { base64ToBase64url, base64urlToBase64, base64urlToBytes }
