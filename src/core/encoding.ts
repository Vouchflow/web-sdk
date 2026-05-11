// Base64 / base64url helpers. Browsers don't expose Buffer, so the SDK
// uses btoa/atob with manual padding stripping. We never depend on
// `Buffer` at runtime.

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    s += String.fromCharCode(bytes[i]!)
  }
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function bytesToBase64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function base64urlToBytes(b64url: string): Uint8Array {
  const pad = b64url.length % 4 === 0 ? '' : '='.repeat(4 - (b64url.length % 4))
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + pad
  return base64ToBytes(b64)
}

/** WebAuthn challenge bytes are base64url-encoded inside clientDataJSON; the
 *  server expects standard base64 (matching the iOS/Android contract). The
 *  SDK accepts the server's base64 challenge and converts to/from base64url
 *  only at the WebAuthn boundary. */
export function base64ToBase64url(b64: string): string {
  return b64.replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function base64urlToBase64(b64url: string): string {
  const pad = b64url.length % 4 === 0 ? '' : '='.repeat(4 - (b64url.length % 4))
  return b64url.replace(/-/g, '+').replace(/_/g, '/') + pad
}

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
