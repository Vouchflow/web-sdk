import { useCallback, useState } from 'react'
import { useVouchflow } from './useVouchflow.js'
import type { VerifyOptions, VerifyResult } from '../types.js'
import { VouchflowError } from '../core/errors.js'

export interface UseVerifyState {
  verify: (opts: VerifyOptions) => Promise<VerifyResult>
  isVerifying: boolean
  lastResult: VerifyResult | null
  error: VouchflowError | null
}

export function useVerify(): UseVerifyState {
  const client = useVouchflow()
  const [isVerifying, setIsVerifying] = useState(false)
  const [lastResult, setLastResult] = useState<VerifyResult | null>(null)
  const [error, setError] = useState<VouchflowError | null>(null)

  const verify = useCallback(
    async (opts: VerifyOptions) => {
      setIsVerifying(true)
      setError(null)
      try {
        const result = await client.verify(opts)
        setLastResult(result)
        return result
      } catch (err) {
        const ve = err instanceof VouchflowError
          ? err
          : new VouchflowError({ code: 'unknown_error', message: String(err), cause: err })
        setError(ve)
        throw ve
      } finally {
        setIsVerifying(false)
      }
    },
    [client],
  )

  return { verify, isVerifying, lastResult, error }
}
