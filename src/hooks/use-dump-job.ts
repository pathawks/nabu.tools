import { useState, useCallback, useRef } from "react";
import type {
  DeviceDriver,
  SystemHandler,
  DumpJobState,
  DumpProgress,
  DumpResult,
  ConfigValues,
  VerificationDB,
} from "@/lib/types";
import { DumpJobImpl } from "@/lib/core/dump-job";

export function useDumpJob(log: (msg: string, level?: "info" | "warn" | "error") => void) {
  const [state, setState] = useState<DumpJobState>("idle");
  const [progress, setProgress] = useState<DumpProgress | null>(null);
  const [result, setResult] = useState<DumpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (driver: DeviceDriver, system: SystemHandler, values: ConfigValues, verificationDb?: VerificationDB | null) => {
      const job = new DumpJobImpl(driver, system, verificationDb ?? null);
      const abort = new AbortController();
      abortRef.current = abort;

      setResult(null);
      setError(null);
      setProgress(null);

      job.on("onStateChange", setState);
      job.on("onProgress", setProgress);
      job.on("onLog", (msg, level) => log(msg, level));
      job.on("onComplete", setResult);

      try {
        const r = await job.run(values, abort.signal);
        return r;
      } catch (e) {
        if (!abort.signal.aborted) {
          setError((e as Error).message);
        }
        return null;
      } finally {
        abortRef.current = null;
      }
    },
    [log],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setState("aborted");
    log("Dump aborted", "warn");
  }, [log]);

  const reset = useCallback(() => {
    setState("idle");
    setProgress(null);
    setResult(null);
    setError(null);
  }, []);

  return { state, progress, result, error, run, abort, reset };
}
