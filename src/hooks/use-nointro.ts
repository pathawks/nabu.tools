import { useState, useEffect, useCallback } from "react";
import type { VerificationDB } from "@/lib/types";
import {
  parseDatXml,
  saveDat,
  loadAllDats,
  buildVerificationDb,
  NOINTRO_SYSTEM_NAMES,
} from "@/lib/core/nointro";

/**
 * Manages No-Intro DAT files — loading, caching, and lookup.
 * Persists to IndexedDB so DATs survive page refreshes.
 * Supports multiple DATs (one per system).
 */
export function useNoIntro() {
  const [dbs, setDbs] = useState<Map<string, VerificationDB>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load all saved DATs from IndexedDB on startup
  useEffect(() => {
    loadAllDats()
      .then((dats) => {
        const map = new Map<string, VerificationDB>();
        for (const dat of dats) {
          const db = buildVerificationDb(dat, dat.systemName);
          map.set(dat.systemName, db);
        }
        if (map.size > 0) setDbs(map);
      })
      .catch(() => {
        // IndexedDB not available — no-op
      });
  }, []);

  const importDat = useCallback(async (file: File) => {
    setError(null);
    setLoading(true);
    try {
      const xml = await file.text();
      const dat = parseDatXml(xml);
      await saveDat(dat);
      const db = buildVerificationDb(dat, dat.systemName);
      setDbs((prev) => {
        const next = new Map(prev);
        next.set(dat.systemName, db);
        return next;
      });
      return db;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Find the best matching DB for a system ID
  const getDb = useCallback(
    (systemId: string): VerificationDB | null => {
      const candidates = NOINTRO_SYSTEM_NAMES[systemId] ?? [systemId];
      for (const candidate of candidates) {
        for (const [key, db] of dbs) {
          if (key.includes(candidate)) return db;
        }
      }
      return null;
    },
    [dbs],
  );

  const systemNames = [...dbs.keys()];
  const totalEntries = [...dbs.values()].reduce(
    (sum, db) => sum + db.entryCount,
    0,
  );

  return { dbs, systemNames, totalEntries, loading, error, importDat, getDb };
}
