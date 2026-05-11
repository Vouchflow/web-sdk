import { ResolvedConfig } from '../core/config.js'
import { VouchflowError } from '../core/errors.js'
import { HttpClient } from '../transport/http.js'
import {
  bytesToBase64,
  bytesToBase64url,
} from '../core/encoding.js'
import { parseAttestationFormat } from '../core/attestation.js'
import { webauthnCreate } from './webauthn-create.js'
import {
  CredentialRecord,
  DeviceRecord,
  StateStore,
} from '../core/state-store.js'

export interface EnrollContext {
  config: ResolvedConfig
  http: HttpClient
  store: StateStore
}

export interface EnrollArgs {
  userHandle: string
  signal?: AbortSignal
  /** Force a fresh credential even if state already has one. */
  forceNew?: boolean
}

export interface EnrollOutput {
  device: DeviceRecord
  credential: CredentialRecord
}

interface EnrollServerResponse {
  device_token: string
  enrolled_at: string
  status: string
  attestation_verified: boolean
  confidence_ceiling: 'high' | 'medium' | 'low'
}

export async function performEnroll(
  ctx: EnrollContext,
  args: EnrollArgs,
): Promise<EnrollOutput> {
  // Generate a fresh challenge client-side. The /v1/enroll endpoint accepts
  // any unique idempotency_key — the WebAuthn challenge is bound by being
  // included in the clientDataJSON the server validates against the
  // attestation. (No /v1/challenges call needed.)
  const challenge = randomBytes(32)

  const cred = await webauthnCreate({
    config: ctx.config,
    userHandle: args.userHandle,
    challenge,
    requirePlatformAuthenticator: false,  // Allow security-key fallback by default
    signal: args.signal,
  })

  const attestationObjectB64Url = bytesToBase64url(new Uint8Array(cred.attestationObject))
  const clientDataJsonB64Url = bytesToBase64url(new Uint8Array(cred.clientDataJSON))

  const parsed = parseAttestationFormat(attestationObjectB64Url)

  // The /v1/enroll endpoint extracts the public key from the attestation
  // object server-side. We pass an empty placeholder for `public_key` —
  // the server's WebAuthn validator overrides it with the COSE key it
  // extracts from authData. (See server/api/src/routes/enroll.ts: the
  // webauthn_attestation path overrides effectivePublicKey.)
  const idempotencyKey = `ek_${bytesToBase64url(randomBytes(16))}`
  const existing = await ctx.store.get(args.userHandle)
  const reuseDeviceToken = !args.forceNew ? existing?.deviceId : undefined

  const body: Record<string, unknown> = {
    idempotency_key: idempotencyKey,
    platform: 'web',
    reason: 'fresh_enrollment',
    public_key: '',  // overridden server-side from attestation; empty avoids dupe-key rejection
    attestation: {
      webauthn_attestation: {
        attestation_object: attestationObjectB64Url,
        client_data_json: clientDataJsonB64Url,
      },
    },
  }
  if (reuseDeviceToken) body['device_token'] = reuseDeviceToken

  let resp: EnrollServerResponse
  try {
    resp = await ctx.http.request<EnrollServerResponse>({
      method: 'POST',
      path: '/v1/enroll',
      body,
      signal: args.signal,
    })
  } catch (err) {
    if (err instanceof VouchflowError) throw err
    throw new VouchflowError({
      code: 'enrollment_failed',
      message: 'Server rejected enrollment',
      cause: err,
    })
  }

  const credential: CredentialRecord = {
    credentialId: cred.credentialId,
    enrolledAt: resp.enrolled_at,
    attestationLevel: parsed.attestationLevel,
    transports: cred.transports,
  }

  const next: DeviceRecord = existing && !args.forceNew
    ? {
        ...existing,
        deviceId: resp.device_token,
        configuredRpId: ctx.config.rpId,
        credentials: dedupeCredentials([...existing.credentials, credential]),
      }
    : {
        userHandle: args.userHandle,
        deviceId: resp.device_token,
        credentials: [credential],
        lastVerifiedAt: null,
        configuredRpId: ctx.config.rpId,
        schemaVersion: 1,
      }

  await ctx.store.put(next)
  return { device: next, credential }
}

function dedupeCredentials(creds: CredentialRecord[]): CredentialRecord[] {
  const seen = new Set<string>()
  const out: CredentialRecord[] = []
  for (const c of creds) {
    if (!seen.has(c.credentialId)) {
      seen.add(c.credentialId)
      out.push(c)
    }
  }
  return out
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

// Unused but exported so callers can stamp consistent base64-from-bytes
// without importing from encoding.ts directly.
export const _bytesToBase64 = bytesToBase64
