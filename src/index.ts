// Public entry point — `import { Vouchflow } from '@vouchflow/web'`

export { Vouchflow } from './core/client.js'
export type { VouchflowClient } from './core/client.js'
export { VouchflowError } from './core/errors.js'
export type { VouchflowErrorCode } from './core/errors.js'
export { canonicalize } from './verify/canonicalize.js'
export type {
  VouchflowConfig,
  Environment,
  Confidence,
  AttestationLevel,
  VerifyOptions,
  VerifyResult,
  VerifySignals,
  SignOptions,
  SignResult,
  RequestFallbackOptions,
  RequestFallbackResult,
  CompleteFallbackOptions,
  CompleteFallbackResult,
  CapabilitySupport,
  EnrollmentState,
  EnrollOptions,
  ForgetOptions,
  VerifyConditionalOptions,
  FallbackReason,
} from './types.js'
