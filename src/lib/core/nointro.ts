import type {
  VerificationDB,
  VerificationHashes,
  VerificationEntry,
  SystemId,
} from "@/lib/types";
import { deriveContentCrc } from "./hashing";

/** A single ROM entry parsed from a No-Intro DAT file. */
export interface NoIntroEntry {
  gameName: string;
  romName: string;
  size: number;
  crc32: string; // lowercase hex — content-only if header was stripped
  sha1: string; // original from DAT (headered if applicable)
  serial?: string;
  status?: string;
  /** Original iNES/etc header bytes from DAT, if present. */
  header?: number[];
}

/** Parsed DAT file metadata. */
export interface NoIntroDat {
  systemName: string;
  version: string;
  entries: NoIntroEntry[];
}

/** Parse a No-Intro DAT XML string into structured data. */
export function parseDatXml(xml: string): NoIntroDat {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error(`DAT XML parse error: ${parseError.textContent}`);
  }

  const header = doc.querySelector("header");
  const systemName = header?.querySelector("name")?.textContent ?? "Unknown";
  const version = header?.querySelector("version")?.textContent ?? "";

  const entries: NoIntroEntry[] = [];
  for (const game of doc.querySelectorAll("game")) {
    const gameName = game.getAttribute("name") ?? "";
    const rom = game.querySelector("rom");
    if (!rom) continue;

    let size = parseInt(rom.getAttribute("size") ?? "0", 10);
    let crc = (rom.getAttribute("crc") ?? "").toLowerCase();
    const sha1 = (rom.getAttribute("sha1") ?? "").toLowerCase();
    const headerHex = rom.getAttribute("header");

    let header: number[] | undefined;

    // If a header attribute is present (e.g., iNES 16-byte header),
    // strip its contribution from the CRC and adjust the size so we
    // can match against headerless ROM dumps.
    if (headerHex) {
      const headerBytes = headerHex
        .trim()
        .split(/\s+/)
        .map((h) => parseInt(h, 16));
      const contentLen = size - headerBytes.length;
      if (contentLen > 0) {
        const fullCrc = parseInt(crc, 16) >>> 0;
        const contentCrc = deriveContentCrc(
          fullCrc,
          new Uint8Array(headerBytes),
          contentLen,
        );
        crc = contentCrc.toString(16).padStart(8, "0");
        size = contentLen;
        header = headerBytes;
      }
    }

    entries.push({
      gameName,
      romName: rom.getAttribute("name") ?? "",
      size,
      crc32: crc,
      sha1,
      serial: rom.getAttribute("serial") ?? undefined,
      status: rom.getAttribute("status") ?? undefined,
      header,
    });
  }

  return { systemName, version, entries };
}

/** Build a VerificationDB from parsed DAT entries. */
export function buildVerificationDb(
  dat: NoIntroDat,
  systemId: SystemId,
): NoIntroVerificationDB {
  return new NoIntroVerificationDB(dat, systemId);
}

export class NoIntroVerificationDB implements VerificationDB {
  readonly systemId: SystemId;
  readonly source: string;
  readonly entryCount: number;

  private byCrc: Map<string, NoIntroEntry>;
  private bySha1: Map<string, NoIntroEntry>;
  private bySerial: Map<string, NoIntroEntry>;

  constructor(dat: NoIntroDat, systemId: SystemId) {
    this.systemId = systemId;
    this.source = `no-intro (${dat.systemName} ${dat.version})`;
    this.entryCount = dat.entries.length;

    this.byCrc = new Map();
    this.bySha1 = new Map();
    this.bySerial = new Map();

    for (const entry of dat.entries) {
      if (entry.crc32) this.byCrc.set(entry.crc32, entry);
      if (entry.sha1) this.bySha1.set(entry.sha1, entry);
      if (entry.serial) this.bySerial.set(entry.serial, entry);
    }
  }

  lookup(hashes: VerificationHashes): VerificationEntry | null {
    // Try SHA-1 first (works for non-headered systems)
    const sha1Key = hashes.sha1.toLowerCase();
    const entry = this.bySha1.get(sha1Key);
    if (entry) {
      return {
        name: entry.gameName,
        status: entry.status === "verified" ? "verified" : "unknown",
      };
    }

    // Fall back to CRC32 (works for headered systems after stripping)
    const crcKey = hashes.crc32.toString(16).padStart(8, "0").toLowerCase();
    const crcEntry = this.byCrc.get(crcKey);
    if (crcEntry) {
      return {
        name: crcEntry.gameName,
        status: crcEntry.status === "verified" ? "verified" : "unknown",
      };
    }

    return null;
  }

  /** Look up ROM by game code (serial). Returns name + size, or null. */
  lookupBySerial(serial: string): { name: string; size: number } | null {
    const entry = this.bySerial.get(serial);
    if (!entry) return null;
    return { name: entry.gameName, size: entry.size };
  }
}

// ─── System ID → No-Intro DAT name mapping ─────────────────────────────

/** Maps our SystemId values to No-Intro DAT system names for lookup. */
export const NOINTRO_SYSTEM_NAMES: Readonly<Record<string, readonly string[]>> =
  {
    gb: ["Nintendo - Game Boy", "Game Boy"],
    gbc: ["Nintendo - Game Boy Color", "Game Boy Color"],
    gba: ["Nintendo - Game Boy Advance", "Game Boy Advance"],
    nes: ["Nintendo - Nintendo Entertainment System", "NES"],
    snes: ["Nintendo - Super Nintendo Entertainment System", "SNES"],
  };

// ─── IndexedDB persistence ──────────────────────────────────────────────

const DB_NAME = "nabu-nointro";
const DB_VERSION = 1;
const STORE_NAME = "dats";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "systemName" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Save a parsed DAT to IndexedDB. */
export async function saveDat(dat: NoIntroDat): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(dat);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load a previously saved DAT from IndexedDB by system name. */
export async function loadDat(systemName: string): Promise<NoIntroDat | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(systemName);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Load all saved DATs from IndexedDB. */
export async function loadAllDats(): Promise<NoIntroDat[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as NoIntroDat[]);
    req.onerror = () => reject(req.error);
  });
}
