import { describe, it, expect } from 'vitest'
import { canonicalize } from '../../src/verify/canonicalize.js'

// RFC 8785 vectors. The only thing that matters about JCS is byte-for-byte
// determinism — if our canonical output drifts from the spec the server's
// payload_sha256 won't match what verifiers recompute, and signed payloads
// become uncheckable.

describe('canonicalize: primitives', () => {
  it('null', () => expect(canonicalize(null)).toBe('null'))
  it('boolean true', () => expect(canonicalize(true)).toBe('true'))
  it('boolean false', () => expect(canonicalize(false)).toBe('false'))
  it('positive integer', () => expect(canonicalize(123)).toBe('123'))
  it('negative integer', () => expect(canonicalize(-7)).toBe('-7'))
  it('zero', () => expect(canonicalize(0)).toBe('0'))
  it('simple string', () => expect(canonicalize('hello')).toBe('"hello"'))
  it('string with quote', () => expect(canonicalize('a"b')).toBe('"a\\"b"'))
  it('string with newline', () => expect(canonicalize('a\nb')).toBe('"a\\nb"'))
})

describe('canonicalize: collections', () => {
  it('empty array', () => expect(canonicalize([])).toBe('[]'))
  it('empty object', () => expect(canonicalize({})).toBe('{}'))
  it('array preserves order', () =>
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]'))
  it('object keys sorted by UTF-16 code units', () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
  })
  it('nested object key sort recursive', () => {
    expect(canonicalize({ z: { b: 1, a: 2 }, a: 1 })).toBe(
      '{"a":1,"z":{"a":2,"b":1}}',
    )
  })
  it('drops undefined values from objects', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}')
  })
})

describe('canonicalize: invariants', () => {
  it('idempotent', () => {
    const obj = { z: [3, 1, 2], a: { y: false, x: null } }
    const out = canonicalize(obj)
    expect(canonicalize(JSON.parse(out))).toBe(out)
  })

  it('rejects NaN/Infinity', () => {
    expect(() => canonicalize(NaN)).toThrow()
    expect(() => canonicalize(Infinity)).toThrow()
    expect(() => canonicalize(-Infinity)).toThrow()
  })

  it('different orderings produce identical output', () => {
    const a = { name: 'mandate', amount: 100, scope: 'send' }
    const b = { scope: 'send', amount: 100, name: 'mandate' }
    expect(canonicalize(a)).toBe(canonicalize(b))
  })

  it('mandate-like payload', () => {
    const payload = {
      v: 1,
      id: 'mand_abc',
      grants: [{ asset: 'usd', max: 500 }, { asset: 'eth', max: 0.5 }],
      expires_at: '2026-12-31T00:00:00Z',
    }
    const got = canonicalize(payload)
    // Keys at every level sorted; arrays preserve order
    expect(got).toBe(
      '{"expires_at":"2026-12-31T00:00:00Z","grants":[{"asset":"usd","max":500},{"asset":"eth","max":0.5}],"id":"mand_abc","v":1}',
    )
  })
})
