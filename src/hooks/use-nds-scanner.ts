import { useState, useEffect, useMemo } from "react";
import type {
  DeviceDriver,
  CartridgeInfo,
  DumpProgress,
  OutputFile,
  VerificationHashes,
} from "@/lib/types";
import type { EMSNDSDriver } from "@/lib/drivers/ems-nds/ems-nds-driver";
import { NDSSaveSystemHandler } from "@/lib/systems/nds/nds-save-system-handler";

export type NDSScannerPhase = "idle" | "polling" | "reading" | "done" | "error";

export interface NDSScannerResult {
  data: Uint8Array;
  outputFile: OutputFile;
  hashes: VerificationHashes;
  cartInfo: CartridgeInfo;
  durationMs: number;
}

export function useNDSScanner(
  driver: DeviceDriver | null,
  log: (msg: string, level?: "info" | "warn" | "error") => void,
) {
  const system = useMemo(() => new NDSSaveSystemHandler(), []);

  const [phase, setPhase] = useState<NDSScannerPhase>("idle");
  const [result, setResult] = useState<NDSScannerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DumpProgress | null>(null);

  // Reset state when driver changes
  const [prevDriver, setPrevDriver] = useState(driver);
  if (driver !== prevDriver) {
    setPrevDriver(driver);
    setPhase(driver ? "polling" : "idle");
    setResult(null);
    setError(null);
  }

  useEffect(() => {
    if (!driver) return;

    const abort = new AbortController();
    const { signal } = abort;
    let timer: ReturnType<typeof setTimeout>;

    driver.on("onLog", (msg, level) => log(msg, level));
    driver.on("onProgress", (p: DumpProgress) => setProgress(p));

    const schedule = (fn: () => Promise<void>, ms: number) => {
      timer = setTimeout(() => {
        fn().catch((e) => {
          if (!signal.aborted) {
            console.error("[nds-scanner]", e);
            schedule(pollForCart, 1000);
          }
        });
      }, ms);
    };

    const pollForCart = async () => {
      if (signal.aborted) return;

      const info = await driver.detectCartridge("nds_save");
      if (signal.aborted) return;

      if (info) {
        setPhase("reading");
        setError(null);
        setProgress(null);
        await readSave(info);
      } else {
        schedule(pollForCart, 500);
      }
    };

    const pollForRemoval = async () => {
      if (signal.aborted) return;

      const info = await driver.detectCartridge("nds_save");
      if (signal.aborted) return;

      if (!info) {
        log("Cartridge removed");
        setResult(null);
        setPhase("polling");
        schedule(pollForCart, 500);
      } else {
        schedule(pollForRemoval, 500);
      }
    };

    const readSave = async (initialInfo: CartridgeInfo) => {
      const startTime = Date.now();
      try {
        // readROM does prepare -> header -> save in one shot.
        // Pass initial save size; title/gameCode come from header read inside.
        const config = system.buildReadConfig({
          saveSizeBytes: initialInfo.saveSize,
        });

        const saveData = await driver.readROM(config, signal);
        if (signal.aborted) return;

        // After readROM, the driver has full cart info (title, gameCode, etc.)
        const fullInfo = (driver as EMSNDSDriver).cartInfo ?? initialInfo;

        // Rebuild output with full info
        const finalConfig = system.buildReadConfig({
          saveSizeBytes: fullInfo.saveSize,
          title: fullInfo.title,
          gameCode: fullInfo.meta?.gameCode,
        });

        const hashes = await system.computeHashes(saveData);
        const outputFile = system.buildOutputFile(saveData, finalConfig);

        log(
          `CRC32: ${hashes.crc32.toString(16).toUpperCase().padStart(8, "0")}  SHA-1: ${hashes.sha1}`,
        );

        setResult({
          data: saveData,
          outputFile,
          hashes,
          cartInfo: fullInfo,
          durationMs: Date.now() - startTime,
        });
        setPhase("done");

        schedule(pollForRemoval, 500);
      } catch (e) {
        if (signal.aborted) return;
        const msg = (e as Error).message;
        log(`Read error: ${msg}`, "error");
        setError(msg);
        setPhase("polling");
        schedule(pollForCart, 1000);
      }
    };

    schedule(() => {
      log("Waiting for cartridge...");
      return pollForCart();
    }, 0);

    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [driver, system, log]);

  return { phase, result, error, progress };
}
