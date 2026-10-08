import { ResolvedConfig } from '../core/config.js'
import { bytesToBase64, base64ToBytes, utf8ToBytes } from '../core/encoding.js'
import { VouchflowError } from '../core/errors.js'
import { DeviceRecord, StateStore } from '../core/state-store.js'
import { HttpClient } from '../transport/http.js'
import { webauthnGet } from '../verify/webauthn-get.js'

export interface RecoverContext {
  config: ResolvedConfig
  http: HttpClient
  store: StateStore
}

export interface RecoverArgs {
  userHandle: string
  signal?: AbortSignal
}

interface InitiateResponse {
  session_id: string
  challenge: string
  expires_at: string
}

interface CompleteResponse {
  device_token: string
  credential_id: string
}

/** Restore the local record using an assertion from a discoverable passkey. */
export function performRecover(ctx: RecoverContext, args: RecoverArgs, required: true): Promise<DeviceRecord>
export function performRecover(ctx: RecoverContext, args: RecoverArgs, required?: false): Promise<DeviceRecord | null>
export async function performRecover(
  ctx: RecoverContext,
  args: RecoverArgs,
  required = false,
): Promise<DeviceRecord | null> {
  const unavailable = (reason: 'not_found_or_cancelled' | 'unregistered_passkey'): null => {
    if (required) {
      throw new VouchflowError({
        code: 'passkey_recovery_required',
        reason,
        message: 'Passkey recovery could not complete. Confirm with the user before creating a new credential.',
      })
    }
    return null
  }
  const init = await ctx.http.request<InitiateResponse>({
    method: 'POST',
    path: '/v1/device/recover/initiate',
    body: {},
    signal: args.signal,
  })

  let assertion
  try {
    assertion = await webauthnGet({
      config: ctx.config,
      challenge: base64ToBytes(init.challenge),
      credentialIds: [],
      signal: args.signal,
    })
  } catch (err) {
    if (err instanceof VouchflowError &&
        (err.code === 'biometric_cancelled' || err.code === 'biometric_failed')) {
      return unavailable('not_found_or_cancelled')
    }
    throw err
  }

  const actualHandle = assertion.userHandle === null ? null : new Uint8Array(assertion.userHandle)
  const expectedHandle = utf8ToBytes(args.userHandle)
  if (!actualHandle || actualHandle.length !== expectedHandle.length ||
      !actualHandle.every((byte, index) => byte === expectedHandle[index])) {
    return unavailable('not_found_or_cancelled')
  }

  let complete: CompleteResponse
  try {
    complete = await ctx.http.request<CompleteResponse>({
      method: 'POST',
      path: '/v1/device/recover/complete',
      body: {
        session_id: init.session_id,
        credential_id: assertion.credentialId,
        client_data_json: bytesToBase64(new Uint8Array(assertion.clientDataJSON)),
        authenticator_data: bytesToBase64(new Uint8Array(assertion.authenticatorData)),
        signed_challenge: bytesToBase64(new Uint8Array(assertion.signature)),
        user_handle: bytesToBase64(actualHandle),
      },
      signal: args.signal,
    })
  } catch (err) {
    if (err instanceof VouchflowError && err.code === 'device_not_found') {
      return unavailable('unregistered_passkey')
    }
    throw err
  }

  const device: DeviceRecord = {
    userHandle: args.userHandle,
    deviceId: complete.device_token,
    credentials: [{
      credentialId: complete.credential_id,
      enrolledAt: new Date().toISOString(),
      attestationLevel: 'none',
      transports: [],
    }],
    lastVerifiedAt: null,
    configuredRpId: ctx.config.rpId,
    schemaVersion: 1,
  }
  await ctx.store.put(device)
  return device
}
