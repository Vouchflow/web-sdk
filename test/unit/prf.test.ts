import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vouchflow } from '../../src/index.js'
import { webauthnCreate } from '../../src/enroll/webauthn-create.js'

const CONFIG = {
  apiKey: 'vsk_sandbox_test',
  environment: 'sandbox' as const,
  rpId: 'test.local',
  rpName: 'T',
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

describe('WebAuthn PRF', () => {
  beforeEach(() => {
    Vouchflow._reset()
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    Vouchflow._reset()
    vi.unstubAllGlobals()
  })

  it('returns PRF result bytes', async () => {
    const result = new Uint8Array(32).fill(7)
    const get = vi.fn().mockResolvedValue(
      credential({ prf: { results: { first: result.buffer } } } as any),
    )
    vi.stubGlobal('navigator', { credentials: { get } })
    const client = Vouchflow.configure(CONFIG)
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

    await expect(client.evaluatePrf({ salt: new Uint8Array(32) })).resolves.toEqual(result)
    expect(get.mock.calls[0]![0].publicKey.challenge).toHaveProperty('byteLength', 32)
  })

  it('throws prf_unsupported when no PRF result is returned', async () => {
    vi.stubGlobal('navigator', {
      credentials: { get: vi.fn().mockResolvedValue(credential({})) },
    })
    const client = Vouchflow.configure(CONFIG)

    await expect(client.evaluatePrf({ salt: new Uint8Array(32) })).rejects.toMatchObject({
      code: 'prf_unsupported',
    })
  })

  it('requests PRF support during enrollment', async () => {
    const create = vi.fn().mockResolvedValue({
      rawId: new ArrayBuffer(1),
      response: {
        attestationObject: new ArrayBuffer(1),
        clientDataJSON: new ArrayBuffer(1),
        getTransports: () => [],
      },
    })
    vi.stubGlobal('navigator', { credentials: { create } })
    const client = Vouchflow.configure(CONFIG)

    await webauthnCreate({
      config: client.config,
      userHandle: 'user',
      challenge: new Uint8Array(32),
    })

    expect(create.mock.calls[0]![0].publicKey.extensions).toEqual({
      credProps: true,
      prf: {},
    })
  })
})
