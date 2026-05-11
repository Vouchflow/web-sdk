import { describe, it, expect } from 'vitest'
import {
  base64ToBase64url,
  base64ToBytes,
  base64urlToBase64,
  base64urlToBytes,
  bytesToBase64,
  bytesToBase64url,
  utf8ToBytes,
  bytesToUtf8,
} from '../../src/core/encoding.js'

describe('base64 round-trips', () => {
  it('roundtrip of random bytes', () => {
    for (let i = 0; i < 10; i++) {
      const buf = new Uint8Array(64)
      crypto.getRandomValues(buf)
      expect(base64ToBytes(bytesToBase64(buf))).toEqual(buf)
    }
  })
  it('base64 ↔ base64url is reversible', () => {
    const buf = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xfe])
    const b64 = bytesToBase64(buf)
    const b64url = base64ToBase64url(b64)
    expect(base64urlToBase64(b64url)).toBe(b64)
    expect(base64urlToBytes(b64url)).toEqual(buf)
  })
})

describe('base64url', () => {
  it('strips padding', () => {
    expect(bytesToBase64url(new Uint8Array([1]))).toBe('AQ')
    expect(bytesToBase64url(new Uint8Array([1, 2]))).toBe('AQI')
  })
  it('uses - and _ instead of + and /', () => {
    expect(bytesToBase64url(new Uint8Array([0xfb]))).toBe('-w')
    expect(bytesToBase64url(new Uint8Array([0xff]))).toBe('_w')
  })
})

describe('utf8', () => {
  it('roundtrips ASCII', () => {
    const s = 'hello, world'
    expect(bytesToUtf8(utf8ToBytes(s))).toBe(s)
  })
  it('roundtrips multi-byte', () => {
    const s = '日本語 — emoji 🌟'
    expect(bytesToUtf8(utf8ToBytes(s))).toBe(s)
  })
})
