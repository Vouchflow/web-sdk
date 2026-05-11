import { describe, it, expect } from 'vitest'
import { parseAttestationFormat } from '../../src/core/attestation.js'
import { bytesToBase64url } from '../../src/core/encoding.js'

// Build a minimal CBOR attestation object: { fmt: <text>, attStmt: <map>, authData: <bytes> }
// Just enough to exercise the format-detection branches in attestation.ts.

function cborTextString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s)
  if (utf8.length < 24) {
    return concat(new Uint8Array([0x60 | utf8.length]), utf8)
  }
  return concat(new Uint8Array([0x78, utf8.length]), utf8)
}

function cborByteString(bs: Uint8Array): Uint8Array {
  if (bs.length < 24) return concat(new Uint8Array([0x40 | bs.length]), bs)
  if (bs.length < 256) return concat(new Uint8Array([0x58, bs.length]), bs)
  const lenBytes = new Uint8Array([(bs.length >> 8) & 0xff, bs.length & 0xff])
  return concat(new Uint8Array([0x59]), lenBytes, bs)
}

function cborMap(entries: Array<[string, Uint8Array]>): Uint8Array {
  if (entries.length >= 24) throw new Error('not implemented')
  let out: Uint8Array = new Uint8Array([0xa0 | entries.length])
  for (const [k, v] of entries) {
    out = concat(out, cborTextString(k), v)
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

function buildAttObj(fmt: string, withStmt: boolean): string {
  const attStmt = withStmt
    ? cborMap([['x5c', cborByteString(new Uint8Array([1, 2, 3]))]])
    : cborMap([])
  const authData = cborByteString(new Uint8Array(64).fill(0))
  const obj = cborMap([
    ['fmt', cborTextString(fmt)],
    ['attStmt', attStmt],
    ['authData', authData],
  ])
  return bytesToBase64url(obj)
}

describe('parseAttestationFormat', () => {
  it('apple → hardware', () => {
    const r = parseAttestationFormat(buildAttObj('apple', true))
    expect(r.format).toBe('apple')
    expect(r.attestationLevel).toBe('hardware')
  })
  it('tpm → hardware', () => {
    expect(parseAttestationFormat(buildAttObj('tpm', true)).attestationLevel).toBe('hardware')
  })
  it('packed with statement → hardware', () => {
    expect(parseAttestationFormat(buildAttObj('packed', true)).attestationLevel).toBe('hardware')
  })
  it('packed without statement → software (self-attestation)', () => {
    expect(parseAttestationFormat(buildAttObj('packed', false)).attestationLevel).toBe('software')
  })
  it('none → none', () => {
    expect(parseAttestationFormat(buildAttObj('none', false)).attestationLevel).toBe('none')
  })
  it('garbage input falls back to none', () => {
    const r = parseAttestationFormat('not-cbor')
    expect(r.format).toBe('unknown')
    expect(r.attestationLevel).toBe('none')
  })
})
