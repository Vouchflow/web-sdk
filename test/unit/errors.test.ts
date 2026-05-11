import { describe, it, expect } from 'vitest'
import { VouchflowError, mapDomException } from '../../src/core/errors.js'

describe('VouchflowError', () => {
  it('preserves code and message', () => {
    const e = new VouchflowError({ code: 'invalid_signature', message: 'nope' })
    expect(e.code).toBe('invalid_signature')
    expect(e.message).toBe('nope')
    expect(e instanceof Error).toBe(true)
    expect(e instanceof VouchflowError).toBe(true)
  })

  it('defaults message to code', () => {
    const e = new VouchflowError({ code: 'network_error' })
    expect(e.message).toBe('network_error')
  })

  it('captures sessionId for fallback wiring', () => {
    const e = new VouchflowError({ code: 'biometric_failed', sessionId: 'ses_x' })
    expect(e.sessionId).toBe('ses_x')
  })
})

describe('mapDomException', () => {
  function dom(name: string): DOMException {
    return new DOMException('synthetic', name)
  }
  it('NotAllowedError → biometric_cancelled', () => {
    const e = mapDomException(dom('NotAllowedError'), { sessionId: 'ses_y' })
    expect(e.code).toBe('biometric_cancelled')
    expect(e.sessionId).toBe('ses_y')
  })
  it('AbortError → aborted', () => {
    expect(mapDomException(dom('AbortError')).code).toBe('aborted')
  })
  it('NotSupportedError → webauthn_unavailable', () => {
    expect(mapDomException(dom('NotSupportedError')).code).toBe('webauthn_unavailable')
  })
  it('SecurityError → invalid_config', () => {
    expect(mapDomException(dom('SecurityError')).code).toBe('invalid_config')
  })
  it('InvalidStateError → enrollment_failed', () => {
    expect(mapDomException(dom('InvalidStateError')).code).toBe('enrollment_failed')
  })
  it('passes through VouchflowError untouched', () => {
    const original = new VouchflowError({ code: 'rate_limit_exceeded' })
    expect(mapDomException(original)).toBe(original)
  })
  it('plain Error → unknown_error', () => {
    expect(mapDomException(new Error('boom')).code).toBe('unknown_error')
  })
})
