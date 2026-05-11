import React, { createContext, useEffect, useMemo, useRef } from 'react'
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
  const configRef = useRef<VouchflowConfig>(props.config)
  const client = useMemo(() => {
    configRef.current = props.config
    return Vouchflow.configure(props.config)
    // Re-run only when key identity-defining fields change. apiKey + rpId is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.config.apiKey, props.config.rpId, props.config.environment])

  useEffect(() => {
    return () => {
      Vouchflow._reset()
    }
  }, [])

  return <VouchflowContext.Provider value={client}>{props.children}</VouchflowContext.Provider>
}
