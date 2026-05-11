import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { performRequestFallback, performCompleteFallback } from '../../src/fallback/email-otp.js'
import { createIndexedDBStateStore } from '../../src/core/state-store.js'
import { validateConfig } from '../../src/core/config.js'
import { createHttpClient } from '../../src/transport/http.js'

const config = validateConfig({
  apiKey: 'vsk_sandbox_test',
  environment: 'sandbox',
  rpId: 'test.local',
  rpName: 'T',
  apiBaseUrl: 'https://api.test.local',
})

describe('email OTP fallback', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let store: ReturnType<typeof createIndexedDBStateStore>

  beforeEach(async () => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    store = createIndexedDBStateStore()
    await store.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('hashes the email client-side and posts to /v1/verify/:sid/fallback', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fallback_session_id: 'fbs_xyz',
          method: 'email_otp',
          expires_at: '2026-05-10T15:00:00Z',
          session_state: 'FALLBACK',
        }),
        { status: 200 },
      ),
    )
    const http = createHttpClient(config)
    const ctx = { config, http, store }
    const result = await performRequestFallback(ctx, {
      sessionId: 'ses_abc',
      email: 'User@Example.COM',  // mixed case + leading/trailing spaces handled
      reason: 'biometric_failed',
    })
    expect(result.fallbackSessionId).toBe('fbs_xyz')
    expect(result.codeLength).toBe(6)

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body)
    expect(body.email).toBe('User@Example.COM')
    // SHA-256 of "user@example.com" (lowercased, trimmed)
    expect(body.email_hash).toBe(
      'b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514',
    )
    expect(body.reason).toBe('biometric_failed')
    expect(init.method).toBe('POST')
  })

  it('completes OTP', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ verified: true, confidence: 'low', session_state: 'FALLBACK_COMPLETE' }),
        { status: 200 },
      ),
    )
    const http = createHttpClient(config)
    const ctx = { config, http, store }
    const result = await performCompleteFallback(ctx, { sessionId: 'fbs_xyz', code: '123456' })
    expect(result.verified).toBe(true)
    expect(result.confidence).toBe('low')
  })

  it('throws invalid_otp when server says not verified', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ verified: false }), { status: 200 }),
    )
    const http = createHttpClient(config)
    const ctx = { config, http, store }
    await expect(
      performCompleteFallback(ctx, { sessionId: 'fbs_xyz', code: '999999' }),
    ).rejects.toMatchObject({ code: 'invalid_otp' })
  })

  it('attaches device_token from store when userHandle provided', async () => {
    await store.put({
      userHandle: 'u',
      deviceId: 'dvt_zzz',
      credentials: [
        {
          credentialId: 'cred',
          enrolledAt: '2026',
          attestationLevel: 'hardware',
          transports: [],
        },
      ],
      lastVerifiedAt: null,
      configuredRpId: 'test.local',
      schemaVersion: 1,
    })
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fallback_session_id: 'fbs_xyz',
          method: 'email_otp',
          expires_at: '2026-05-10T15:00:00Z',
          session_state: 'FALLBACK',
        }),
        { status: 200 },
      ),
    )
    const http = createHttpClient(config)
    await performRequestFallback({ config, http, store }, {
      sessionId: 'ses_abc',
      email: 'a@b.com',
      reason: 'biometric_failed',
    }, 'u')
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.device_token).toBe('dvt_zzz')
  })
})
