import { ResolvedConfig } from '../core/config.js'
import { mapDomException, VouchflowError } from '../core/errors.js'
import { base64urlToBytes } from '../core/encoding.js'

export interface GetOptions {
  config: ResolvedConfig
  challenge: Uint8Array
  /** WebAuthn `allowCredentials` IDs (base64url). Empty array → discoverable creds only. */
  credentialIds: string[]
  signal?: AbortSignal
  /** When true, sets mediation: "conditional" for passkey autofill. */
  conditional?: boolean
}

export interface GetResult {
  credentialId: string  // base64url
  authenticatorData: ArrayBuffer
  clientDataJSON: ArrayBuffer
  signature: ArrayBuffer
  userHandle: ArrayBuffer | null
}

export async function webauthnGet(opts: GetOptions): Promise<GetResult> {
  if (typeof window === 'undefined' || !window.navigator?.credentials?.get) {
    throw new VouchflowError({
      code: 'webauthn_unavailable',
      message: 'navigator.credentials.get is not available',
    })
  }

  const allowCredentials: PublicKeyCredentialDescriptor[] = opts.credentialIds.map((id) => ({
    type: 'public-key',
    id: toArrayBuffer(base64urlToBytes(id)),
    transports: ['internal', 'hybrid', 'usb', 'nfc', 'ble'] as AuthenticatorTransport[],
  }))

  const publicKey: PublicKeyCredentialRequestOptions = {
    rpId: opts.config.rpId,
    challenge: toArrayBuffer(opts.challenge),
    allowCredentials,
    userVerification: 'required',
    timeout: 60_000,
  }

  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.get({
      publicKey,
      signal: opts.signal,
      mediation: opts.conditional ? 'conditional' : undefined,
    })) as PublicKeyCredential | null
  } catch (err) {
    throw mapDomException(err)
  }

  if (!cred) {
    throw new VouchflowError({
      code: 'biometric_failed',
      message: 'navigator.credentials.get returned null',
    })
  }

  const response = cred.response as AuthenticatorAssertionResponse
  return {
    credentialId: bufferToBase64url(cred.rawId),
    authenticatorData: response.authenticatorData,
    clientDataJSON: response.clientDataJSON,
    signature: response.signature,
    userHandle: response.userHandle,
  }
}

function bufferToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength)
  new Uint8Array(out).set(view)
  return out
}
