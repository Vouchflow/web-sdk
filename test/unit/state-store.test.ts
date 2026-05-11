import { describe, it, expect, beforeEach } from 'vitest'
import { createIndexedDBStateStore, DeviceRecord } from '../../src/core/state-store.js'

const sample = (overrides: Partial<DeviceRecord> = {}): DeviceRecord => ({
  userHandle: 'user_abc',
  deviceId: 'dvt_001',
  credentials: [
    {
      credentialId: 'cred_aa',
      enrolledAt: '2026-05-01T12:00:00Z',
      attestationLevel: 'hardware',
      transports: ['internal'],
    },
  ],
  lastVerifiedAt: null,
  configuredRpId: 'app.example.com',
  schemaVersion: 1,
  ...overrides,
})

describe('IndexedDB state store', () => {
  let store: ReturnType<typeof createIndexedDBStateStore>

  beforeEach(async () => {
    // fake-indexeddb stays around between tests in the same process; clear()
    // ensures isolation.
    store = createIndexedDBStateStore()
    await store.clear()
  })

  it('returns null for unknown user', async () => {
    expect(await store.get('nope')).toBeNull()
  })

  it('round-trips put → get', async () => {
    const r = sample()
    await store.put(r)
    expect(await store.get(r.userHandle)).toEqual(r)
  })

  it('overwrites on put with same key', async () => {
    await store.put(sample({ deviceId: 'dvt_001' }))
    await store.put(sample({ deviceId: 'dvt_002' }))
    const got = await store.get('user_abc')
    expect(got?.deviceId).toBe('dvt_002')
  })

  it('isolates users', async () => {
    await store.put(sample({ userHandle: 'a', deviceId: 'dvt_a' }))
    await store.put(sample({ userHandle: 'b', deviceId: 'dvt_b' }))
    expect((await store.get('a'))?.deviceId).toBe('dvt_a')
    expect((await store.get('b'))?.deviceId).toBe('dvt_b')
  })

  it('delete removes only target user', async () => {
    await store.put(sample({ userHandle: 'a' }))
    await store.put(sample({ userHandle: 'b' }))
    await store.delete('a')
    expect(await store.get('a')).toBeNull()
    expect(await store.get('b')).toBeTruthy()
  })

  it('clear wipes everything', async () => {
    await store.put(sample({ userHandle: 'a' }))
    await store.put(sample({ userHandle: 'b' }))
    await store.clear()
    expect(await store.get('a')).toBeNull()
    expect(await store.get('b')).toBeNull()
  })

  it('meta key/value persists', async () => {
    await store.setMeta('apiKeyFingerprint', 'abc123')
    expect(await store.getMeta('apiKeyFingerprint')).toBe('abc123')
    expect(await store.getMeta('missing')).toBeNull()
  })
})
