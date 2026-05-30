// Amiibo character name database. The user supplies AmiiboAPI's amiibo.json
// (https://github.com/N3evin/AmiiboAPI); we parse it and cache it in
// IndexedDB so it survives refreshes. Nothing is fetched over the network.

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

function idbReplaceAll(
  db: IDBDatabase,
  entries: [string, unknown][],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.clear();
    for (const [key, value] of entries) store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load the cached database from IndexedDB, or null if none was imported. */
async function loadDb(): Promise<Map<string, string> | null> {
  try {
    const db = await openIdb();
    if (!(await idbGet(db, "_populated"))) return null;
    return await new Promise((resolve, reject) => {
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
 * Import an AmiiboAPI amiibo.json database, replacing any cached copy.
 * Returns the number of name entries stored.
 */
export async function importAmiiboDb(file: File): Promise<number> {
  const json: unknown = JSON.parse(await file.text());
  const amiibos =
    json && typeof json === "object"
      ? (json as { amiibos?: unknown }).amiibos
      : undefined;
  if (!amiibos || typeof amiibos !== "object") {
    throw new Error('Not an AmiiboAPI database (no "amiibos" map).');
  }
  // Keys are 16-hex-digit IDs prefixed with "0x"; store them by the bare
  // lowercase hex so a tag's 8-byte ID can be looked up directly. The file is
  // user-supplied, so skip anything that isn't a hex-keyed entry with a name.
  const entries: [string, string][] = Object.entries(
    amiibos as Record<string, unknown>,
  )
    .filter(
      (entry): entry is [string, { name: string }] =>
        /^0x[0-9a-f]{16}$/i.test(entry[0]) &&
        typeof entry[1] === "object" &&
        entry[1] !== null &&
        typeof (entry[1] as { name?: unknown }).name === "string",
    )
    .map(([k, v]) => [k.slice(2).toLowerCase(), v.name]);
  if (entries.length === 0) {
    throw new Error("AmiiboAPI database has no valid entries.");
  }
  await idbReplaceAll(await openIdb(), [...entries, ["_populated", true]]);
  cache = new Map(entries);
  loading = null;
  return cache.size;
}

/**
 * Load the imported database into memory. Returns the entry count, or 0 if
 * none has been imported. Safe to call repeatedly — later calls are instant.
 */
export async function preloadAmiiboDb(): Promise<number> {
  const db = await ensureDb();
  return db?.size ?? 0;
}

/** Whether a database is currently loaded in memory. */
export function isAmiiboDbLoaded(): boolean {
  return cache !== null;
}

/**
 * Look up an Amiibo's character name by its 8-byte hex ID.
 * Returns null if no database is loaded or the ID is unknown.
 */
export async function lookupAmiiboName(
  amiiboId: string,
): Promise<string | null> {
  const db = await ensureDb();
  return db?.get(amiiboId.toLowerCase()) ?? null;
}
