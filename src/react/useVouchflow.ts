import { useContext } from 'react'
import { VouchflowContext } from './VouchflowProvider.js'
import type { VouchflowClient } from '../core/client.js'

/** Returns the configured Vouchflow client from the surrounding Provider.
 *  Throws if called outside a <VouchflowProvider>. */
export function useVouchflow(): VouchflowClient {
  const client = useContext(VouchflowContext)
  if (!client) {
    throw new Error('useVouchflow must be used inside a <VouchflowProvider>')
  }
  return client
}
