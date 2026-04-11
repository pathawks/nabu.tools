// Amiibo character name database — fetched from AmiiboAPI, cached in IndexedDB
// Source: https://github.com/N3evin/AmiiboAPI

const AMIIBO_DB_URL =
  "https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json";

const IDB_NAME = "nabu-amiibo";
const IDB_STORE = "names";
const IDB_VERSION = 1;

let cache: Map<string, string> | null = null;
let loading: Promise<Map<string, string> | null> | null = null;

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPutAll(
  db: IDBDatabase,
  entries: [string, unknown][],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    for (const [key, value] of entries) store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDb(): Promise<Map<string, string> | null> {
  try {
    const db = await openIdb();

    // Check IndexedDB first
    const populated = await idbGet(db, "_populated");
    if (populated) {
      // Rebuild map from IDB — get all entries
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).openCursor();
        const map = new Map<string, string>();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            if (cursor.key !== "_populated" && typeof cursor.value === "string") {
              map.set(cursor.key as string, cursor.value);
            }
            cursor.continue();
          } else {
            resolve(map);
          }
        };
        req.onerror = () => reject(req.error);
      });
    }

    // Fetch from GitHub
    const resp = await fetch(AMIIBO_DB_URL, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      amiibos: Record<string, { name: string }>;
    };

    const entries: [string, string][] = Object.entries(json.amiibos).map(
      ([k, v]) => [k.slice(2).toLowerCase(), v.name],
    );
    const map = new Map(entries);

    // Persist to IndexedDB
    await idbPutAll(db, [
      ...entries,
      ["_populated", true],
    ]);

    return map;
  } catch {
    return null;
  }
}

async function ensureDb(): Promise<Map<string, string> | null> {
  if (cache) return cache;
  loading ??= loadDb().then((db) => {
    cache = db;
    loading = null;
    return db;
  });
  return loading;
}

/**
 * Preload the database (fetch + cache). Returns entry count.
 * Safe to call multiple times — subsequent calls are instant.
 */
export async function preloadAmiiboDb(): Promise<number> {
  const db = await ensureDb();
  return db?.size ?? 0;
}

/** Whether the database is currently loaded in memory. */
export function isAmiiboDbLoaded(): boolean {
  return cache !== null;
}

/**
 * Look up an Amiibo's character name by its 8-byte hex ID.
 * Returns null if the database is unavailable or the ID is unknown.
 */
export async function lookupAmiiboName(
  amiiboId: string,
): Promise<string | null> {
  const db = await ensureDb();
  return db?.get(amiiboId.toLowerCase()) ?? null;
}
