/**
 * BrowserLocalIdentityStore — IndexedDB-backed `LocalIdentityStore` for
 * production (T07.1 / G-T07-2).
 *
 * The PRIVATE half of the X25519 identity keypair lives ONLY on the
 * device (ADR-0003 Invariant 1). Production stores it in IndexedDB under
 * a fixed object-store + key so the page reload after first enrollment
 * can re-open it for the F-03 self-test, the recovery-blob write, and
 * the per-session committee-data-key unwrap.
 *
 * Encoding: the private key is 32 raw bytes (X25519 secret key). We
 * persist a `Uint8Array` directly; IndexedDB serialises it via the
 * structured-clone algorithm. NO additional wrapping at this layer —
 * the device-local OS-keystore wrapping (where available) is provided
 * by the platform's IndexedDB encryption-at-rest (browsers vary; the
 * threat model treats the device as a B2 boundary).
 *
 * Test fallback: when the runtime does not expose `indexedDB`
 * (SvelteKit server-side rendering, vitest jsdom without the indexeddb
 * shim, headless prerender), we fall back to an in-process `Map`. The
 * fallback emits a structured-log warning at construction time so a
 * misconfigured deployment (e.g. trying to call the production code
 * during SSR) doesn't silently lose key material.
 *
 * The class implements `LocalIdentityStore` — the structural split per
 * G-T07-10 means `KeyStore` (server-bound) and this class never share
 * a method that takes or returns the private key.
 */

import type { LocalIdentityStore } from './key-store';

/** IndexedDB database + object-store names. Pin them so renames are git-visible. */
export const IDB_DATABASE_NAME = 'jhsc-identity';
export const IDB_DATABASE_VERSION = 1;
export const IDB_PRIVATE_KEYS_STORE = 'identity_private_keys';

/**
 * Open the JHSC identity IndexedDB database. Creates the object store on
 * upgrade. Idempotent: subsequent calls reuse the existing db.
 */
function openIdb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(IDB_DATABASE_NAME, IDB_DATABASE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_PRIVATE_KEYS_STORE)) {
        db.createObjectStore(IDB_PRIVATE_KEYS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
    req.onblocked = () => reject(new Error('IDB open blocked'));
  });
}

function idbPut(db: IDBDatabase, key: string, value: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_PRIVATE_KEYS_STORE, 'readwrite');
    const store = tx.objectStore(IDB_PRIVATE_KEYS_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('IDB put failed'));
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_PRIVATE_KEYS_STORE, 'readonly');
    const store = tx.objectStore(IDB_PRIVATE_KEYS_STORE);
    const req = store.get(key);
    req.onsuccess = () => {
      const v = req.result;
      if (v === undefined || v === null) resolve(null);
      else if (v instanceof Uint8Array) resolve(v);
      else if (v instanceof ArrayBuffer) resolve(new Uint8Array(v));
      else resolve(null);
    };
    req.onerror = () => reject(req.error ?? new Error('IDB get failed'));
  });
}

export interface BrowserLocalIdentityStoreOptions {
  /**
   * Override the IndexedDB factory (the global `indexedDB`) for tests.
   * When omitted, the constructor reads `globalThis.indexedDB` and falls
   * back to an in-process Map if neither this option nor the global is
   * available.
   */
  idbFactory?: IDBFactory | null;
  /**
   * Optional structured-log emitter for the SSR-fallback warning.
   * Defaults to `console.warn`. Tests inject a stub to assert behavior.
   */
  warn?: (msg: string) => void;
}

export class BrowserLocalIdentityStore implements LocalIdentityStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private fallbackMap: Map<string, Uint8Array> | null = null;

  constructor(opts: BrowserLocalIdentityStoreOptions = {}) {
    const factory =
      opts.idbFactory === undefined
        ? typeof globalThis !== 'undefined'
          ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
          : undefined
        : opts.idbFactory;
    if (!factory) {
      // SSR / no-IDB environment. Fall back to an in-process Map so the
      // module is constructable, but emit a loud warning — losing key
      // material here would be silent in a misconfigured production
      // deployment otherwise.
      const warn = opts.warn ?? ((m: string) => console.warn(m));
      warn(
        'BrowserLocalIdentityStore: IndexedDB unavailable — falling back to in-process Map. ' +
          'This MUST NOT happen in production (ADR-0003 Invariant 3 / F-03).'
      );
      this.fallbackMap = new Map();
      return;
    }
    this.dbPromise = openIdb(factory);
  }

  async storeIdentityPrivateKey(user_id: string, private_key: Uint8Array): Promise<void> {
    if (private_key.length !== 32) {
      throw new Error(
        `BrowserLocalIdentityStore: private key length must be 32 bytes, got ${private_key.length}`
      );
    }
    // Defensive copy so the caller can zero the source buffer.
    const copy = new Uint8Array(private_key);
    if (this.fallbackMap) {
      this.fallbackMap.set(user_id, copy);
      return;
    }
    const db = await this.dbPromise!;
    await idbPut(db, user_id, copy);
  }

  async getIdentityPrivateKey(user_id: string): Promise<Uint8Array> {
    if (this.fallbackMap) {
      const v = this.fallbackMap.get(user_id);
      if (!v) {
        throw new Error(
          `BrowserLocalIdentityStore: device-local private key not found for ${user_id}` +
            ' (enrollment must have run on this device).'
        );
      }
      return v;
    }
    const db = await this.dbPromise!;
    const v = await idbGet(db, user_id);
    if (!v) {
      throw new Error(
        `BrowserLocalIdentityStore: device-local private key not found for ${user_id}` +
          ' (enrollment must have run on this device).'
      );
    }
    return v;
  }
}
