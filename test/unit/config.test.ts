import { describe, it, expect } from 'vitest'
import { validateConfig, DEFAULT_API_BASE_URL, DEFAULT_API_VERSION } from '../../src/core/config.js'
import { VouchflowError } from '../../src/core/errors.js'

const valid = {
  apiKey: 'vsk_sandbox_abc',
  environment: 'sandbox' as const,
  rpId: 'app.example.com',
  rpName: 'Example',
}

describe('validateConfig: valid input', () => {
  it('accepts the canonical config', () => {
    const r = validateConfig(valid)
    expect(r.apiKey).toBe('vsk_sandbox_abc')
    expect(r.apiBaseUrl).toBe(DEFAULT_API_BASE_URL)
    expect(r.apiVersion).toBe(DEFAULT_API_VERSION)
  })
  it('accepts custom base URL and trims trailing slash', () => {
    const r = validateConfig({ ...valid, apiBaseUrl: 'https://api.test.local/' })
    expect(r.apiBaseUrl).toBe('https://api.test.local')
  })
  it('accepts custom apiVersion', () => {
    const r = validateConfig({ ...valid, apiVersion: '2027-01-01' })
    expect(r.apiVersion).toBe('2027-01-01')
  })
})

describe('validateConfig: errors', () => {
  it('rejects non-vsk apiKey', () => {
    expect(() => validateConfig({ ...valid, apiKey: 'sk_test' })).toThrow(VouchflowError)
  })
  it('rejects unknown environment', () => {
    expect(() => validateConfig({ ...valid, environment: 'staging' as any })).toThrow(VouchflowError)
  })
  it('rejects empty rpId', () => {
    expect(() => validateConfig({ ...valid, rpId: '' })).toThrow(VouchflowError)
  })
  it('rejects rpId with scheme', () => {
    expect(() => validateConfig({ ...valid, rpId: 'https://app.example.com' })).toThrow(VouchflowError)
  })
  it('rejects rpId with path', () => {
    expect(() => validateConfig({ ...valid, rpId: 'app.example.com/foo' })).toThrow(VouchflowError)
  })
  it('rejects empty rpName', () => {
    expect(() => validateConfig({ ...valid, rpName: '' })).toThrow(VouchflowError)
  })
  it('attaches code=invalid_config', () => {
    try {
      validateConfig({ ...valid, apiKey: 'bad' })
    } catch (e) {
      expect((e as VouchflowError).code).toBe('invalid_config')
    }
  })
})
