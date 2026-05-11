// Vitest setup — wires fake-indexeddb and a minimal Web Crypto polyfill
// shim so the same code that runs in browsers can be exercised under Node.
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'

if (!(globalThis as any).crypto) {
  ;(globalThis as any).crypto = webcrypto
}

// btoa/atob aren't on globalThis in older Node — Node 18+ has them.
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64')
}
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (s: string) => Buffer.from(s, 'base64').toString('binary')
}
