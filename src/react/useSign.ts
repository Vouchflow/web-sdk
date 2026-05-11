import { useCallback, useState } from 'react'
import { useVouchflow } from './useVouchflow.js'
import type { SignOptions, SignResult } from '../types.js'
import { VouchflowError } from '../core/errors.js'

export interface UseSignState {
  sign: (opts: SignOptions) => Promise<SignResult>
  isSigning: boolean
  signedResult: SignResult | null
  error: VouchflowError | null
}

export function useSign(): UseSignState {
  const client = useVouchflow()
  const [isSigning, setIsSigning] = useState(false)
  const [signedResult, setSignedResult] = useState<SignResult | null>(null)
  const [error, setError] = useState<VouchflowError | null>(null)

  const sign = useCallback(
    async (opts: SignOptions) => {
      setIsSigning(true)
      setError(null)
      try {
        const result = await client.signPayload(opts)
        setSignedResult(result)
        return result
      } catch (err) {
        const ve = err instanceof VouchflowError
          ? err
          : new VouchflowError({ code: 'unknown_error', message: String(err), cause: err })
        setError(ve)
        throw ve
      } finally {
        setIsSigning(false)
      }
    },
    [client],
  )

  return { sign, isSigning, signedResult, error }
}
