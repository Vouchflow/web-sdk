// IndexedDB-backed state store. Persists per-userHandle device state and
// metadata (api key fingerprint, schema version) so that:
//   - Subsequent verifies skip re-enrollment
//   - Environment switches (sandbox ↔ production) wipe stale records
//   - Schema migrations are possible without breaking existing users
//
// One DB per origin (`vouchflow`), two object stores: `devices` keyed by
// userHandle, `meta` for environment fingerprint.

const DB_NAME = 'vouchflow'
const DB_VERSION = 1
const DEVICES_STORE = 'devices'
const META_STORE = 'meta'

export interface CredentialRecord {
  credentialId: string  // base64url
  enrolledAt: string    // ISO 8601
  attestationLevel: 'hardware' | 'software' | 'none'
  transports: string[]
  nickname?: string
}

export interface DeviceRecord {
  userHandle: string
  deviceId: string
  credentials: CredentialRecord[]
  lastVerifiedAt: string | null
  configuredRpId: string
  schemaVersion: 1
}

interface MetaRecord {
  key: string
  value: string
}

export interface StateStore {
  get(userHandle: string): Promise<DeviceRecord | null>
  put(record: DeviceRecord): Promise<void>
  delete(userHandle: string): Promise<void>
  clear(): Promise<void>
  getMeta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
}

/** Resolve the global indexedDB factory, throwing a clear error if absent. */
function getIDB(): IDBFactory {
  // In Node tests, fake-indexeddb attaches to globalThis.
  // In browsers, indexedDB is on window/self/globalThis.
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (!idb) {
    throw new Error('IndexedDB is not available in this environment')
  }
  return idb
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = getIDB().open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(DEVICES_STORE)) {
        db.createObjectStore(DEVICES_STORE, { keyPath: 'userHandle' })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function createIndexedDBStateStore(): StateStore {
  return {
    async get(userHandle: string): Promise<DeviceRecord | null> {
      const db = await openDb()
      try {
        const tx = db.transaction(DEVICES_STORE, 'readonly')
        const result = await txPromise(tx.objectStore(DEVICES_STORE).get(userHandle))
        return (result as DeviceRecord | undefined) ?? null
      } finally {
        db.close()
      }
    },

    async put(record: DeviceRecord): Promise<void> {
      const db = await openDb()
      try {
        const tx = db.transaction(DEVICES_STORE, 'readwrite')
        await txPromise(tx.objectStore(DEVICES_STORE).put(record))
        await new Promise<void>((res, rej) => {
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
          tx.onabort = () => rej(tx.error)
        })
      } finally {
        db.close()
      }
    },

    async delete(userHandle: string): Promise<void> {
      const db = await openDb()
      try {
        const tx = db.transaction(DEVICES_STORE, 'readwrite')
        await txPromise(tx.objectStore(DEVICES_STORE).delete(userHandle))
        await new Promise<void>((res, rej) => {
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        })
      } finally {
        db.close()
      }
    },

    async clear(): Promise<void> {
      const db = await openDb()
      try {
        const tx = db.transaction([DEVICES_STORE, META_STORE], 'readwrite')
        await txPromise(tx.objectStore(DEVICES_STORE).clear())
        await txPromise(tx.objectStore(META_STORE).clear())
        await new Promise<void>((res, rej) => {
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        })
      } finally {
        db.close()
      }
    },

    async getMeta(key: string): Promise<string | null> {
      const db = await openDb()
      try {
        const tx = db.transaction(META_STORE, 'readonly')
        const r = (await txPromise(tx.objectStore(META_STORE).get(key))) as MetaRecord | undefined
        return r?.value ?? null
      } finally {
        db.close()
      }
    },

    async setMeta(key: string, value: string): Promise<void> {
      const db = await openDb()
      try {
        const tx = db.transaction(META_STORE, 'readwrite')
        await txPromise(tx.objectStore(META_STORE).put({ key, value }))
        await new Promise<void>((res, rej) => {
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        })
      } finally {
        db.close()
      }
    },
  }
}
