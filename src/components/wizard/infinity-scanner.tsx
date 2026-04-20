import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { saveFile } from "@/lib/core/file-save";
import type { InfinityDriver } from "@/lib/drivers/infinity/infinity-driver";
import {
  positionName,
  type Position,
} from "@/lib/drivers/infinity/infinity-commands";
import {
  buildFigureFile,
  uidFilename,
  type FigureBlocks,
} from "@/lib/drivers/infinity/infinity-figure-file";
import type { DeviceInfo } from "@/lib/types";

interface InfinityScannerProps {
  driver: InfinityDriver;
  deviceInfo: DeviceInfo | null;
  onDisconnect: () => void;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
}

const POLL_INTERVAL_MS = 500;
const POSITIONS: Position[] = [1, 2, 3];

// Darkened/saturated variant of the theme's primary green — the portal's
// physical LEDs don't render the web color faithfully, and a higher blue
// channel washes it out to sky-blue on hardware.
const COLOR_GREEN: [number, number, number] = [0x00, 0x80, 0x10];
const COLOR_RED: [number, number, number] = [0xff, 0x10, 0x10];
const COLOR_OFF: [number, number, number] = [0, 0, 0];

type SlotState =
  | { kind: "empty" }
  | {
      kind: "authenticated";
      order: number;
      slotByte: number;
      uid?: Uint8Array;
      uidHex?: string;
      figure?: FigureBlocks;
    }
  | {
      kind: "unreadable";
      order: number;
      slotByte: number;
      uid?: Uint8Array;
      uidHex?: string;
    };

/**
 * UID-format hint. Only describes the *format* of the UID, not the tag
 * type — plenty of different products share UID formats, so we can't
 * infer the product from the UID alone.
 */
function classifyUid(uid: Uint8Array): string {
  const hasTail = uid.slice(4, 7).some((b) => b !== 0);
  if (hasTail) {
    return uid[0] === 0x04
      ? "7-byte NXP UID"
      : "7-byte UID";
  }
  return "4-byte UID";
}

type Slots = Record<Position, SlotState>;

const EMPTY_SLOTS: Slots = { 1: { kind: "empty" }, 2: { kind: "empty" }, 3: { kind: "empty" } };

function slotByteToPosition(slotByte: number): Position | null {
  switch (slotByte & 0xf0) {
    case 0x10:
      return 1;
    case 0x20:
      return 2;
    case 0x30:
      return 3;
    default:
      return null;
  }
}

function toHex(bytes: Uint8Array, sep = " "): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join(sep)
    .toUpperCase();
}

export function InfinityScanner({
  driver,
  deviceInfo,
  onDisconnect,
  log,
}: InfinityScannerProps) {
  const [slots, setSlots] = useState<Slots>(EMPTY_SLOTS);

  const ledStateRef = useRef<Map<Position, "green" | "red" | "off">>(new Map());
  const slotsRef = useRef<Slots>(EMPTY_SLOTS);

  const setLedIfChanged = useCallback(
    async (position: Position, to: "green" | "red" | "off") => {
      if (ledStateRef.current.get(position) === to) return;
      ledStateRef.current.set(position, to);
      const color = to === "green" ? COLOR_GREEN : to === "red" ? COLOR_RED : COLOR_OFF;
      try {
        await driver.setLed(position, color[0], color[1], color[2]);
      } catch (e) {
        log(`LED set failed: ${(e as Error).message}`, "warn");
      }
    },
    [driver, log],
  );

  const reconcile = useCallback(async () => {
    let figuresList;
    try {
      figuresList = await driver.listFigures();
    } catch (e) {
      log(`Poll error: ${(e as Error).message}`, "error");
      return;
    }

    const prev = slotsRef.current;
    const next: Slots = { ...prev };
    const newAuthPositions: Position[] = [];
    const newUnreadablePositions: Position[] = [];

    const byPosition = new Map<Position, (typeof figuresList)[number]>();
    for (const f of figuresList) {
      const position = slotByteToPosition(f.slotByte);
      if (position) byPosition.set(position, f);
    }

    for (const position of POSITIONS) {
      const figure = byPosition.get(position);
      if (!figure) {
        if (prev[position].kind !== "empty") {
          next[position] = { kind: "empty" };
          log(`Slot cleared: ${positionName(position)}`);
        }
        continue;
      }

      if (figure.kind === "unreadable") {
        const was = prev[position];
        if (was.kind !== "unreadable" || was.order !== figure.order) {
          next[position] = {
            kind: "unreadable",
            order: figure.order,
            slotByte: figure.slotByte,
          };
          newUnreadablePositions.push(position);
          log(`Unreadable tag on ${positionName(position)}`, "warn");
        }
        continue;
      }

      // authenticated
      const was = prev[position];
      const same = was.kind === "authenticated" && was.order === figure.order;
      if (!same) {
        next[position] = {
          kind: "authenticated",
          slotByte: figure.slotByte,
          order: figure.order,
        };
        newAuthPositions.push(position);
        log(`Figure placed on ${positionName(position)} (order ${figure.order})`);
      }
    }

    slotsRef.current = next;
    setSlots(next);

    await Promise.all(
      POSITIONS.map((p) =>
        setLedIfChanged(
          p,
          next[p].kind === "authenticated"
            ? "green"
            : next[p].kind === "unreadable"
              ? "red"
              : "off",
        ),
      ),
    );

    for (const position of newAuthPositions) {
      const state = slotsRef.current[position];
      if (state.kind !== "authenticated") continue;
      try {
        const uid = await driver.readFigureUid(state.order);
        const manufacturer = await driver.readBlock(state.order, 0, 0);
        const identity = await driver.readBlock(state.order, 0, 1);
        const save1 = await driver.readBlock(state.order, 1, 0);
        const save2 = await driver.readBlock(state.order, 2, 0);
        const save3 = await driver.readBlock(state.order, 3, 0);
        const trailer0 = await driver.readBlock(state.order, 0, 3);
        const trailer1 = await driver.readBlock(state.order, 1, 3);
        const trailer2 = await driver.readBlock(state.order, 2, 3);
        const trailer3 = await driver.readBlock(state.order, 3, 3);
        const trailer4 = await driver.readBlock(state.order, 4, 3);

        const figure: FigureBlocks = {
          uid, manufacturer, identity, save1, save2, save3,
          trailer0, trailer1, trailer2, trailer3, trailer4,
        };
        const uidHex = toHex(uid);
        log(`  ${positionName(position)} UID: ${uidHex}`);

        const current = slotsRef.current[position];
        if (current.kind === "authenticated" && current.order === state.order) {
          const updated: Slots = {
            ...slotsRef.current,
            [position]: { ...current, uid, uidHex, figure },
          };
          slotsRef.current = updated;
          setSlots(updated);
        }
      } catch (e) {
        log(`  Read error: ${(e as Error).message}`, "warn");
      }
    }

    // Foreign tags — the portal still returns the UID, which is worth showing.
    for (const position of newUnreadablePositions) {
      const state = slotsRef.current[position];
      if (state.kind !== "unreadable") continue;
      try {
        const uid = await driver.readFigureUid(state.order);
        const uidHex = toHex(uid);
        log(`  ${positionName(position)} UID: ${uidHex}`);

        const current = slotsRef.current[position];
        if (current.kind === "unreadable" && current.order === state.order) {
          const updated: Slots = {
            ...slotsRef.current,
            [position]: { ...current, uid, uidHex },
          };
          slotsRef.current = updated;
          setSlots(updated);
        }
      } catch (e) {
        log(`  UID read error: ${(e as Error).message}`, "warn");
      }
    }
  }, [driver, log, setLedIfChanged]);

  const reconcileQueueRef = useRef<Promise<void>>(Promise.resolve());
  const scheduleReconcile = useCallback(() => {
    reconcileQueueRef.current = reconcileQueueRef.current.then(reconcile, reconcile);
    return reconcileQueueRef.current;
  }, [reconcile]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    // Any async event means the slot state changed — kick an immediate reconcile.
    driver.onTagEvent(() => {
      if (!cancelled) scheduleReconcile();
    });

    const loop = async () => {
      if (cancelled) return;
      await scheduleReconcile();
      if (cancelled) return;
      timer = window.setTimeout(loop, POLL_INTERVAL_MS);
    };
    loop();

    return () => {
      cancelled = true;
      driver.onTagEvent(null);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [driver, scheduleReconcile]);

  const handleDisconnect = useCallback(async () => {
    // Fade all LEDs off before the transport closes so the portal actually
    // receives the command. Doing this in the effect cleanup would fire
    // spuriously under StrictMode and also race against transport close.
    for (const p of POSITIONS) {
      try { await driver.setLed(p, 0, 0, 0); } catch { /* ignore */ }
    }
    onDisconnect();
  }, [driver, onDisconnect]);

  const handleSave = useCallback(
    async (position: Position) => {
      const state = slots[position];
      if (state.kind !== "authenticated" || !state.uid || !state.figure) return;
      const data = buildFigureFile(state.figure);
      await saveFile(data, uidFilename(state.uid), [".bin"]);
    },
    [slots],
  );

  const anyContent = POSITIONS.some((p) => slots[p].kind !== "empty");

  // UIDs that appear on more than one slot (portal ghosts certain foreign
  // tags — NDEF cards in particular — across multiple positions).
  const duplicatedUids = new Set<string>();
  const uidCounts = new Map<string, number>();
  for (const p of POSITIONS) {
    const s = slots[p];
    if (s.kind !== "empty" && s.uidHex) {
      uidCounts.set(s.uidHex, (uidCounts.get(s.uidHex) ?? 0) + 1);
    }
  }
  for (const [uid, count] of uidCounts) {
    if (count > 1) duplicatedUids.add(uid);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between text-sm">
        {deviceInfo && (
          <span className="text-muted-foreground">
            {deviceInfo.deviceName}
            {deviceInfo.firmwareVersion ? ` · v${deviceInfo.firmwareVersion}` : ""}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={handleDisconnect}>
          Disconnect
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Figures on base
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!anyContent ? (
            <div className="flex items-center gap-3 py-4">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm text-muted-foreground">
                Place a Disney Infinity figure on the base...
              </span>
            </div>
          ) : (
            <ul className="flex flex-col gap-3 text-sm">
              {POSITIONS.filter((p) => slots[p].kind !== "empty").map((position) => {
                const state = slots[position];
                const ghostedUid =
                  state.kind === "unreadable" &&
                  !!state.uidHex &&
                  duplicatedUids.has(state.uidHex);
                return (
                  <SlotRow
                    key={position}
                    position={position}
                    state={state}
                    ghostedUid={ghostedUid}
                    onSave={() => handleSave(position)}
                  />
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-[11px] text-muted-foreground">
        Figure data is saved as raw portal output — identify characters by
        decrypting the .bin in an external tool.
      </p>
    </div>
  );
}

function SlotRow({
  position,
  state,
  ghostedUid,
  onSave,
}: {
  position: Position;
  state: SlotState;
  ghostedUid: boolean;
  onSave: () => void;
}) {
  const name = positionName(position);
  if (state.kind === "unreadable") {
    return (
      <li className="flex flex-col gap-1 border-l-2 border-destructive/60 pl-3">
        <div className="flex items-center justify-between">
          <span className="text-card-foreground">{name}</span>
          <span className="text-[11px] text-destructive">
            {state.uid ? classifyUid(state.uid) : "unreadable tag"}
          </span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">
          UID: {state.uidHex ?? "reading…"}
        </div>
        {ghostedUid && (
          <div className="text-[11px] text-muted-foreground italic">
            Portal is reporting this tag on multiple slots — likely a single
            physical card that the firmware can't cleanly classify.
          </div>
        )}
      </li>
    );
  }
  if (state.kind === "authenticated") {
    const ready = !!state.uid && !!state.figure;
    return (
      <li className="flex flex-col gap-1 border-l-2 border-primary/60 pl-3">
        <div className="flex items-center justify-between">
          <span className="text-card-foreground">{name}</span>
          <span className="text-[11px] text-muted-foreground">
            order {state.order} · 0x
            {state.slotByte.toString(16).padStart(2, "0")}
          </span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">
          UID: {state.uidHex ?? "reading…"}
        </div>
        <div>
          <Button size="sm" disabled={!ready} onClick={onSave}>
            Save .bin
          </Button>
        </div>
      </li>
    );
  }
  return null;
}
