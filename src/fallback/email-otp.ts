import { ResolvedConfig } from '../core/config.js'
import { VouchflowError } from '../core/errors.js'
import { HttpClient } from '../transport/http.js'
import { utf8ToBytes, bytesToBase64url } from '../core/encoding.js'
import {
  CompleteFallbackOptions,
  CompleteFallbackResult,
  RequestFallbackOptions,
  RequestFallbackResult,
} from '../types.js'
import { StateStore } from '../core/state-store.js'

export interface FallbackContext {
  config: ResolvedConfig
  http: HttpClient
  store: StateStore
}

interface InitiateResponse {
  fallback_session_id: string
  method: string
  expires_at: string
  session_state: string
}

interface CompleteResponse {
  verified: boolean
  confidence: 'low'
  session_state: string
}

/** SHA-256 of a UTF-8 string, returned as lowercase hex.
 *  Uses Web Crypto SubtleCrypto.digest — available in all WebAuthn-capable
 *  browsers (and Node >= 16 via globalThis.crypto.subtle). */
async function sha256Hex(input: string): Promise<string> {
  const data = utf8ToBytes(input)
  // Copy into a fresh ArrayBuffer to satisfy stricter BufferSource typing.
  const ab = new ArrayBuffer(data.byteLength)
  new Uint8Array(ab).set(data)
  const buf = await crypto.subtle.digest('SHA-256', ab)
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

const REASON_MAP: Record<string, string> = {
  biometric_failed: 'biometric_failed',
  webauthn_unavailable: 'biometric_unavailable',
  user_chose_email: 'developer_initiated',
}

export async function performRequestFallback(
  ctx: FallbackContext,
  args: RequestFallbackOptions,
  /** Optional userHandle so we can attach the device_token. */
  userHandle?: string,
): Promise<RequestFallbackResult> {
  if (!args.sessionId || !args.email) {
    throw new VouchflowError({
      code: 'invalid_config',
      message: 'sessionId and email are required',
    })
  }
  const emailHash = await sha256Hex(args.email.trim().toLowerCase())
  let deviceToken: string | undefined
  if (userHandle) {
    const dev = await ctx.store.get(userHandle)
    deviceToken = dev?.deviceId ?? undefined
  }

  const resp = await ctx.http.request<InitiateResponse>({
    method: 'POST',
    path: `/v1/verify/${args.sessionId}/fallback`,
    body: {
      device_token: deviceToken,
      email: args.email,
      email_hash: emailHash,
      reason: REASON_MAP[args.reason] ?? args.reason,
    },
    signal: args.signal,
  })

  return {
    fallbackSessionId: resp.fallback_session_id,
    expiresAt: resp.expires_at,
    codeLength: 6,
  }
}

export async function performCompleteFallback(
  ctx: FallbackContext,
  args: CompleteFallbackOptions,
  userHandle?: string,
): Promise<CompleteFallbackResult> {
  if (!args.sessionId || !args.code) {
    throw new VouchflowError({
      code: 'invalid_config',
      message: 'sessionId and code are required',
    })
  }
  let deviceToken: string | undefined
  if (userHandle) {
    const dev = await ctx.store.get(userHandle)
    deviceToken = dev?.deviceId ?? undefined
  }

  const resp = await ctx.http.request<CompleteResponse>({
    method: 'POST',
    path: `/v1/verify/${args.sessionId}/complete`,
    body: { device_token: deviceToken, otp: args.code },
    signal: args.signal,
  })

  if (!resp.verified) {
    throw new VouchflowError({
      code: 'invalid_otp',
      message: 'Server rejected OTP',
      sessionId: args.sessionId,
    })
  }

  return {
    verified: true,
    confidence: 'low',
    sessionId: args.sessionId,
  }
}

// Re-export so internal callers can build idempotency keys consistently.
export const _bytesToBase64url = bytesToBase64url
