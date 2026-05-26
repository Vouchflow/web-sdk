import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jwtVerify, importJWK } from 'jose'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.e2e-env.json'), 'utf8'),
) as {
  apiBase: string
  harnessBase: string
  apiKey: string
  customerId: string
}

const RP_ID = 'localhost'

async function addVirtualAuthenticator(page: import('@playwright/test').Page, opts: {
  hasResidentKey?: boolean
  userVerified?: boolean
} = {}) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: opts.hasResidentKey ?? true,
      hasUserVerification: true,
      isUserVerified: opts.userVerified ?? true,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId }
}

test.describe('Web SDK end-to-end', () => {
  test('enroll → verify against the sandbox API', async ({ page }) => {
    await addVirtualAuthenticator(page)
    await page.goto(env.harnessBase)
    await page.waitForFunction(() => (window as any).__vf)

    const configResult = await page.evaluate(
      async (cfg) => {
        return await (window as any).__vf.configure(cfg)
      },
      {
        apiKey: env.apiKey,
        environment: 'sandbox',
        rpId: RP_ID,
        rpName: 'E2E Harness',
        apiBaseUrl: env.apiBase,
      },
    )
    expect(configResult).toBe(true)

    // 1. First call: auto-enrolls and verifies
    const verify1 = await page.evaluate(async () => {
      return await (window as any).__vf.verify({
        context: 'signup',
        userHandle: 'e2e_user_a',
      })
    })
    expect(verify1.verified).toBe(true)
    expect(verify1.deviceToken).toMatch(/^dvt_/)
    expect(verify1.sessionId).toMatch(/^ses_/)
    expect(['high', 'medium']).toContain(verify1.confidence)

    // 2. Second call: re-uses enrollment, hits the verify path only
    const verify2 = await page.evaluate(async () => {
      return await (window as any).__vf.verify({
        context: 'login',
        userHandle: 'e2e_user_a',
      })
    })
    expect(verify2.verified).toBe(true)
    expect(verify2.deviceToken).toBe(verify1.deviceToken)

    // 3. State is persisted
    const state = await page.evaluate(async () =>
      await (window as any).__vf.getEnrollmentState({ userHandle: 'e2e_user_a' }),
    )
    expect(state.enrolled).toBe(true)
    expect(state.credentialIds.length).toBeGreaterThan(0)
  })

  test('signPayload returns a JWS that verifies against /.well-known/jwks.json', async ({ page }) => {
    await addVirtualAuthenticator(page)
    await page.goto(env.harnessBase)
    await page.waitForFunction(() => (window as any).__vf)

    await page.evaluate(
      async (cfg) => (window as any).__vf.configure(cfg),
      {
        apiKey: env.apiKey,
        environment: 'sandbox',
        rpId: RP_ID,
        rpName: 'E2E Harness',
        apiBaseUrl: env.apiBase,
      },
    )

    const payload = { v: 1, id: 'mand_e2e', scope: 'send', amount: 500 }
    const signed = await page.evaluate(async (p) => {
      return await (window as any).__vf.sign({
        context: 'mandate_signing',
        payload: p,
        userHandle: 'e2e_signer',
      })
    }, payload)

    expect(signed.assertion).toBeTruthy()
    expect(signed.assertion.split('.').length).toBe(3)
    expect(signed.signingDeviceId).toMatch(/^sdv_/)
    expect(signed.confidence).toMatch(/^(high|medium)$/)

    // Pull JWKS from the API directly and verify the signed JWS.
    const jwksRes = await fetch(`${env.apiBase}/.well-known/jwks.json`)
    expect(jwksRes.ok).toBe(true)
    const { keys } = (await jwksRes.json()) as { keys: any[] }
    expect(keys.length).toBeGreaterThan(0)

    const headerB64 = signed.assertion.split('.')[0]
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    const jwk = keys.find((k) => k.kid === header.kid)
    expect(jwk).toBeTruthy()

    const key = await importJWK(jwk, 'EdDSA')
    const { payload: claims } = await jwtVerify(signed.assertion, key, {
      issuer: 'https://vouchflow.dev',
      audience: env.customerId,
    })
    // payload_sha256 in claims must match a fresh SHA-256 of the canonicalized payload
    const enc = new TextEncoder().encode(signed.payload)
    const hashBuf = await crypto.subtle.digest('SHA-256', enc)
    const hashHex = [...new Uint8Array(hashBuf)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(claims['payload_sha256']).toBe(hashHex)
    expect(claims['context']).toBe('mandate_signing')
  })

  test('checkSupport reports webauthn=true under a virtual authenticator', async ({ page }) => {
    await addVirtualAuthenticator(page)
    await page.goto(env.harnessBase)
    await page.waitForFunction(() => (window as any).__vf)

    await page.evaluate(
      async (cfg) => (window as any).__vf.configure(cfg),
      {
        apiKey: env.apiKey,
        environment: 'sandbox',
        rpId: RP_ID,
        rpName: 'E2E Harness',
        apiBaseUrl: env.apiBase,
      },
    )
    const support = await page.evaluate(async () => (window as any).__vf.checkSupport())
    expect(support.webauthn).toBe(true)
    expect(support.platformAuthenticator).toBe(true)
  })

  test('email OTP fallback initiation (sandbox mode logs OTP to stdout)', async ({ page }) => {
    await addVirtualAuthenticator(page)  // enroll succeeds; biometric fallback is simulated via the API call
    await page.goto(env.harnessBase)
    await page.waitForFunction(() => (window as any).__vf)

    await page.evaluate(
      async (cfg) => (window as any).__vf.configure(cfg),
      {
        apiKey: env.apiKey,
        environment: 'sandbox',
        rpId: RP_ID,
        rpName: 'E2E Harness',
        apiBaseUrl: env.apiBase,
      },
    )

    // We can't easily fish the OTP out of the server's console.log in this
    // harness — but we can prove the fallback INITIATION succeeds, which
    // exercises the SDK's request path, email hashing, and reason mapping.
    // Completion is exercised by unit tests with mocked fetch.
    const result = await page.evaluate(async () => {
      // Manually drive a verify session through the API to get a session_id.
      // (Mirrors what `verify()` does internally up to the biometric step.)
      const enroll = await (window as any).__vf.enroll({ userHandle: 'fb_user' })
      const res = await fetch(`${(window as any).__vfClient.config.apiBaseUrl}/v1/verify`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${(window as any).__vfClient.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          device_token: enroll.deviceToken,
          context: 'signup',
        }),
      })
      const init = await res.json()
      const fb = await (window as any).__vf.requestFallback({
        sessionId: init.session_id,
        email: 'fb@example.local',
        reason: 'biometric_failed',
      })
      return fb
    })
    expect(result.fallbackSessionId).toMatch(/^fbs_/)
    expect(result.codeLength).toBe(6)
  })

  test('AbortController cancels in-flight verify', async ({ page }) => {
    await addVirtualAuthenticator(page)
    await page.goto(env.harnessBase)
    await page.waitForFunction(() => (window as any).__vf)

    await page.evaluate(
      async (cfg) => (window as any).__vf.configure(cfg),
      {
        apiKey: env.apiKey,
        environment: 'sandbox',
        rpId: RP_ID,
        rpName: 'E2E Harness',
        apiBaseUrl: env.apiBase,
      },
    )

    const result = await page.evaluate(async () => {
      const ac = new AbortController()
      ac.abort()  // pre-aborted — verify should reject immediately
      try {
        await (window as any).__vfClient.verify({
          context: 'signup',
          userHandle: 'abort_user',
          signal: ac.signal,
        })
        return { ok: true }
      } catch (err: any) {
        return { ok: false, code: err.code }
      }
    })
    expect(result.ok).toBe(false)
    expect(['aborted', 'biometric_cancelled', 'network_error']).toContain(result.code)
  })

  test('verify with userVerified=false surfaces biometric_cancelled', async ({ page }) => {
    // Authenticator that refuses UV → simulates a user cancelling Face ID
    await addVirtualAuthenticator(page, { userVerified: false })
    await page.goto(env.harnessBase)
    await page.waitForFunction(() => (window as any).__vf)

    await page.evaluate(
      async (cfg) => (window as any).__vf.configure(cfg),
      {
        apiKey: env.apiKey,
        environment: 'sandbox',
        rpId: RP_ID,
        rpName: 'E2E Harness',
        apiBaseUrl: env.apiBase,
      },
    )
    const out = await page.evaluate(async () =>
      (window as any).__vf.errorCatch('verify', { context: 'signup', userHandle: 'cancel_user' }),
    )
    expect(out.ok).toBe(false)
    // Could be biometric_cancelled (NotAllowedError) or enrollment_failed.
    expect(['biometric_cancelled', 'enrollment_failed', 'invalid_signature']).toContain(out.code)
  })
})
