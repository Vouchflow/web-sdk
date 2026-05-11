import {
  CapabilitySupport,
  CompleteFallbackOptions,
  CompleteFallbackResult,
  EnrollOptions,
  EnrollmentState,
  ForgetOptions,
  RequestFallbackOptions,
  RequestFallbackResult,
  SignOptions,
  SignResult,
  VerifyConditionalOptions,
  VerifyOptions,
  VerifyResult,
  VouchflowConfig,
} from '../types.js'
import { ResolvedConfig, validateConfig } from './config.js'
import { VouchflowError } from './errors.js'
import { createIndexedDBStateStore, StateStore } from './state-store.js'
import { createHttpClient, HttpClient } from '../transport/http.js'
import { performEnroll } from '../enroll/enroll.js'
import { performVerify } from '../verify/verify.js'
import { performSignPayload } from '../verify/sign.js'
import {
  performCompleteFallback,
  performRequestFallback,
} from '../fallback/email-otp.js'

const DEFAULT_USER_HANDLE = '__default__'
const CONCURRENT_CHANNEL = 'vouchflow:ceremony'
const ENV_FINGERPRINT_KEY = 'env_fingerprint'

/** SHA-256 hex of (environment + apiKey). When this changes (e.g., a dev
 *  swapped a sandbox key for a live key), we wipe local device state so
 *  the SDK doesn't keep posting sandbox device_tokens to production. */
async function computeEnvFingerprint(config: ResolvedConfig): Promise<string> {
  const data = new TextEncoder().encode(`${config.environment}:${config.apiKey}`)
  const ab = new ArrayBuffer(data.byteLength)
  new Uint8Array(ab).set(data)
  const buf = await crypto.subtle.digest('SHA-256', ab)
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

/** Internal singleton container so that `Vouchflow.shared` works the same
 *  way the iOS SDK's `Vouchflow.shared` does. */
class VouchflowClient {
  readonly config: ResolvedConfig
  readonly http: HttpClient
  readonly store: StateStore
  // Track local and remote (other tab) in-flight ceremonies separately so
  // a remote 'end' message doesn't release the local lock mid-flight.
  // Use a counter on the remote side — a flag would race if two remote
  // tabs overlapped.
  private localInFlight = false
  private remoteInFlight = 0
  private channel?: BroadcastChannel

  constructor(config: ResolvedConfig, deps?: { store?: StateStore; http?: HttpClient }) {
    this.config = config
    this.store = deps?.store ?? createIndexedDBStateStore()
    this.http = deps?.http ?? createHttpClient(config)
    // Fire-and-forget env fingerprint check. Anyone calling verify() before
    // this resolves still works — the store ops are awaited per-call.
    void this.ensureEnvFingerprint()
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CONCURRENT_CHANNEL)
        this.channel.onmessage = (event) => {
          if (event.data === 'start') this.remoteInFlight += 1
          if (event.data === 'end') this.remoteInFlight = Math.max(0, this.remoteInFlight - 1)
        }
      } catch {
        // BroadcastChannel may be unavailable in some embedded contexts.
      }
    }
  }

  private envFingerprintChecked = false
  private async ensureEnvFingerprint(): Promise<void> {
    if (this.envFingerprintChecked) return
    try {
      const current = await computeEnvFingerprint(this.config)
      const stored = await this.store.getMeta(ENV_FINGERPRINT_KEY)
      if (stored && stored !== current) {
        // Env switched — wipe stale device records before anything
        // talks to the API with the wrong fingerprint.
        await this.store.clear()
      }
      await this.store.setMeta(ENV_FINGERPRINT_KEY, current)
      this.envFingerprintChecked = true
    } catch {
      // If subtle.crypto is unavailable for any reason, the worst case is
      // we lose the wipe-on-env-switch behaviour; fail open rather than
      // breaking verify() entirely.
      this.envFingerprintChecked = true
    }
  }

  private async withCeremonyLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.localInFlight || this.remoteInFlight > 0) {
      throw new VouchflowError({
        code: 'concurrent_ceremony',
        message: 'Another WebAuthn ceremony is already in progress in this origin',
      })
    }
    this.localInFlight = true
    this.channel?.postMessage('start')
    try {
      return await fn()
    } finally {
      this.localInFlight = false
      this.channel?.postMessage('end')
    }
  }

  async verify(opts: VerifyOptions): Promise<VerifyResult> {
    requireBrowser()
    await this.ensureEnvFingerprint()
    return this.withCeremonyLock(() =>
      performVerify(
        { config: this.config, http: this.http, store: this.store },
        {
          context: opts.context,
          userHandle: opts.userHandle,
          minConfidence: opts.minConfidence,
          signal: opts.signal,
        },
      ),
    )
  }

  async signPayload(opts: SignOptions): Promise<SignResult> {
    requireBrowser()
    await this.ensureEnvFingerprint()
    return this.withCeremonyLock(() =>
      performSignPayload(
        { config: this.config, http: this.http, store: this.store },
        {
          context: opts.context,
          payload: opts.payload,
          userHandle: opts.userHandle,
          minConfidence: opts.minConfidence,
          signal: opts.signal,
        },
      ),
    )
  }

  async enroll(opts: EnrollOptions): Promise<{ deviceToken: string }> {
    requireBrowser()
    await this.ensureEnvFingerprint()
    const out = await this.withCeremonyLock(() =>
      performEnroll(
        { config: this.config, http: this.http, store: this.store },
        { userHandle: opts.userHandle, forceNew: opts.forceNew },
      ),
    )
    return { deviceToken: out.device.deviceId }
  }

  async requestFallback(opts: RequestFallbackOptions): Promise<RequestFallbackResult> {
    return performRequestFallback(
      { config: this.config, http: this.http, store: this.store },
      opts,
    )
  }

  async completeFallback(opts: CompleteFallbackOptions): Promise<CompleteFallbackResult> {
    return performCompleteFallback(
      { config: this.config, http: this.http, store: this.store },
      opts,
    )
  }

  async getEnrollmentState(opts: { userHandle?: string } = {}): Promise<EnrollmentState> {
    const userHandle = opts.userHandle ?? DEFAULT_USER_HANDLE
    const dev = await this.store.get(userHandle)
    if (!dev) {
      return { enrolled: false, deviceId: null, credentialIds: [], lastVerifiedAt: null }
    }
    return {
      enrolled: dev.credentials.length > 0,
      deviceId: dev.deviceId,
      credentialIds: dev.credentials.map((c) => c.credentialId),
      lastVerifiedAt: dev.lastVerifiedAt,
    }
  }

  async forget(opts: ForgetOptions): Promise<void> {
    await this.store.delete(opts.userHandle)
  }

  async forgetAll(): Promise<void> {
    await this.store.clear()
  }

  async checkSupport(): Promise<CapabilitySupport> {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      return {
        webauthn: false,
        platformAuthenticator: false,
        userVerifyingAuthenticator: false,
        conditionalUI: false,
        attestation: 'unsupported',
        recommendedFallback: 'email',
      }
    }
    const PKC = window.PublicKeyCredential
    const platformAuth = PKC.isUserVerifyingPlatformAuthenticatorAvailable
      ? await PKC.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false)
      : false
    const conditional = PKC.isConditionalMediationAvailable
      ? await PKC.isConditionalMediationAvailable().catch(() => false)
      : false
    return {
      webauthn: true,
      platformAuthenticator: Boolean(platformAuth),
      userVerifyingAuthenticator: Boolean(platformAuth),
      conditionalUI: Boolean(conditional),
      // Whether attestation actually returns useful data is browser/platform
      // dependent. We can't know without attempting a ceremony — report
      // available if WebAuthn is here at all. The server downgrades to
      // medium confidence when no attestation is present.
      attestation: 'available',
      recommendedFallback: platformAuth ? 'none' : 'email',
    }
  }

  /** Conditional UI / passkey autofill. **Deferred to v2** — the server-side
   *  discoverable-session contract is not yet implemented. Calling this in
   *  v1 throws `webauthn_unavailable` so applications can detect and fall
   *  back to a regular verify() button instead of getting a broken dropdown. */
  async verifyConditional(_opts: VerifyConditionalOptions): Promise<void> {
    throw new VouchflowError({
      code: 'webauthn_unavailable',
      message: 'Conditional UI / passkey autofill is not available in v1; deferred to v2.',
    })
  }
}

function requireBrowser(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    throw new VouchflowError({
      code: 'not_in_browser',
      message: 'This SDK requires a browser environment (window/navigator are required)',
    })
  }
}

// ── Shared singleton ────────────────────────────────────────────────────────

let _shared: VouchflowClient | undefined

export const Vouchflow = {
  /** Configures the SDK. Must be called once before `Vouchflow.shared`. */
  configure(config: VouchflowConfig, deps?: { store?: StateStore; http?: HttpClient }): VouchflowClient {
    const resolved = validateConfig(config)
    _shared = new VouchflowClient(resolved, deps)
    return _shared
  },

  /** The configured singleton. Throws `not_configured` until `configure` is called. */
  get shared(): VouchflowClient {
    if (!_shared) {
      throw new VouchflowError({
        code: 'not_configured',
        message: 'Call Vouchflow.configure(...) before using Vouchflow.shared',
      })
    }
    return _shared
  },

  /** Test/internal helper: clear the singleton so a different config can be loaded. */
  _reset(): void {
    _shared = undefined
  },
}

export type { VouchflowClient }
