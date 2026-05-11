import { ResolvedConfig } from '../core/config.js'
import { mapDomException, VouchflowError } from '../core/errors.js'
import { utf8ToBytes } from '../core/encoding.js'

export interface CreateOptions {
  config: ResolvedConfig
  userHandle: string
  challenge: Uint8Array
  /** When true, requires platform authenticator (Touch ID / Windows Hello). */
  requirePlatformAuthenticator?: boolean
  signal?: AbortSignal
}

export interface CreateResult {
  credentialId: string  // base64url
  rawId: ArrayBuffer
  attestationObject: ArrayBuffer
  clientDataJSON: ArrayBuffer
  publicKeyAlgorithm: number | undefined
  transports: string[]
}

export async function webauthnCreate(opts: CreateOptions): Promise<CreateResult> {
  if (typeof window === 'undefined' || !window.navigator?.credentials?.create) {
    throw new VouchflowError({
      code: 'webauthn_unavailable',
      message: 'navigator.credentials.create is not available',
    })
  }

  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: { id: opts.config.rpId, name: opts.config.rpName },
    user: {
      id: toArrayBuffer(utf8ToBytes(opts.userHandle)),
      name: opts.userHandle,
      displayName: opts.userHandle,
    },
    challenge: toArrayBuffer(opts.challenge),
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },    // ES256 (preferred — matches mobile)
      { type: 'public-key', alg: -257 },  // RS256
      { type: 'public-key', alg: -8 },    // EdDSA
    ],
    authenticatorSelection: {
      authenticatorAttachment: opts.requirePlatformAuthenticator ? 'platform' : undefined,
      residentKey: 'preferred',
      userVerification: 'required',
    },
    attestation: 'direct',
    extensions: { credProps: true },
    timeout: 60_000,
  }

  let cred: PublicKeyCredential
  try {
    cred = (await navigator.credentials.create({
      publicKey,
      signal: opts.signal,
    })) as PublicKeyCredential
  } catch (err) {
    throw mapDomException(err)
  }

  if (!cred) {
    throw new VouchflowError({
      code: 'enrollment_failed',
      message: 'navigator.credentials.create returned null',
    })
  }

  const response = cred.response as AuthenticatorAttestationResponse
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : []
  const algorithm =
    typeof response.getPublicKeyAlgorithm === 'function'
      ? response.getPublicKeyAlgorithm()
      : undefined

  return {
    credentialId: bufferToBase64url(cred.rawId),
    rawId: cred.rawId,
    attestationObject: response.attestationObject,
    clientDataJSON: response.clientDataJSON,
    publicKeyAlgorithm: algorithm,
    transports,
  }
}

function bufferToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  // Force a fresh ArrayBuffer copy so callers can't get the SharedArrayBuffer
  // edge case that DOM lib types now forbid.
  const out = new ArrayBuffer(view.byteLength)
  new Uint8Array(out).set(view)
  return out
}
