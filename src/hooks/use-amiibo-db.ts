import { useState, useEffect } from "react";
import { preloadAmiiboDb } from "@/lib/systems/amiibo/amiibo-db";

export interface AmiiboDbState {
  loaded: boolean;
  loading: boolean;
  entryCount: number;
  error: string | null;
}

/** Preloads the AmiiboAPI character database on mount. */
export function useAmiiboDb(): AmiiboDbState {
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

  return state;
}
