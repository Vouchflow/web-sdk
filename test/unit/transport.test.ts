import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createHttpClient } from '../../src/transport/http.js'
import { validateConfig } from '../../src/core/config.js'
import { VouchflowError } from '../../src/core/errors.js'

const BASE_CONFIG = validateConfig({
  apiKey: 'vsk_sandbox_test',
  environment: 'sandbox',
  rpId: 'test.local',
  rpName: 'Test',
  apiBaseUrl: 'https://api.test.local',
})

describe('createHttpClient: success path', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('attaches Authorization, Vouchflow-API-Version, content-type', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const http = createHttpClient(BASE_CONFIG)
    const r = await http.request<{ ok: boolean }>({ method: 'POST', path: '/v1/x', body: { y: 1 } })
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.test.local/v1/x')
    expect(init.method).toBe('POST')
    expect(init.headers['authorization']).toBe('Bearer vsk_sandbox_test')
    expect(init.headers['vouchflow-api-version']).toBeTruthy()
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ y: 1 })
  })

  it('skips authorization when authenticated=false', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const http = createHttpClient(BASE_CONFIG)
    await http.request({ method: 'GET', path: '/v1/.well-known/jwks.json', authenticated: false })
    const init = fetchMock.mock.calls[0]![1]
    expect(init.headers['authorization']).toBeUndefined()
  })

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const http = createHttpClient(BASE_CONFIG)
    expect(await http.request({ method: 'DELETE', path: '/v1/x' })).toBeUndefined()
  })
})

describe('createHttpClient: error mapping', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('401 → unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"code":"bad_key"}}', { status: 401 }))
    const http = createHttpClient(BASE_CONFIG)
    await expect(http.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('429 → rate_limit_exceeded after retries', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 429 }))
    const http = createHttpClient(BASE_CONFIG)
    await expect(http.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
      retryable: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('5xx retries 3 times then surfaces network_error', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }))
    const http = createHttpClient(BASE_CONFIG)
    await expect(http.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      code: 'network_error',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('maps device_not_found', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'device_not_found' } }), { status: 404 }),
    )
    const http = createHttpClient(BASE_CONFIG)
    await expect(http.request({ method: 'POST', path: '/v1/sign' })).rejects.toMatchObject({
      code: 'device_not_found',
    })
  })

  it('maps verification_impossible → minimum_confidence_unmet', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'verification_impossible' } }), { status: 422 }),
    )
    const http = createHttpClient(BASE_CONFIG)
    await expect(http.request({ method: 'POST', path: '/v1/verify' })).rejects.toMatchObject({
      code: 'minimum_confidence_unmet',
    })
  })

  it('AbortError surfaces as aborted', async () => {
    fetchMock.mockImplementationOnce(() => {
      throw new DOMException('cancelled', 'AbortError')
    })
    const http = createHttpClient(BASE_CONFIG)
    await expect(
      http.request({ method: 'GET', path: '/x', retry: false }),
    ).rejects.toMatchObject({ code: 'aborted' })
  })
})
