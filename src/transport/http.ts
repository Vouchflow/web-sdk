import { ResolvedConfig } from '../core/config.js'
import { VouchflowError, VouchflowErrorCode } from '../core/errors.js'

export interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

/** Translate a server error.code string to a VouchflowErrorCode. Server
 *  codes that don't map cleanly become `unknown_error` so callers always
 *  see a typed code (the original message is preserved on `.message`). */
function mapServerCode(serverCode: string | undefined, status: number): VouchflowErrorCode {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limit_exceeded'
  if (status >= 500) return 'network_error'
  switch (serverCode) {
    case 'device_not_found':
    case 'device_not_owned':
    case 'device_token_mismatch':
      return 'device_not_found'
    case 'verification_impossible':
      return 'minimum_confidence_unmet'
    case 'invalid_signature':
      return 'invalid_signature'
    case 'session_expired':
      return 'challenge_expired'
    case 'challenge_already_consumed':
      return 'challenge_already_used'
    case 'invalid_otp':
      return 'invalid_otp'
    case 'fallback_locked':
      return 'fallback_locked'
    case 'enrollment_failed':
    case 'public_key_already_registered':
      return 'enrollment_failed'
    default:
      return 'unknown_error'
  }
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  signal?: AbortSignal
  retry?: boolean
  /** Set to false for endpoints that don't need auth (jwks). */
  authenticated?: boolean
  /** Idempotency key for replay-safe POSTs. */
  idempotencyKey?: string
}

export interface HttpClient {
  request<T>(opts: RequestOptions): Promise<T>
}

/** Create an HTTP client bound to a ResolvedConfig. Handles auth headers,
 *  API version pinning, retry-with-backoff for transient failures, and
 *  uniform error mapping into VouchflowError. */
export function createHttpClient(config: ResolvedConfig): HttpClient {
  return {
    async request<T>(opts: RequestOptions): Promise<T> {
      const url = `${config.apiBaseUrl}${opts.path}`
      const headers: Record<string, string> = {
        'accept': 'application/json',
        'vouchflow-api-version': config.apiVersion,
      }
      if (opts.authenticated !== false) {
        headers['authorization'] = `Bearer ${config.apiKey}`
      }
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json'
      }
      if (opts.idempotencyKey) {
        // Server expects idempotency_key in the body for /v1/enroll, but we
        // pass it as a header too for any future endpoints that adopt the
        // pattern. The body field is set explicitly by callers that need it.
        headers['idempotency-key'] = opts.idempotencyKey
      }

      const maxAttempts = opts.retry === false ? 1 : 3
      let lastErr: VouchflowError | undefined
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const res = await fetch(url, {
            method: opts.method,
            headers,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: opts.signal,
          })

          if (res.ok) {
            // 204 returns nothing.
            if (res.status === 204) return undefined as unknown as T
            return (await res.json()) as T
          }

          let serverError: ApiErrorBody = {}
          try {
            serverError = (await res.json()) as ApiErrorBody
          } catch {
            // Non-JSON body — fall through with empty serverError.
          }
          const code = mapServerCode(serverError.error?.code, res.status)
          const ve = new VouchflowError({
            code,
            message: serverError.error?.message ?? `HTTP ${res.status}`,
            retryable: res.status >= 500 || res.status === 429,
          })
          // 5xx and 429 are retryable. Everything else is terminal.
          if (res.status >= 500 || res.status === 429) {
            lastErr = ve
            if (attempt < maxAttempts - 1) await sleep(backoffDelay(attempt), opts.signal)
            continue
          }
          throw ve
        } catch (err) {
          if (err instanceof VouchflowError) throw err
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw new VouchflowError({ code: 'aborted', message: 'Request aborted', cause: err })
          }
          // TypeError typically means network failure (DNS, refused, offline).
          lastErr = new VouchflowError({
            code: 'network_error',
            message: err instanceof Error ? err.message : String(err),
            retryable: true,
            cause: err,
          })
          if (attempt < maxAttempts - 1) await sleep(backoffDelay(attempt), opts.signal)
        }
      }
      throw lastErr ?? new VouchflowError({ code: 'network_error', message: 'Request failed' })
    },
  }
}

function backoffDelay(attempt: number): number {
  // Exponential backoff with jitter — 200ms, 400ms, 800ms ± 50%.
  const base = 200 * 2 ** attempt
  return base * (0.5 + Math.random())
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new VouchflowError({ code: 'aborted', message: 'Request aborted' }))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new VouchflowError({ code: 'aborted', message: 'Request aborted' }))
      },
      { once: true },
    )
  })
}
