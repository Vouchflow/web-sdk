import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vouchflow } from '../../src/index.js'

const CONFIG = {
  apiKey: 'vsk_sandbox_test',
  environment: 'sandbox' as const,
  rpId: 'test.local',
  rpName: 'T',
  apiBaseUrl: 'https://api.test.local',
}

function credential(extensionResults: AuthenticationExtensionsClientOutputs): PublicKeyCredential {
  const buffer = new ArrayBuffer(1)
  return {
    rawId: buffer,
    response: {
      authenticatorData: buffer,
      clientDataJSON: buffer,
      signature: buffer,
      userHandle: null,
    },
    getClientExtensionResults: () => extensionResults,
  } as unknown as PublicKeyCredential
}

function initResponse() {
  return new Response(
    JSON.stringify({
      session_id: 'ses_sign_1',
      // base64 (not base64url) — decoded via atob() in performSignPayload.
      challenge: btoa('challenge-bytes'),
      expires_at: '2026-05-10T15:00:00Z',
      payload_sha256: 'deadbeef',
    }),
    { status: 200 },
  )
}

function completeResponse() {
  return new Response(
    JSON.stringify({
      verified: true,
      confidence: 'high',
      device_token: 'dvt_signed',
      signing_device_id: 'sdv_1',
      signed_at: '2026-05-10T15:00:01Z',
      assertion: 'jws.bundle',
      session_id: 'ses_sign_1',
    }),
    { status: 200 },
  )
}

describe('signPayload + PRF single-ceremony', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let getMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    Vouchflow._reset()
    vi.stubGlobal('window', globalThis)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    Vouchflow._reset()
    vi.unstubAllGlobals()
  })

  async function seedDevice(client: ReturnType<typeof Vouchflow.configure>) {
    await client.store.put({
      userHandle: '__default__',
      deviceId: 'device',
      credentials: [
        { credentialId: 'Y3JlZA', enrolledAt: '2026', attestationLevel: 'hardware', transports: [] },
      ],
      lastVerifiedAt: null,
      configuredRpId: 'test.local',
      schemaVersion: 1,
    })
  }

  it('with prfSalt: returns prfResult AND the signature from a single credentials.get call', async () => {
    const prfBytes = new Uint8Array(32).fill(9)
    getMock = vi.fn().mockResolvedValue(
      credential({ prf: { results: { first: prfBytes.buffer } } } as any),
    )
    vi.stubGlobal('navigator', { credentials: { get: getMock } })
    fetchMock.mockResolvedValueOnce(initResponse()).mockResolvedValueOnce(completeResponse())

    const client = Vouchflow.configure(CONFIG)
    await seedDevice(client)

    const result = await client.signPayload({
      context: 'payment',
      payload: { amount: 100 },
      prfSalt: new Uint8Array(32).fill(1),
    })

    expect(getMock).toHaveBeenCalledTimes(1)
    expect(typeof result.signature).toBe('string')
    expect(result.assertion).toBe('jws.bundle')
    expect(result.prfResult).toEqual(prfBytes)

    // The PRF salt was requested as part of the SAME navigator.credentials.get
    // call that produced the signing assertion — one ceremony, not two.
    const publicKey = getMock.mock.calls[0]![0].publicKey
    expect(publicKey.extensions.prf.eval.first).toBeInstanceOf(ArrayBuffer)
  })

  it('without prfSalt: behaves exactly as before — no prfResult, no prf extension requested', async () => {
    getMock = vi.fn().mockResolvedValue(credential({} as any))
    vi.stubGlobal('navigator', { credentials: { get: getMock } })
    fetchMock.mockResolvedValueOnce(initResponse()).mockResolvedValueOnce(completeResponse())

    const client = Vouchflow.configure(CONFIG)
    await seedDevice(client)

    const result = await client.signPayload({
      context: 'payment',
      payload: { amount: 100 },
    })

    expect(getMock).toHaveBeenCalledTimes(1)
    expect(result.prfResult).toBeUndefined()

    const publicKey = getMock.mock.calls[0]![0].publicKey
    expect(publicKey.extensions).toBeUndefined()
  })
})
