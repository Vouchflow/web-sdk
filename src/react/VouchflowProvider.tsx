import React, { createContext, useEffect, useMemo } from 'react'
import type { VouchflowClient } from '../core/client.js'
import { Vouchflow } from '../core/client.js'
import type { VouchflowConfig } from '../types.js'

export const VouchflowContext = createContext<VouchflowClient | null>(null)

export interface VouchflowProviderProps {
  config: VouchflowConfig
  children: React.ReactNode
}

/** Configures the SDK once on mount. On config change, reconfigures with the
 *  new values — useful for env switching in tooling/QA, harmless in prod. */
export function VouchflowProvider(props: VouchflowProviderProps) {
  const client = useMemo(() => {
    return Vouchflow.configure(props.config)
  }, [
    props.config.apiKey,
    props.config.apiBaseUrl,
    props.config.apiVersion,
    props.config.environment,
    props.config.rpId,
    props.config.rpName,
  ])

  useEffect(() => {
    return () => {
      Vouchflow._reset()
    }
  }, [])

  return <VouchflowContext.Provider value={client}>{props.children}</VouchflowContext.Provider>
}
