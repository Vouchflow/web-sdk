// Public type surface for @vouchflow/web. Types only — zero runtime cost.
//
// Mental model: the SDK mirrors the iOS/Android surface where possible, with
// web-specific extensions (signPayload, conditional UI) where the platform
// affords more.

export type Environment = 'sandbox' | 'production'
export type Confidence = 'high' | 'medium' | 'low'
export type AttestationLevel = 'hardware' | 'software' | 'none'

export interface VouchflowConfig {
  /** Vouchflow API key (`vsk_sandbox_…` or `vsk_live_…`). */
  apiKey: string
  /** Sandbox isolates from production — required, never inferred from key prefix. */
  environment: Environment
  /** WebAuthn relying party ID. Must equal current origin's registrable domain or a subdomain. */
  rpId: string
  /** Display name shown in the WebAuthn ceremony UI. */
  rpName: string
  /** Override the default `https://api.vouchflow.dev` base URL. */
  apiBaseUrl?: string
  /** `Vouchflow-API-Version` header value. Defaults to a known-good date. */
  apiVersion?: string
}

export interface VerifyOptions {
  context: string
  /** WebAuthn user handle. Required for multi-user-per-device support. */
  userHandle?: string
  /** Reject if the device cannot reach this confidence level. Default `medium`. */
  minConfidence?: Confidence
  /** Cancel the in-flight WebAuthn ceremony. */
  signal?: AbortSignal
}

export interface VerifySignals {
  keychainPersistent: boolean
  anomalyFlags: string[]
  deviceAgeDays: number
  crossAppHistory: boolean
  attestationVerified: boolean
}

export interface VerifyResult {
  verified: true
  confidence: Confidence
  deviceToken: string
  sessionId: string
  biometricUsed: boolean
  signals: VerifySignals
}

export interface SignOptions {
  context: string
  /** Anything JSON-serializable. Canonicalized via RFC 8785 JCS before signing. */
  payload: unknown
  userHandle?: string
  /** Default `high` for signPayload — payload signing is high-assurance by default. */
  minConfidence?: Confidence
  signal?: AbortSignal
}

export interface SignResult {
  /** The canonicalized JSON string that was signed. */
  payload: string
  /** WebAuthn raw signature, base64url. Customers can verify via the JWS instead. */
  signature: string
  /** WebAuthn signature algorithm. */
  algorithm: 'ES256' | 'RS256' | 'EdDSA' | string
  deviceToken: string
  /** Stable per-credential identifier, prefixed `sdv_`. */
  signingDeviceId: string
  signedAt: string
  confidence: Confidence
  /** JWS bundle signed by Vouchflow — what customers verify against `/.well-known/jwks.json`. */
  assertion: string
  sessionId: string
}

export type FallbackReason =
  | 'biometric_failed'
  | 'webauthn_unavailable'
  | 'user_chose_email'

export interface RequestFallbackOptions {
  sessionId: string
  email: string
  reason: FallbackReason
}

export interface RequestFallbackResult {
  fallbackSessionId: string
  expiresAt: string
  codeLength: 6
}

export interface CompleteFallbackOptions {
  sessionId: string
  code: string
}

export interface CompleteFallbackResult {
  verified: true
  confidence: 'low'
  sessionId: string
}

export interface CapabilitySupport {
  webauthn: boolean
  platformAuthenticator: boolean
  userVerifyingAuthenticator: boolean
  conditionalUI: boolean
  attestation: 'available' | 'unsupported'
  recommendedFallback: 'email' | 'none'
}

export interface EnrollmentState {
  enrolled: boolean
  deviceId: string | null
  credentialIds: string[]
  lastVerifiedAt: string | null
}

export interface EnrollOptions {
  userHandle: string
  /** Force a fresh credential even if one already exists. */
  forceNew?: boolean
}

export interface ForgetOptions {
  userHandle: string
}

export interface VerifyConditionalOptions {
  signal?: AbortSignal
  onResult: (result: VerifyResult) => void
  onError?: (error: Error) => void
}
