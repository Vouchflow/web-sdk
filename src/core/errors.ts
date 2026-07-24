// Single error class with discriminated codes (per spec §8). Catching one
// type and switching on `.code` is the documented pattern.

export type VouchflowErrorCode =
  // Configuration
  | 'invalid_config'
  | 'not_configured'
  | 'not_in_browser'
  // Browser capability
  | 'webauthn_unavailable'
  | 'platform_authenticator_unavailable'
  | 'prf_unsupported'
  // User interaction
  | 'biometric_cancelled'
  | 'biometric_failed'
  | 'concurrent_ceremony'
  // Server-side
  | 'enrollment_failed'
  | 'invalid_signature'
  | 'challenge_expired'
  | 'challenge_already_used'
  | 'device_not_found'
  | 'minimum_confidence_unmet'
  | 'rate_limit_exceeded'
  | 'unauthorized'
  | 'invalid_otp'
  | 'fallback_locked'
  // Transport
  | 'network_error'
  | 'aborted'
  // Unknown
  | 'unknown_error'

export interface VouchflowErrorOptions {
  code: VouchflowErrorCode
  message?: string
  sessionId?: string
  email?: string
  actualConfidence?: 'high' | 'medium' | 'low'
  retryable?: boolean
  cause?: unknown
}

export class VouchflowError extends Error {
  readonly code: VouchflowErrorCode
  readonly sessionId?: string
  readonly email?: string
  readonly actualConfidence?: 'high' | 'medium' | 'low'
  readonly retryable: boolean
  declare readonly cause?: unknown

  constructor(opts: VouchflowErrorOptions) {
    super(opts.message ?? opts.code)
    this.name = 'VouchflowError'
    this.code = opts.code
    this.sessionId = opts.sessionId
    this.email = opts.email
    this.actualConfidence = opts.actualConfidence
    this.retryable = opts.retryable ?? false
    this.cause = opts.cause
    // Restore prototype chain for `instanceof` across realms.
    Object.setPrototypeOf(this, VouchflowError.prototype)
  }
}

/** Map a thrown DOMException from navigator.credentials.* into a VouchflowError. */
export function mapDomException(
  err: unknown,
  ctx: { sessionId?: string } = {},
): VouchflowError {
  if (err instanceof VouchflowError) return err
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        // WebAuthn collapses both user-cancel and timeout into NotAllowedError.
        // We can't tell them apart from the platform — surface as cancelled
        // and let callers retry; "failed" is reserved for downstream ceremonies
        // that actually completed but were rejected by the server.
        return new VouchflowError({
          code: 'biometric_cancelled',
          message: 'WebAuthn ceremony was cancelled or timed out.',
          sessionId: ctx.sessionId,
          cause: err,
        })
      case 'AbortError':
        return new VouchflowError({
          code: 'aborted',
          message: 'WebAuthn ceremony was aborted by the caller.',
          cause: err,
        })
      case 'NotSupportedError':
        return new VouchflowError({
          code: 'webauthn_unavailable',
          message: 'WebAuthn is not supported in this browser.',
          cause: err,
        })
      case 'SecurityError':
        return new VouchflowError({
          code: 'invalid_config',
          message: 'WebAuthn rejected the relying party — check rpId matches the current origin.',
          cause: err,
        })
      case 'InvalidStateError':
        return new VouchflowError({
          code: 'enrollment_failed',
          message: 'A credential for this user already exists on this authenticator.',
          cause: err,
        })
      default:
        return new VouchflowError({
          code: 'unknown_error',
          message: `WebAuthn DOMException: ${err.name}`,
          cause: err,
        })
    }
  }
  if (err instanceof Error) {
    return new VouchflowError({
      code: 'unknown_error',
      message: err.message,
      cause: err,
    })
  }
  return new VouchflowError({ code: 'unknown_error', message: String(err), cause: err })
}
