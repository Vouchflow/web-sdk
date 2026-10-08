import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vouchflow } from '../../src/core/client.js'
import { VouchflowError } from '../../src/core/errors.js'
import { DeviceRecord, StateStore } from '../../src/core/state-store.js'
import { HttpClient } from '../../src/transport/http.js'

vi.mock('../../src/core/attestation.js', () => ({
  parseAttestationFormat: () => ({ attestationLevel: 'hardware' }),
}))

const CONFIG = {
  apiKey: 'vsk_sandbox_test',
  environment: 'sandbox' as const,
  rpId: 'test.local',
  rpName: 'T',
}

function buffer(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value)
  const result = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(result).set(bytes)
  return result
}

function assertion(userHandle: ArrayBuffer | null = buffer('__default__')): PublicKeyCredential {
  return {
    rawId: buffer('credential'),
    response: {
      clientDataJSON: buffer('client-data'),
      authenticatorData: buffer('auth-data'),
      signature: buffer('signature'),
      userHandle,
    },
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential
}

function attestation(): PublicKeyCredential {
  return {
    rawId: buffer('new-credential'),
    response: {
      attestationObject: buffer('attestation'),
      clientDataJSON: buffer('client-data'),
      getTransports: () => [],
    },
  } as unknown as PublicKeyCredential
}

function memoryStore(): StateStore & { records: Map<string, DeviceRecord> } {
  const records = new Map<string, DeviceRecord>()
  const meta = new Map<string, string>()
  return {
    records,
    get: async (key) => records.get(key) ?? null,
    put: async (record) => { records.set(record.userHandle, record) },
    delete: async (key) => { records.delete(key) },
    clear: async () => { records.clear(); meta.clear() },
    getMeta: async (key) => meta.get(key) ?? null,
    setMeta: async (key, value) => { meta.set(key, value) },
  }
}

function transport() {
  const request = vi.fn(async (opts: { path: string }) => {
    switch (opts.path) {
      case '/v1/device/recover/initiate':
        return { session_id: 'rec_1', challenge: btoa('challenge'), expires_at: '2026-10-07' }
      case '/v1/device/recover/complete':
        return { device_token: 'dvt_existing', credential_id: 'Y3JlZGVudGlhbA' }
      case '/v1/enroll':
        return { device_token: 'dvt_new', enrolled_at: '2026-10-07', status: 'active' }
      case '/v1/sign':
        return { session_id: 'sign_1', challenge: btoa('sign-challenge'), expires_at: '2026-10-07' }
      case '/v1/sign/sign_1/complete':
        return {
          verified: true,
          confidence: 'high',
          device_token: 'dvt_existing',
          signing_device_id: 'sdv_1',
          signed_at: '2026-10-07',
          assertion: 'signed-jws',
          session_id: 'sign_1',
        }
      case '/v1/verify':
        return { session_id: 'verify_1', challenge: btoa('verify-challenge'), expires_at: '2026-10-07' }
      case '/v1/verify/verify_1/complete':
        return {
          verified: true,
          confidence: 'medium',
          device_token: 'dvt_existing',
          device_age_days: 1,
          signals: {
            keychain_persistent: true,
            biometric_used: true,
            cross_app_history: false,
            anomaly_flags: [],
            attestation_verified: true,
          },
        }
      default:
        throw new Error(`Unexpected request: ${opts.path}`)
    }
  })
  return { request } as unknown as HttpClient & { request: typeof request }
}

describe('passkey device recovery', () => {
  let get: ReturnType<typeof vi.fn>
  let create: ReturnType<typeof vi.fn>

  beforeEach(() => {
    Vouchflow._reset()
    get = vi.fn().mockResolvedValue(assertion())
    create = vi.fn().mockResolvedValue(attestation())
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('navigator', { credentials: { get, create } })
  })

  afterEach(() => {
    Vouchflow._reset()
    vi.unstubAllGlobals()
  })

  it('enrolls a fresh browser by recovering its passkey without creating one', async () => {
    const store = memoryStore()
    const http = transport()
    const client = Vouchflow.configure(CONFIG, { store, http })

    await expect(client.enroll({})).resolves.toEqual({ deviceToken: 'dvt_existing' })

    expect(create).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(1)
    const request = get.mock.calls[0]![0].publicKey
    expect(request.rpId).toBe('test.local')
    expect(request.userVerification).toBe('required')
    expect(request.allowCredentials).toEqual([])
    expect(new Uint8Array(request.challenge)).toEqual(new Uint8Array(buffer('challenge')))
    expect(store.records.get('__default__')).toMatchObject({
      deviceId: 'dvt_existing',
      credentials: [{ credentialId: 'Y3JlZGVudGlhbA' }],
    })
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/v1/device/recover/complete',
      body: expect.objectContaining({
        session_id: 'rec_1',
        credential_id: 'Y3JlZGVudGlhbA',
        client_data_json: btoa('client-data'),
        authenticator_data: btoa('auth-data'),
        signed_challenge: btoa('signature'),
      }),
    }))
  })

  it('does not create a credential when recovery is cancelled or finds no passkey', async () => {
    get.mockRejectedValue(new DOMException('No passkey', 'NotAllowedError'))
    const store = memoryStore()
    const http = transport()
    const client = Vouchflow.configure(CONFIG, { store, http })

    await expect(client.enroll({})).rejects.toMatchObject({
      code: 'passkey_recovery_required',
      reason: 'not_found_or_cancelled',
    })

    expect(create).not.toHaveBeenCalled()
    expect(http.request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: '/v1/device/recover/complete',
    }))
  })

  it('forceNew creates a credential and excludes locally known IDs', async () => {
    const store = memoryStore()
    await store.put({
      userHandle: '__default__',
      deviceId: 'dvt_existing',
      credentials: [{ credentialId: 'Y3JlZGVudGlhbA', enrolledAt: '2026', attestationLevel: 'hardware', transports: [] }],
      lastVerifiedAt: null,
      configuredRpId: 'test.local',
      schemaVersion: 1,
    })
    const http = transport()
    const client = Vouchflow.configure(CONFIG, { store, http })

    await expect(client.enroll({ forceNew: true })).resolves.toEqual({ deviceToken: 'dvt_new' })

    expect(get).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    const excluded = create.mock.calls[0]![0].publicKey.excludeCredentials
    expect(excluded).toHaveLength(1)
    expect(new Uint8Array(excluded[0].id)).toEqual(new Uint8Array(buffer('credential')))
  })

  it('signPayload restores a missing record before signing', async () => {
    const store = memoryStore()
    const http = transport()
    const client = Vouchflow.configure(CONFIG, { store, http })

    const result = await client.signPayload({ context: 'payment', payload: { amount: 100 } })

    expect(result.deviceToken).toBe('dvt_existing')
    expect(create).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(2)
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/v1/sign',
      body: expect.objectContaining({ device_token: 'dvt_existing' }),
    }))
  })

  it('verify restores a missing record before verifying', async () => {
    const store = memoryStore()
    const http = transport()
    const client = Vouchflow.configure(CONFIG, { store, http })

    const result = await client.verify({ context: 'login' })

    expect(result.deviceToken).toBe('dvt_existing')
    expect(create).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(2)
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/v1/verify',
      body: expect.objectContaining({ device_token: 'dvt_existing' }),
    }))
  })

  it('recovers under the requested local handle and sends the assertion user handle', async () => {
    get.mockResolvedValue(assertion(buffer('app-user')))
    const store = memoryStore()
    const http = transport()
    const client = Vouchflow.configure(CONFIG, { store, http })

    await expect(client.recover({ userHandle: 'app-user' })).resolves.toEqual({ deviceToken: 'dvt_existing' })

    expect(store.records.get('app-user')?.deviceId).toBe('dvt_existing')
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
      path: '/v1/device/recover/complete',
      body: expect.objectContaining({ user_handle: btoa('app-user') }),
    }))
    expect(create).not.toHaveBeenCalled()
  })

  it('returns null for an unregistered passkey and does not create one', async () => {
    const store = memoryStore()
    const http = transport()
    const baseRequest = http.request.getMockImplementation()!
    http.request.mockImplementation(async (opts) => {
      if (opts.path === '/v1/device/recover/complete') {
        throw new VouchflowError({ code: 'device_not_found' })
      }
      return baseRequest(opts)
    })
    const client = Vouchflow.configure(CONFIG, { store, http })

    await expect(client.recover()).resolves.toBeNull()
    expect(store.records.size).toBe(0)
    expect(create).not.toHaveBeenCalled()
  })

  it('returns null from recover when the browser has no passkey', async () => {
    get.mockRejectedValue(new DOMException('No passkey', 'NotAllowedError'))
    const http = transport()
    const client = Vouchflow.configure(CONFIG, { store: memoryStore(), http })

    await expect(client.recover()).resolves.toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(http.request).toHaveBeenCalledTimes(1)
  })

  it.each([null, buffer('another-user')])(
    'does not store a device with a missing or mismatched user handle',
    async (handle) => {
      get.mockResolvedValue(assertion(handle))
      const store = memoryStore()
      const http = transport()
      const client = Vouchflow.configure(CONFIG, { store, http })

      await expect(client.recover({ userHandle: 'app-user' })).resolves.toBeNull()
      expect(store.records.size).toBe(0)
      expect(http.request).not.toHaveBeenCalledWith(expect.objectContaining({
        path: '/v1/device/recover/complete',
      }))
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('refuses automatic creation after selecting another user’s passkey', async () => {
    get.mockResolvedValue(assertion(buffer('another-user')))
    const store = memoryStore()
    const http = transport()
    const client = Vouchflow.configure(CONFIG, { store, http })

    await expect(client.enroll({ userHandle: 'app-user' })).rejects.toMatchObject({
      code: 'passkey_recovery_required',
      reason: 'not_found_or_cancelled',
    })
    expect(store.records.size).toBe(0)
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['enroll', 'verify', 'signPayload'] as const)(
    '%s refuses automatic creation after an unmatched recovery',
    async (method) => {
      const store = memoryStore()
      const http = transport()
      const baseRequest = http.request.getMockImplementation()!
      http.request.mockImplementation(async (opts) => {
        if (opts.path === '/v1/device/recover/complete') {
          throw new VouchflowError({ code: 'device_not_found' })
        }
        return baseRequest(opts)
      })
      const client = Vouchflow.configure(CONFIG, { store, http })
      const call = method === 'enroll' ? client.enroll() : method === 'verify'
        ? client.verify({ context: 'login' })
        : client.signPayload({ context: 'payment', payload: { amount: 100 } })

      await expect(call).rejects.toMatchObject({
        code: 'passkey_recovery_required',
        reason: 'unregistered_passkey',
      })
      expect(store.records.size).toBe(0)
      expect(create).not.toHaveBeenCalled()
    },
  )

  it.each(['verify', 'signPayload'] as const)(
    '%s refuses automatic creation after an ambiguous picker result',
    async (method) => {
      get.mockRejectedValue(new DOMException('No passkey', 'NotAllowedError'))
      const client = Vouchflow.configure(CONFIG, { store: memoryStore(), http: transport() })
      const call = method === 'verify' ? client.verify({ context: 'login' })
        : client.signPayload({ context: 'payment', payload: { amount: 100 } })

      await expect(call).rejects.toMatchObject({
        code: 'passkey_recovery_required',
        reason: 'not_found_or_cancelled',
      })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('surfaces invalid signatures instead of enrolling', async () => {
    const http = transport()
    const baseRequest = http.request.getMockImplementation()!
    http.request.mockImplementation(async (opts) => {
      if (opts.path === '/v1/device/recover/complete') {
        throw new VouchflowError({ code: 'invalid_signature' })
      }
      return baseRequest(opts)
    })
    const client = Vouchflow.configure(CONFIG, { store: memoryStore(), http })

    await expect(client.enroll({})).rejects.toMatchObject({ code: 'invalid_signature' })
    expect(create).not.toHaveBeenCalled()
  })
})
