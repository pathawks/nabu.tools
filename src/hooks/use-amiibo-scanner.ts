import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type {
  DeviceDriver,
  CartridgeInfo,
  OutputFile,
  VerificationHashes,
} from "@/lib/types";
import type { PowerSaveDriver } from "@/lib/drivers/powersave/powersave-driver";
import { AmiiboSystemHandler } from "@/lib/systems/amiibo/amiibo-system-handler";
import { parseAmiiboData, amiiboToCartridgeInfo } from "@/lib/systems/amiibo/amiibo-header";
import { lookupAmiiboName } from "@/lib/systems/amiibo/amiibo-db";
import { parseNdef } from "@/lib/core/ndef";
import { NTAG215_SIZE } from "@/lib/drivers/powersave/powersave-commands";
import type { AmiiboData } from "@/lib/systems/amiibo/amiibo-header";

export type ScannerPhase = "idle" | "polling" | "reading" | "done" | "error";

export interface ScannerResult {
  data: Uint8Array;
  outputFile: OutputFile;
  hashes: VerificationHashes;
  parsed: AmiiboData;
  cartInfo: CartridgeInfo;
  characterName: string | null;
  ndefUri: string | null;
  ndefText: string | null;
  isPartial: boolean;
  durationMs: number;
}

export function useAmiiboScanner(
  driver: DeviceDriver | null,
  log: (msg: string, level?: "info" | "warn" | "error") => void,
) {
  const system = useMemo(() => new AmiiboSystemHandler(), []);

  const [phase, setPhase] = useState<ScannerPhase>("idle");
  const [result, setResult] = useState<ScannerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset state when driver changes (React-recommended render-time pattern)
  const [prevDriver, setPrevDriver] = useState(driver);
  if (driver !== prevDriver) {
    setPrevDriver(driver);
    setPhase(driver ? "polling" : "idle");
    setResult(null);
    setError(null);
  }

  // Tracks UIDs that failed to read — skipped until the tag is removed.
  // Safe as a ref because the abort signal gates async chains (no cross-invocation interference).
  const failedUidRef = useRef<string | null>(null);

  // Main scanning loop — runs as long as the driver is connected.
  // Uses AbortSignal (scoped per effect invocation) instead of a shared boolean
  // so that React StrictMode's double-mount doesn't cause two concurrent chains.
  useEffect(() => {
    if (!driver) return;

    const abort = new AbortController();
    const { signal } = abort;
    let timer: ReturnType<typeof setTimeout>;
    failedUidRef.current = null;

    const psDriver = driver as PowerSaveDriver;
    psDriver.on("onLog", (msg, level) => log(msg, level));

    const schedule = (fn: () => Promise<void>, ms: number) => {
      timer = setTimeout(() => {
        fn().catch((e) => {
          if (!signal.aborted) {
            console.error("[amiibo-scanner]", e);
            schedule(pollForTag, 500);
          }
        });
      }, ms);
    };

    const pollForTag = async () => {
      if (signal.aborted) return;

      const info = await psDriver.detectCartridge("amiibo");
      if (signal.aborted) return;

      if (info && info.meta?.uidHex !== failedUidRef.current) {
        // Tag found — read it
        setPhase("reading");
        setError(null);
        log(`Tag detected: ${info.meta?.uidHex}`);
        await readTag(info);
      } else if (!info && failedUidRef.current) {
        // Failed tag removed — clear so it can be retried
        failedUidRef.current = null;
        setError(null);
        schedule(pollForTag, 100);
      } else {
        schedule(pollForTag, 100);
      }
    };

    const pollForRemoval = async () => {
      if (signal.aborted) return;

      const info = await psDriver.detectCartridge("amiibo");
      if (signal.aborted) return;

      if (!info) {
        log("Tag removed");
        setResult(null);
        setPhase("polling");
        schedule(pollForTag, 100);
      } else {
        schedule(pollForRemoval, 200);
      }
    };

    const readTag = async (info: CartridgeInfo) => {
      const startTime = Date.now();
      try {
        const config = system.buildReadConfig({ uid: info.meta!.uid });
        const rawData = await psDriver.readROM(config, signal);
        if (signal.aborted) return;

        if (rawData.length === 0) {
          throw new Error(
            "Could not read any data from this tag. " +
            "It may use a protocol not supported by this device.",
          );
        }

        const isPartial = rawData.length < NTAG215_SIZE;
        const parsed = parseAmiiboData(rawData);
        const cartInfo = amiiboToCartridgeInfo(parsed, rawData);
        const outputFile = system.buildOutputFile(rawData, config);
        const hashes = await system.computeHashes(rawData);

        // Look up character name or NDEF content
        let characterName: string | null = null;
        let ndefUri: string | null = null;
        let ndefText: string | null = null;

        if (parsed.isAmiibo) {
          characterName = await lookupAmiiboName(parsed.modelInfo!.amiiboId);
          if (characterName) {
            log(`${characterName} — ${parsed.modelInfo!.seriesName} ${parsed.modelInfo!.figureTypeName}`);
          } else {
            log(
              `${parsed.modelInfo!.seriesName} ${parsed.modelInfo!.figureTypeName} (${parsed.uidHex})`,
            );
          }
        } else {
          const ndef = parseNdef(rawData);
          ndefUri = ndef.uri;
          ndefText = ndef.text;
          if (ndefUri) {
            log(`NFC tag — ${ndefUri}`);
          } else if (ndefText) {
            log(`NFC tag — "${ndefText}"`);
          } else {
            log(`NFC tag (not Amiibo) — ${parsed.uidHex}`);
          }
        }
        if (signal.aborted) return;

        setResult({
          data: rawData,
          outputFile,
          hashes,
          parsed,
          cartInfo,
          characterName,
          ndefUri,
          ndefText,
          isPartial,
          durationMs: Date.now() - startTime,
        });
        setPhase("done");

        // Start polling for removal
        schedule(pollForRemoval, 200);
      } catch (e) {
        if (signal.aborted) return;
        const msg = (e as Error).message;
        log(`Read error: ${msg}`, "error");
        setError(msg);
        setPhase("polling");
        failedUidRef.current = (info.meta?.uidHex as string) ?? null;
        schedule(pollForTag, 100);
      }
    };

    // Start scanning via schedule() rather than calling pollForTag() directly.
    // This ensures StrictMode cleanup can cancel the timer before any HID
    // commands fire, preventing two concurrent command streams on the transport.
    schedule(() => { log("Waiting for Amiibo..."); return pollForTag(); }, 0);

    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [driver, system, log]);

  const reset = useCallback(() => {
    setPhase("idle");
    setResult(null);
    setError(null);
  }, []);

  return { phase, result, error, reset };
}
