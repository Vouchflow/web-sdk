import { VouchflowConfig } from '../types.js'
import { VouchflowError } from './errors.js'

export const DEFAULT_API_BASE_URL = 'https://api.vouchflow.dev'
export const DEFAULT_API_VERSION = '2026-04-01'

export interface ResolvedConfig {
  apiKey: string
  environment: 'sandbox' | 'production'
  rpId: string
  rpName: string
  apiBaseUrl: string
  apiVersion: string
}

/** Validate and normalise a VouchflowConfig. Throws VouchflowError.invalid_config
 *  on bad input. The validation happens at configure() time so callers see
 *  the failure immediately rather than at first verify(). */
export function validateConfig(config: VouchflowConfig): ResolvedConfig {
  if (!config || typeof config !== 'object') {
    throw new VouchflowError({ code: 'invalid_config', message: 'config must be an object' })
  }
  if (typeof config.apiKey !== 'string' || !config.apiKey.startsWith('vsk_')) {
    throw new VouchflowError({ code: 'invalid_config', message: 'apiKey must start with vsk_' })
  }
  if (config.environment !== 'sandbox' && config.environment !== 'production') {
    throw new VouchflowError({
      code: 'invalid_config',
      message: 'environment must be "sandbox" or "production"',
    })
  }
  if (typeof config.rpId !== 'string' || config.rpId.length === 0) {
    throw new VouchflowError({ code: 'invalid_config', message: 'rpId is required' })
  }
  if (typeof config.rpName !== 'string' || config.rpName.length === 0) {
    throw new VouchflowError({ code: 'invalid_config', message: 'rpName is required' })
  }
  // Validate rpId is a syntactically valid hostname (no scheme, no path).
  // We don't validate against current origin here — that's a runtime check at
  // ceremony time (browsers enforce it via SecurityError).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(config.rpId)) {
    throw new VouchflowError({
      code: 'invalid_config',
      message: `rpId "${config.rpId}" is not a syntactically valid hostname`,
    })
  }
  return {
    apiKey: config.apiKey,
    environment: config.environment,
    rpId: config.rpId,
    rpName: config.rpName,
    apiBaseUrl: (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, ''),
    apiVersion: config.apiVersion ?? DEFAULT_API_VERSION,
  }
}
