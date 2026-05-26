# @vouchflow/web

[![npm](https://img.shields.io/npm/v/@vouchflow/web.svg)](https://www.npmjs.com/package/@vouchflow/web)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@vouchflow/web.svg?label=gzipped)](https://bundlephobia.com/package/@vouchflow/web)
[![types](https://img.shields.io/npm/types/@vouchflow/web.svg)](https://www.npmjs.com/package/@vouchflow/web)
[![license](https://img.shields.io/npm/l/@vouchflow/web.svg)](./LICENSE)

Passkey-backed device verification and high-assurance payload signing for browsers. Mirrors the [Vouchflow iOS](https://github.com/vouchflow/ios-sdk) and [Android](https://github.com/vouchflow/android-sdk) SDKs and adds web-specific extensions for arbitrary payload signing — a primitive the mobile SDKs do not expose.

- Zero runtime dependencies for the core
- TypeScript-first; full types ship in the package
- 6.8 KB gzipped UMD, 9 KB ESM
- React entry point at `@vouchflow/web/react` (opt-in)
- Compatible with strict CSP — no `eval`, no inline scripts

## Install

```sh
npm install @vouchflow/web
```

Or via UMD from jsDelivr — `Vouchflow` attaches to `window`:

```html
<script src="https://cdn.jsdelivr.net/npm/@vouchflow/web/dist/umd/vouchflow.min.js"></script>
```

## Quick start

```ts
import { Vouchflow } from '@vouchflow/web'

Vouchflow.configure({
  apiKey: 'vsk_sandbox_…',
  environment: 'sandbox',
  rpId: 'app.example.com',  // must match current origin's registrable domain
  rpName: 'Example',
})

const result = await Vouchflow.shared.verify({
  context: 'login',
  userHandle: 'user_abc',
  minConfidence: 'medium',
})

// result.verified      — true
// result.confidence    — 'high' | 'medium' | 'low'
// result.deviceToken   — pass to your server for reputation queries
// result.sessionId     — matches webhook session_id
```

Enrollment is automatic on first `verify()`. Call `enroll({ userHandle, forceNew: true })` only when you need to add a backup credential.

## High-assurance payload signing

`signPayload()` produces a Vouchflow-attested JWS over any JSON-serializable payload — useful for mandate signing, approval signing, or any flow where you need a server-verifiable signed envelope.

```ts
import { Vouchflow, type SignResult } from '@vouchflow/web'

const signed: SignResult = await Vouchflow.shared.signPayload({
  context: 'mandate_signing',
  payload: { v: 1, id: 'mand_abc', scope: 'send', amount: 500 },
  userHandle: 'user_abc',
  minConfidence: 'high',  // default for signPayload
})

await fetch('/api/mandates', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    mandate: signed.payload,      // canonicalized JSON the user signed
    assertion: signed.assertion,  // Vouchflow-signed JWS
  }),
})
```

### Server-side verification (Node.js)

Verify the JWS against Vouchflow's published JWKS — no WebAuthn knowledge required.

```ts
import { jwtVerify, createRemoteJWKSet } from 'jose'
import crypto from 'node:crypto'

const JWKS = createRemoteJWKSet(
  new URL('https://api.vouchflow.dev/.well-known/jwks.json'),
)

export async function verifyVouchflowAssertion(
  assertion: string,
  canonicalizedPayload: string,
  customerId: string,
) {
  const { payload } = await jwtVerify(assertion, JWKS, {
    issuer: 'https://vouchflow.dev',
    audience: customerId,
  })

  const expected = crypto
    .createHash('sha256')
    .update(canonicalizedPayload, 'utf8')
    .digest('hex')

  if (payload.payload_sha256 !== expected) {
    throw new Error('Payload hash mismatch — client sent different bytes than were signed')
  }

  return {
    confidence: payload.confidence as 'high' | 'medium' | 'low',
    deviceToken: payload.device_token as string,
    signingDeviceId: payload.signing_device_id as string,
    sessionId: payload.session_id as string,
  }
}
```

## React

`VouchflowProvider` configures the SDK once on mount. `useVerify` and `useSign` are thin wrappers around the core that expose loading state and the last result.

```tsx
import { VouchflowProvider, useVerify, useSign } from '@vouchflow/web/react'

export function App() {
  return (
    <VouchflowProvider config={{
      apiKey: 'vsk_sandbox_…',
      environment: 'sandbox',
      rpId: 'app.example.com',
      rpName: 'Example',
    }}>
      <SignInButton />
    </VouchflowProvider>
  )
}

function SignInButton() {
  const { verify, isVerifying } = useVerify()
  return (
    <button
      disabled={isVerifying}
      onClick={() => verify({ context: 'login', userHandle: 'user_abc' })}
    >
      {isVerifying ? 'Authenticating…' : 'Sign in with passkey'}
    </button>
  )
}
```

## Email fallback

When WebAuthn is unavailable, cancelled, or fails, request an email OTP. The session ID flows through the thrown error.

```ts
import { Vouchflow, VouchflowError } from '@vouchflow/web'

try {
  await Vouchflow.shared.verify({ context: 'signup', userHandle: 'user_abc' })
} catch (err) {
  if (
    err instanceof VouchflowError &&
    (err.code === 'biometric_cancelled' ||
     err.code === 'biometric_failed' ||
     err.code === 'webauthn_unavailable')
  ) {
    const fb = await Vouchflow.shared.requestFallback({
      sessionId: err.sessionId!,
      email: 'user@example.com',
      reason: 'biometric_failed',
    })
    const code = await promptUserForCode()
    const completed = await Vouchflow.shared.completeFallback({
      sessionId: fb.fallbackSessionId,
      code,
    })
    // completed.confidence === 'low'   ← always 'low' for email fallback
  }
}
```

Email OTP fallback **always** returns `confidence: 'low'`. It proves the user controls an inbox, not that a hardware-backed device is present.

## Capability detection

```ts
const support = await Vouchflow.shared.checkSupport()

if (!support.webauthn) showEmailOTPOnly()
else if (!support.platformAuthenticator) showSecurityKeyAndEmailOptions()
else showPasskeyButton()
```

`support.webauthn`, `support.platformAuthenticator`, `support.userVerifyingAuthenticator`, `support.conditionalUI`, `support.attestation` (`'available' | 'unsupported'`), `support.recommendedFallback` (`'email' | 'none'`).

## Error handling

All errors are instances of `VouchflowError` with a discriminated `code` field. Switch on `err.code`, not on subclass.

| Code | Recommended action |
| --- | --- |
| `invalid_config` | Fix at init (most often an rpId mismatch with the current origin) |
| `not_configured` | Call `Vouchflow.configure()` before `Vouchflow.shared` |
| `not_in_browser` | Don't call `verify()`/`signPayload()` from Node / SSR |
| `webauthn_unavailable` | Offer email fallback |
| `platform_authenticator_unavailable` | Offer security-key or email fallback |
| `biometric_cancelled` | Offer retry; `err.sessionId` is set |
| `biometric_failed` | Offer fallback using `err.sessionId` |
| `concurrent_ceremony` | Another tab is mid-verify; WebAuthn is exclusive per origin |
| `enrollment_failed` | Usually transient — retry |
| `invalid_signature` | Clear state and re-enroll |
| `challenge_expired` | Retry; SDK normally fires within ms |
| `challenge_already_used` | Atomic guard tripped — retry from scratch |
| `device_not_found` | Local state stale — `forget()` and re-enroll |
| `minimum_confidence_unmet` | Block or degrade; `err.actualConfidence` is set |
| `rate_limit_exceeded` | Back off and retry |
| `unauthorized` | Wrong API-key prefix or scope |
| `invalid_otp` | Re-prompt up to the lockout |
| `fallback_locked` | Surface a generic auth failure |
| `network_error` | `err.retryable === true` — back off |
| `aborted` | Caller asked for this via `AbortSignal` |
| `unknown_error` | Log `err.cause` |

## Browser support

| Browser | Minimum | Notes |
| --- | --- | --- |
| Chrome | 109+ | Full WebAuthn + conditional UI |
| Edge | 109+ | Chromium engine — same support |
| Safari | 16.4+ | iOS 16.4+ and macOS 13.3+ for full passkey support |
| Firefox | 119+ | WebAuthn mature; conditional UI lags Chromium |

WebAuthn refuses to run over `http://` outside `localhost`. Make sure staging and preview environments have valid TLS.

In Node.js / SSR, `verify()` and `signPayload()` throw `not_in_browser`. The package is import-safe in SSR — only the active call sites need a real browser.

## Bundle size

| Build | Size (gzipped) |
| --- | --- |
| UMD (`dist/umd/vouchflow.min.js`) | **6.8 KB** |
| ESM (`dist/index.js`) | **9 KB** (tree-shakeable) |
| React entry (`dist/react/index.js`) | +1.4 KB |

CI fails if either core bundle exceeds the configured budget.

## Spec

The full specification — including architectural rationale, IndexedDB schema, error mapping rules, and the WebAuthn ceremony details — lives at [`docs/spec.md`](./docs/spec.md). Customer-facing docs are at [vouchflow.dev/docs/web-sdk](https://vouchflow.dev/docs/web-sdk).

## Contributing

Issues and PRs welcome at [github.com/vouchflow/web-sdk](https://github.com/vouchflow/web-sdk). Unit tests use Vitest with `fake-indexeddb`; integration tests use Playwright's virtual authenticator API. See `test/` for examples.

## License

Apache-2.0.
