import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Vouchflow } from '../../src/core/client.js'
import { VouchflowError } from '../../src/core/errors.js'
import { createIndexedDBStateStore } from '../../src/core/state-store.js'

const SHARED_CFG = {
  apiKey: 'vsk_sandbox_aaaaaa',
  environment: 'sandbox' as const,
  rpId: 'test.local',
  rpName: 'T',
  apiBaseUrl: 'https://api.test.local',
}

describe('QA fix: env fingerprint clears stale device records on env switch', () => {
  beforeEach(() => Vouchflow._reset())
  afterEach(() => Vouchflow._reset())

  it('keeps records when fingerprint is the same', async () => {
    const store = createIndexedDBStateStore()
    await store.clear()
    const c1 = Vouchflow.configure(SHARED_CFG, { store })
    // Trigger fingerprint write by accessing public method
    await c1.getEnrollmentState({ userHandle: 'x' })
    await store.put({
      userHandle: 'persistent',
      deviceId: 'dvt_keep',
      credentials: [{ credentialId: 'cred', enrolledAt: '2026', attestationLevel: 'hardware', transports: [] }],
      lastVerifiedAt: null,
      configuredRpId: 'test.local',
      schemaVersion: 1,
    })

    Vouchflow._reset()
    const c2 = Vouchflow.configure(SHARED_CFG, { store })
    // Force the fingerprint check by calling a method that awaits ensureEnvFingerprint
    await c2.forget({ userHandle: '__noop__' })
    expect(await store.get('persistent')).not.toBeNull()
  })

  it('wipes records when fingerprint changes (sandbox → production)', async () => {
    const store = createIndexedDBStateStore()
    await store.clear()
    const c1 = Vouchflow.configure(SHARED_CFG, { store })
    await c1.getEnrollmentState({ userHandle: 'x' })
    await store.put({
      userHandle: 'will_be_wiped',
      deviceId: 'dvt_old',
      credentials: [{ credentialId: 'cred', enrolledAt: '2026', attestationLevel: 'hardware', transports: [] }],
      lastVerifiedAt: null,
      configuredRpId: 'test.local',
      schemaVersion: 1,
    })

    Vouchflow._reset()
    // Switch to a live key — different environment + different apiKey
    const c2 = Vouchflow.configure(
      { ...SHARED_CFG, environment: 'production', apiKey: 'vsk_live_zzz' },
      { store },
    )
    // verify() / enroll() / signPayload() all await ensureEnvFingerprint, but
    // they go to fetch — use a less invasive path. We hit the gating via a
    // public method that the constructor's fire-and-forget might not have
    // completed yet. Wait one microtask + a tick to let the void-promise resolve.
    await new Promise((r) => setTimeout(r, 50))
    // The constructor's fire-and-forget ensureEnvFingerprint should have run.
    expect(await store.get('will_be_wiped')).toBeNull()
    void c2  // suppress unused warning
  })
})

describe('QA fix: BroadcastChannel does not release local lock on remote end', () => {
  let handlers: Array<(e: MessageEvent) => void>
  let originalBC: any

  beforeEach(() => {
    handlers = []
    originalBC = (globalThis as any).BroadcastChannel
    ;(globalThis as any).BroadcastChannel = class FakeBC {
      onmessage: ((e: MessageEvent) => void) | null = null
      constructor() {
        handlers.push((e) => this.onmessage?.(e))
      }
      postMessage() {}
      close() {}
    }
    Vouchflow._reset()
  })

  afterEach(() => {
    ;(globalThis as any).BroadcastChannel = originalBC
    Vouchflow._reset()
    vi.unstubAllGlobals()
  })

  it('local lock survives spurious remote end events', async () => {
    // Polyfill the browser globals requireBrowser() checks for, then stub
    // fetch so verify() hangs awaiting the /v1/verify response.
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('navigator', { userAgent: 'test' })
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})) as unknown as typeof fetch)

    const store = createIndexedDBStateStore()
    await store.clear()
    const client = Vouchflow.configure(SHARED_CFG, { store })
    // Pre-populate so verify() skips enrollment and goes straight to /v1/verify.
    await store.put({
      userHandle: '__default__',
      deviceId: 'dvt_local',
      credentials: [{ credentialId: 'cred', enrolledAt: '2026', attestationLevel: 'hardware', transports: [] }],
      lastVerifiedAt: null,
      configuredRpId: 'test.local',
      schemaVersion: 1,
    })

    const _slow = client.verify({ context: 'login' }).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 30))  // let lock + fetch initiate

    // Simulate a remote tab emitting 'end' while we're mid-flight.
    handlers.forEach((h) => h({ data: 'end' } as MessageEvent))

    // Second verify call should still see the LOCAL lock as held.
    await expect(client.verify({ context: 'login' })).rejects.toMatchObject({
      code: 'concurrent_ceremony',
    })
    void _slow
  })

  it('rejects when a remote tab starts a ceremony first', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('navigator', { userAgent: 'test' })
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})) as unknown as typeof fetch)

    const client = Vouchflow.configure(SHARED_CFG)
    // Remote tab starts a ceremony first.
    handlers.forEach((h) => h({ data: 'start' } as MessageEvent))
    await expect(client.verify({ context: 'login' })).rejects.toMatchObject({
      code: 'concurrent_ceremony',
    })

    // And clears properly after the remote end.
    handlers.forEach((h) => h({ data: 'end' } as MessageEvent))
    // (verify() still won't complete because fetch hangs, but it should
    // PASS the lock check — i.e. throw an error from a deeper path or hang.)
    // We assert by waiting briefly without seeing concurrent_ceremony.
    const probe = client.verify({ context: 'login' }).catch((e: VouchflowError) => e.code)
    const winner = await Promise.race([
      probe,
      new Promise<'still-running'>((r) => setTimeout(() => r('still-running'), 100)),
    ])
    expect(winner).not.toBe('concurrent_ceremony')
  })
})

describe('QA fix: verifyConditional is explicitly v2', () => {
  beforeEach(() => Vouchflow._reset())
  afterEach(() => Vouchflow._reset())

  it('throws webauthn_unavailable rather than silently failing', async () => {
    const client = Vouchflow.configure(SHARED_CFG)
    await expect(
      client.verifyConditional({ onResult: () => {} }),
    ).rejects.toMatchObject({ code: 'webauthn_unavailable' })
  })
})
