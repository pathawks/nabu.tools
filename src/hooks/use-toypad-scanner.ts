import { useState, useEffect, useCallback, useMemo } from "react";
import type { DeviceDriver, OutputFile, VerificationHashes } from "@/lib/types";
import type { ToyPadDriver } from "@/lib/drivers/toypad/toypad-driver";
import type {
  PadId,
  TagEvent,
  TagKind,
} from "@/lib/drivers/toypad/toypad-commands";
import {
  PAD_CENTER,
  PAD_LEFT,
  PAD_RIGHT,
  NTAG213_SIZE,
} from "@/lib/drivers/toypad/toypad-commands";
import { LegoDimensionsSystemHandler } from "@/lib/systems/lego-dimensions/lego-dimensions-system-handler";
import { parseLegoDimensionsData } from "@/lib/systems/lego-dimensions/lego-dimensions-header";

export type PadPhase = "empty" | "reading" | "done" | "error";

export interface PadResult {
  data: Uint8Array;
  outputFile: OutputFile;
  hashes: VerificationHashes;
  characterName: string | null;
  isVehicle: boolean;
  isPartial: boolean;
  durationMs: number;
}

export interface PadState {
  phase: PadPhase;
  uid: string | null;
  result: PadResult | null;
  error: string | null;
}

const EMPTY_PAD: PadState = {
  phase: "empty",
  uid: null,
  result: null,
  error: null,
};

const ALL_PADS: PadId[] = [PAD_LEFT, PAD_CENTER, PAD_RIGHT];

// LED colors for pad states
const LED_IDLE = [20, 20, 25] as const;
const LED_READING = [0, 80, 200] as const;
const LED_DONE = [0, 200, 0] as const;
const LED_ERROR = [200, 0, 0] as const;

export function useToyPadScanner(
  driver: DeviceDriver | null,
  log: (msg: string, level?: "info" | "warn" | "error") => void,
) {
  const ldSystem = useMemo(() => new LegoDimensionsSystemHandler(), []);

  const [pads, setPads] = useState<Record<PadId, PadState>>({
    [PAD_CENTER]: EMPTY_PAD,
    [PAD_LEFT]: EMPTY_PAD,
    [PAD_RIGHT]: EMPTY_PAD,
  });

  const updatePad = useCallback((pad: PadId, update: Partial<PadState>) => {
    setPads((prev) => ({ ...prev, [pad]: { ...prev[pad], ...update } }));
  }, []);

  useEffect(() => {
    if (!driver) return;
    const tpDriver = driver as ToyPadDriver;
    tpDriver.on("onLog", (msg, level) => log(msg, level));

    for (const pad of ALL_PADS) {
      tpDriver.setLed(pad, ...LED_IDLE).catch(() => {});
    }

    // Track UIDs that failed to read — skip until removed to prevent retry loops.
    const failedUids = new Set<string>();
    const readingPads = new Set<PadId>();

    const handleTag = async (event: TagEvent) => {
      const { pad, action, uid, index, kind } = event;
      const uidHex = toHex(uid);

      if (action === "removed") {
        failedUids.delete(uidHex);
        readingPads.delete(pad);
        updatePad(pad, EMPTY_PAD);
        tpDriver.setLed(pad, ...LED_IDLE).catch(() => {});
        // Removing a non-NTAG tag often unblocks NTAG reads that were failing
        // because the portal's NFC controller can't juggle both families at
        // once — clear failedUids so the user doesn't have to re-lift every
        // Lego figure that happened to collide with a Disney / Skylanders tag.
        //
        // TODO: auto-retry pads currently in error state here. Right now
        // clearing `failedUids` is necessary-but-not-sufficient — the UI
        // still shows the old error until the user physically lifts and
        // re-places each affected tag to trigger a fresh "placed" event.
        if (kind !== "ntag") failedUids.clear();
        return;
      }

      if (failedUids.has(uidHex) || readingPads.has(pad)) return;

      // Only NTAG tags are readable through the Toy Pad. For anything else
      // the portal detected (Disney Infinity MIFARE, Skylanders, hotel keys)
      // the READ command either errors or returns stale data from a prior
      // tag — so short-circuit and show what the portal already told us.
      if (kind !== "ntag") {
        const msg = unreadableMessage(kind);
        log(msg, "warn");
        failedUids.add(uidHex);
        updatePad(pad, { phase: "error", uid: uidHex, error: msg });
        tpDriver.setLed(pad, ...LED_ERROR).catch(() => {});
        return;
      }

      readingPads.add(pad);
      updatePad(pad, {
        phase: "reading",
        uid: uidHex,
        result: null,
        error: null,
      });
      tpDriver.setLed(pad, ...LED_READING).catch(() => {});

      const startTime = Date.now();
      try {
        const rawData = await tpDriver.readTag(index);

        if (rawData.length === 0) {
          throw new Error("Could not read any data from this tag.");
        }

        // The Toy Pad's READ command doesn't reliably honor the tagIndex arg
        // when multiple tags are on the portal — it silently returns whichever
        // tag the NFC controller is currently locked onto. Detect that by
        // confirming the page-0 UID matches the anti-collision UID we got in
        // the tag event, and fail loudly if they diverge.
        //
        // TODO: find a portal-level "select tag N" command so multi-tag reads
        // actually work. Until then, users can only reliably read one tag
        // at a time even though the portal tracks multiple indices.
        const page0Uid = new Uint8Array([
          rawData[0],
          rawData[1],
          rawData[2],
          rawData[4],
          rawData[5],
          rawData[6],
          rawData[7],
        ]);
        if (!uidsEqual(page0Uid, uid)) {
          throw new Error(
            "Another tag on the portal is blocking this read — try removing other tags.",
          );
        }

        const isPartial = rawData.length < NTAG213_SIZE;
        const parsed = parseLegoDimensionsData(rawData);
        const config = ldSystem.buildReadConfig({ uid, padIndex: index });
        const outputFile = ldSystem.buildOutputFile(rawData, config);
        const hashes = await ldSystem.computeHashes(rawData);

        const typeLabel = parsed.isVehicle ? "Vehicle" : "Character";
        log(
          parsed.characterName
            ? `${parsed.characterName} (${typeLabel})`
            : `Lego Dimensions ${typeLabel} — ${uidHex}`,
        );

        updatePad(pad, {
          phase: "done",
          result: {
            data: rawData,
            outputFile,
            hashes,
            characterName: parsed.characterName,
            isVehicle: parsed.isVehicle,
            isPartial,
            durationMs: Date.now() - startTime,
          },
        });
        readingPads.delete(pad);
        tpDriver.setLed(pad, ...LED_DONE).catch(() => {});
      } catch (e) {
        const msg = (e as Error).message;
        log(`Read error: ${msg}`, "error");
        failedUids.add(uidHex);
        readingPads.delete(pad);
        updatePad(pad, { phase: "error", error: msg });
        tpDriver.setLed(pad, ...LED_ERROR).catch(() => {});
      }
    };

    const unsub = tpDriver.onTagEvent(handleTag);
    return unsub;
  }, [driver, log, ldSystem, updatePad]);

  return { pads, allPads: ALL_PADS };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function uidsEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function unreadableMessage(kind: TagKind): string {
  switch (kind) {
    case "mifare-disney":
      return "Disney Infinity figure — use the Disney Infinity Base to read.";
    case "mifare-foreign":
      return "Unsupported MIFARE Classic tag (Skylanders or similar). The Toy Pad can't read MIFARE block data.";
    case "mifare-4byte":
      return "Unsupported 4-byte MIFARE Classic tag (e.g. hotel key). The Toy Pad can't read MIFARE block data.";
    default:
      return "Unsupported tag type.";
  }
}
