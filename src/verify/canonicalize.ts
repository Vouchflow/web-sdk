// RFC 8785 — JSON Canonicalization Scheme (JCS).
//
// We need byte-for-byte deterministic serialization so that the SHA-256 the
// server stores at /v1/sign matches the SHA-256 a verifier recomputes from
// the canonicalized payload returned in the SignResult. JSON.stringify is
// not sufficient: object key order is implementation-defined and JCS
// mandates lexicographic UTF-16 code unit ordering of keys.
//
// JCS also mandates a specific number serialization (ECMAScript ToString
// minus a few trims) and forbids NaN/Infinity. The implementation below
// covers the JCS subset that customer payloads exercise — JSON-typed
// values (no `undefined`, no functions, no symbols).

export function canonicalize(value: unknown): string {
  return serialize(value)
}

function serialize(v: unknown): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number':
      return serializeNumber(v)
    case 'string':
      return serializeString(v)
    case 'object':
      if (Array.isArray(v)) return serializeArray(v)
      return serializeObject(v as Record<string, unknown>)
    default:
      throw new TypeError(`Cannot canonicalize value of type ${typeof v}`)
  }
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError('JCS forbids NaN and Infinity')
  }
  if (n === 0) return '0'
  // ECMAScript ToString already produces the shortest round-trip
  // representation for IEEE 754 doubles. JCS §3.2.2.3 prescribes this
  // output verbatim, with `e+` notation lowercase. JSON.stringify
  // matches.
  return JSON.stringify(n)
}

// JCS §3.2.2.2: strings are serialized per JSON spec but with a fixed
// escape table covering control characters, \", and \\. JSON.stringify
// already follows this escape table for valid Unicode strings — we don't
// need a custom serializer.
function serializeString(s: string): string {
  return JSON.stringify(s)
}

function serializeArray(arr: unknown[]): string {
  if (arr.length === 0) return '[]'
  const parts = arr.map((item) => serialize(item))
  return `[${parts.join(',')}]`
}

function serializeObject(obj: Record<string, unknown>): string {
  // JCS §3.2.3: sort keys by UTF-16 code units (the order the JS engine
  // gives us when comparing strings with `<`).
  const keys: string[] = []
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) {
      keys.push(k)
    }
  }
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (keys.length === 0) return '{}'
  const parts = keys.map((k) => `${serializeString(k)}:${serialize(obj[k])}`)
  return `{${parts.join(',')}}`
}
