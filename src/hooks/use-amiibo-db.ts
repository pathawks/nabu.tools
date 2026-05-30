import { useState, useEffect, useCallback } from "react";
import { preloadAmiiboDb, importAmiiboDb } from "@/lib/systems/amiibo/amiibo-db";

export interface AmiiboDbState {
  loaded: boolean;
  loading: boolean;
  entryCount: number;
  error: string | null;
}

/**
 * Loads the user-imported Amiibo character database (cached in IndexedDB) on
 * mount, and exposes an importer for an AmiiboAPI amiibo.json file.
 */
export function useAmiiboDb() {
  const [state, setState] = useState<AmiiboDbState>({
    loaded: false,
    loading: true,
    entryCount: 0,
    error: null,
  });

  useEffect(() => {
    preloadAmiiboDb()
      .then((count) =>
        setState({ loaded: count > 0, loading: false, entryCount: count, error: null }),
      )
      .catch((e) =>
        setState({ loaded: false, loading: false, entryCount: 0, error: (e as Error).message }),
      );
  }, []);

  const importDb = useCallback(async (file: File) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const count = await importAmiiboDb(file);
      setState({ loaded: count > 0, loading: false, entryCount: count, error: null });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  return { ...state, importDb };
}
