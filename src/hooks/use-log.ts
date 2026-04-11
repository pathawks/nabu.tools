import { useState, useCallback, useRef } from "react";

export interface LogEntry {
  id: number;
  timestamp: Date;
  message: string;
  level: "info" | "warn" | "error";
}

export function useLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const nextId = useRef(0);

  const log = useCallback((message: string, level: "info" | "warn" | "error" = "info") => {
    setEntries((prev) => [
      ...prev,
      { id: nextId.current++, timestamp: new Date(), message, level },
    ]);
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  return { entries, log, clear };
}
