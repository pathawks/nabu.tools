import { useState, useEffect, useMemo, useRef } from "react";
import type {
  DumpProgress,
  OutputFile,
  VerificationHashes,
  VerificationDB,
} from "@/lib/types";
import type {
  NDSCartridgeInfo,
  NDSDeviceDriver,
} from "@/lib/systems/nds/nds-header";
import { NDSSaveSystemHandler } from "@/lib/systems/nds/nds-save-system-handler";

export type NDSScannerPhase = "idle" | "polling" | "reading" | "done" | "error";

export interface NDSScannerResult {
  data: Uint8Array;
  outputFile: OutputFile;
  hashes: VerificationHashes;
  cartInfo: NDSCartridgeInfo;
  durationMs: number;
}

export function useNDSScanner(
  driver: NDSDeviceDriver | null,
  log: (msg: string, level?: "info" | "warn" | "error") => void,
  nointroDb: VerificationDB | null = null,
) {
  // Read the latest DB through a ref so the polling effect below doesn't
  // need to re-run (and interrupt an in-flight dump) when the user loads a
  // DAT mid-session.
  const nointroRef = useRef(nointroDb);
  useEffect(() => {
    nointroRef.current = nointroDb;
  }, [nointroDb]);
  const system = useMemo(() => new NDSSaveSystemHandler(), []);

  const [phase, setPhase] = useState<NDSScannerPhase>("idle");
  const [result, setResult] = useState<NDSScannerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DumpProgress | null>(null);
  const [cartInfo, setCartInfo] = useState<NDSCartridgeInfo | null>(null);

  // Reset state when driver changes
  const [prevDriver, setPrevDriver] = useState(driver);
  if (driver !== prevDriver) {
    setPrevDriver(driver);
    setPhase(driver ? "polling" : "idle");
    setResult(null);
    setError(null);
    setCartInfo(null);
  }

  useEffect(() => {
    if (!driver) return;

    const abort = new AbortController();
    const { signal } = abort;
    let timer: ReturnType<typeof setTimeout>;

    driver.on("onLog", (msg, level) => log(msg, level));

    const enrichWithNoIntro = (info: NDSCartridgeInfo): NDSCartridgeInfo => {
      const db = nointroRef.current;
      const gameCode = info.meta?.gameCode;
      if (!db?.lookupBySerial || !gameCode) return info;
      const match = db.lookupBySerial(gameCode);
      if (!match) return info;
      return { ...info, title: match.name };
    };

    driver.on("onProgress", (p: DumpProgress) => {
      setProgress(p);
      // The driver learns save type/size during readROM()'s SPI probe — after
      // detectCartridge already set our cartInfo. Pick the enriched info back
      // up on progress so the UI can show it alongside the progress bar.
      if (driver.cartInfo) setCartInfo(enrichWithNoIntro(driver.cartInfo));
    });

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
        const enriched = enrichWithNoIntro(info);
        setCartInfo(enriched);
        setPhase("reading");
        setError(null);
        setProgress(null);
        await readSave(enriched);
      } else {
        schedule(pollForCart, 500);
      }
    };

    const readSave = async (initialInfo: NDSCartridgeInfo) => {
      const startTime = Date.now();
      try {
        const config = system.buildReadConfig({
          saveSizeBytes: initialInfo.saveSize,
        });

        const saveData = await driver.readROM(config, signal);
        if (signal.aborted) return;

        // After readROM, the driver has full cart info (save size, save type).
        // Re-apply No-Intro enrichment: the driver's cartInfo getter doesn't
        // know about No-Intro, so its title would otherwise overwrite the
        // nicer one we surfaced during reading.
        const fullInfo = enrichWithNoIntro(driver.cartInfo ?? initialInfo);

        const finalConfig = system.buildReadConfig({
          saveSizeBytes: fullInfo.saveSize,
          title: fullInfo.title,
          gameCode: fullInfo.meta?.gameCode,
        });

        const hashes = await system.computeHashes(saveData);
        const outputFile = system.buildOutputFile(saveData, finalConfig);

        const validation = system.validateDump(saveData);
        for (const warning of validation.warnings) {
          log(warning, "warn");
        }

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

        // Deliberately do NOT resume polling here. Hot-swapping a cart
        // while the adapter is powered has been observed to leave the
        // save chip in a state where subsequent driver operations can
        // issue stray SPI writes, corrupting the next cart's save.
        // To scan another cartridge, the user must physically disconnect
        // the adapter from USB and reconnect — that's handled by
        // rebuilding the scanner with a fresh driver instance.
        log(
          "Dump complete. Disconnect the adaptor from USB to dump another cartridge.",
        );
      } catch (e) {
        if (signal.aborted) return;
        const msg = (e as Error).message;
        log(`Read error: ${msg}`, "error");
        setError(msg);
        setPhase("error");
        // Do not auto-retry. A stalled dump may have left the adapter in
        // a state where further operations could write to the cart —
        // require the user to physically disconnect and reconnect.
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

  return { phase, result, error, progress, cartInfo };
}
