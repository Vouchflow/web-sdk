import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Vouchflow } from '../../src/core/client.js'
import { VouchflowError } from '../../src/core/errors.js'

describe('Vouchflow singleton', () => {
  beforeEach(() => Vouchflow._reset())
  afterEach(() => Vouchflow._reset())

  it('throws not_configured when shared accessed first', () => {
    try {
      void Vouchflow.shared
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as VouchflowError).code).toBe('not_configured')
    }
  })

  it('configure returns the client', () => {
    const client = Vouchflow.configure({
      apiKey: 'vsk_sandbox_test',
      environment: 'sandbox',
      rpId: 'test.local',
      rpName: 'T',
    })
    expect(client).toBe(Vouchflow.shared)
  })

  it('rejects bad config', () => {
    expect(() =>
      Vouchflow.configure({
        apiKey: 'oops',
        environment: 'sandbox',
        rpId: 'test.local',
        rpName: 'T',
      }),
    ).toThrow(VouchflowError)
  })
})

describe('getEnrollmentState', () => {
  beforeEach(() => Vouchflow._reset())

  it('returns enrolled=false when nothing stored', async () => {
    const client = Vouchflow.configure({
      apiKey: 'vsk_sandbox_test',
      environment: 'sandbox',
      rpId: 'test.local',
      rpName: 'T',
    })
    await client.forgetAll()
    const state = await client.getEnrollmentState({ userHandle: 'user_unknown' })
    expect(state).toEqual({
      enrolled: false,
      deviceId: null,
      credentialIds: [],
      lastVerifiedAt: null,
    })
  })

  it('returns enrolled=true after writing a record', async () => {
    const client = Vouchflow.configure({
      apiKey: 'vsk_sandbox_test',
      environment: 'sandbox',
      rpId: 'test.local',
      rpName: 'T',
    })
    await client.store.put({
      userHandle: 'u',
      deviceId: 'dvt_001',
      credentials: [
        { credentialId: 'cred_a', enrolledAt: '2026', attestationLevel: 'hardware', transports: [] },
      ],
      lastVerifiedAt: '2026-05-01',
      configuredRpId: 'test.local',
      schemaVersion: 1,
    })
    const state = await client.getEnrollmentState({ userHandle: 'u' })
    expect(state.enrolled).toBe(true)
    expect(state.deviceId).toBe('dvt_001')
    expect(state.credentialIds).toEqual(['cred_a'])
  })
})
