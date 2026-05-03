import { useState, useCallback, useRef, useEffect } from "react";
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

export function useDumpJob(
  log: (msg: string, level?: "info" | "warn" | "error") => void,
) {
  const [state, setState] = useState<DumpJobState>("idle");
  const [progress, setProgress] = useState<DumpProgress | null>(null);
  const [result, setResult] = useState<DumpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingProgressRef = useRef<DumpProgress | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Coalesce rapid progress events to one render per animation frame. PS1
  // dumps fire ~1024 events in well under a second; without throttling the
  // concurrent renderer keeps interrupting itself and the bar appears stuck.
  const setProgressThrottled = useCallback((p: DumpProgress) => {
    pendingProgressRef.current = p;
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const latest = pendingProgressRef.current;
      pendingProgressRef.current = null;
      if (latest) setProgress(latest);
    });
  }, []);

  const cancelPendingProgress = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingProgressRef.current = null;
  }, []);

  useEffect(() => () => cancelPendingProgress(), [cancelPendingProgress]);

  const run = useCallback(
    async (
      driver: DeviceDriver,
      system: SystemHandler,
      values: ConfigValues,
      verificationDb?: VerificationDB | null,
    ) => {
      const job = new DumpJobImpl(driver, system, verificationDb ?? null);
      const abort = new AbortController();
      abortRef.current = abort;

      cancelPendingProgress();
      setResult(null);
      setError(null);
      setProgress(null);

      job.on("onStateChange", setState);
      job.on("onProgress", setProgressThrottled);
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
    [log, setProgressThrottled, cancelPendingProgress],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setState("aborted");
    log("Dump aborted", "warn");
  }, [log]);

  const reset = useCallback(() => {
    cancelPendingProgress();
    setState("idle");
    setProgress(null);
    setResult(null);
    setError(null);
  }, [cancelPendingProgress]);

  return { state, progress, result, error, run, abort, reset };
}
