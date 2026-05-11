import { base64urlToBytes } from './encoding.js'
import { AttestationLevel } from '../types.js'

// Best-effort browser-side parse of the WebAuthn attestation object to
// surface an attestation level (hardware / software / none) the SDK can
// store for later debugging and confidence-tier display. The authoritative
// attestation verification happens server-side in
// `server/api/src/services/webauthn.ts`. We intentionally don't validate
// signatures here — that's not the SDK's job.

export interface ParsedAttestation {
  format: string
  attestationLevel: AttestationLevel
  hasAttestationStatement: boolean
}

/** Decode the first byte of CBOR (RFC 8949 §3) to identify a map and length.
 *  We only need to extract the `fmt` field — the deeper structure is the
 *  server's problem. */
export function parseAttestationFormat(attestationObjectBase64Url: string): ParsedAttestation {
  try {
    const bytes = base64urlToBytes(attestationObjectBase64Url)
    const decoded = decodeCborTopLevelMap(bytes)
    const fmt = typeof decoded['fmt'] === 'string' ? (decoded['fmt'] as string) : 'unknown'
    const hasAttStmt =
      typeof decoded['attStmt'] === 'object' &&
      decoded['attStmt'] !== null &&
      Object.keys(decoded['attStmt'] as object).length > 0

    let attestationLevel: AttestationLevel = 'none'
    if (fmt === 'apple' || fmt === 'tpm' || fmt === 'android-key') {
      attestationLevel = 'hardware'
    } else if (fmt === 'packed') {
      attestationLevel = hasAttStmt ? 'hardware' : 'software'
    } else if (fmt === 'android-safetynet' || fmt === 'fido-u2f') {
      attestationLevel = 'software'
    } else if (fmt === 'none') {
      attestationLevel = 'none'
    }
    return { format: fmt, attestationLevel, hasAttestationStatement: hasAttStmt }
  } catch {
    return { format: 'unknown', attestationLevel: 'none', hasAttestationStatement: false }
  }
}

// ── Minimal CBOR decoder, just enough to read the top-level map keys ────────

interface DecodeState { offset: number; bytes: Uint8Array }

function decodeCborTopLevelMap(bytes: Uint8Array): Record<string, unknown> {
  const state: DecodeState = { offset: 0, bytes }
  const v = decodeItem(state)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('top-level CBOR is not a map')
  }
  return v as Record<string, unknown>
}

function decodeItem(state: DecodeState): unknown {
  const byte = state.bytes[state.offset++]!
  const major = byte >> 5
  const minor = byte & 0x1f
  const len = decodeLength(minor, state)
  switch (major) {
    case 0: return len  // unsigned int
    case 1: return -1 - len
    case 2: {
      const bs = state.bytes.subarray(state.offset, state.offset + len)
      state.offset += len
      return bs
    }
    case 3: {
      const bs = state.bytes.subarray(state.offset, state.offset + len)
      state.offset += len
      return new TextDecoder().decode(bs)
    }
    case 4: {
      const arr: unknown[] = []
      for (let i = 0; i < len; i++) arr.push(decodeItem(state))
      return arr
    }
    case 5: {
      const obj: Record<string | number, unknown> = {}
      for (let i = 0; i < len; i++) {
        const k = decodeItem(state)
        const v = decodeItem(state)
        obj[String(k)] = v
      }
      return obj
    }
    case 7:
      // Simple values: false=20, true=21, null=22, undefined=23
      if (minor === 20) return false
      if (minor === 21) return true
      if (minor === 22) return null
      return null
    default:
      throw new Error(`Unsupported CBOR major type ${major}`)
  }
}

function decodeLength(minor: number, state: DecodeState): number {
  if (minor < 24) return minor
  if (minor === 24) return state.bytes[state.offset++]!
  if (minor === 25) {
    const v = (state.bytes[state.offset]! << 8) | state.bytes[state.offset + 1]!
    state.offset += 2
    return v
  }
  if (minor === 26) {
    const v =
      state.bytes[state.offset]! * 0x1000000 +
      state.bytes[state.offset + 1]! * 0x10000 +
      state.bytes[state.offset + 2]! * 0x100 +
      state.bytes[state.offset + 3]!
    state.offset += 4
    return v
  }
  throw new Error(`Unsupported CBOR length encoding ${minor}`)
}
