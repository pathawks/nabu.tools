import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { saveFile } from "@/lib/core/file-save";
import type {
  PortalOfPowerDriver,
  PortalTagEvent,
} from "@/lib/drivers/portal-of-power/portal-driver";
import { diffStatus } from "@/lib/drivers/portal-of-power/portal-commands";
import {
  figureFilename,
  parseFigureIdentity,
  type FigureIdentity,
} from "@/lib/drivers/portal-of-power/portal-figure-file";
import type { DeviceInfo } from "@/lib/types";

interface PortalScannerProps {
  driver: PortalOfPowerDriver;
  deviceInfo: DeviceInfo | null;
  onDisconnect: () => void;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
}

type Rgb = [number, number, number];

// Portal LEDs render blue far brighter than the other channels, so these are
// damped toward red/green to read as intended on real hardware.
const LED_OFF: Rgb = [0x00, 0x00, 0x00];
const LED_READING: Rgb = [0x00, 0x40, 0xff];
const LED_ERROR: Rgb = [0xff, 0x10, 0x00];
const LED_DONE: Rgb = [0x00, 0xc0, 0x40];

interface SlotEntry {
  slot: number;
  phase: "reading" | "done" | "error";
  data?: Uint8Array;
  identity?: FigureIdentity;
  error?: string;
}

const variantHex = (v: number) => `0x${v.toString(16).padStart(4, "0")}`;

export function PortalScanner({
  driver,
  deviceInfo,
  onDisconnect,
  log,
}: PortalScannerProps) {
  const [slots, setSlots] = useState<Map<number, SlotEntry>>(() => new Map());
  const slotsRef = useRef(slots);

  // Replace-or-delete a slot entry; keep the ref in sync for async readers.
  const setSlot = useCallback((slot: number, entry: SlotEntry | null) => {
    setSlots((prev) => {
      const next = new Map(prev);
      if (entry === null) next.delete(slot);
      else next.set(slot, entry);
      slotsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    // Per-slot generation: bumped on every add/remove so a read that finishes
    // after its figure was lifted (or replaced) can detect it's stale and
    // discard its result instead of resurrecting the slot.
    const readGen = new Map<number, number>();
    let lastLed: Rgb | null = null;

    const setLed = async (rgb: Rgb) => {
      if (lastLed && lastLed.every((c, i) => c === rgb[i])) return;
      lastLed = rgb;
      try {
        await driver.setColor(rgb[0], rgb[1], rgb[2]);
      } catch (e) {
        log(`LED set failed: ${(e as Error).message}`, "warn");
      }
    };

    const refreshLed = () => {
      const entries = [...slotsRef.current.values()];
      if (entries.length === 0) return void setLed(LED_OFF);
      if (entries.some((e) => e.phase === "error"))
        return void setLed(LED_ERROR);
      if (entries.some((e) => e.phase === "reading"))
        return void setLed(LED_READING);
      void setLed(LED_DONE);
    };

    const readSlot = async (slot: number, gen: number) => {
      try {
        const data = await driver.readFigure(slot);
        if (readGen.get(slot) !== gen) return; // lifted / replaced mid-read
        const identity = parseFigureIdentity(data);
        setSlot(slot, { slot, phase: "done", data, identity });
        log(
          `Slot ${slot}: figure ${identity.figureId} / ${variantHex(identity.variantId)} · NUID ${identity.nuidHex}`,
        );
      } catch (e) {
        if (readGen.get(slot) !== gen) return;
        const msg = (e as Error).message;
        setSlot(slot, { slot, phase: "error", error: msg });
        log(`Slot ${slot} read error: ${msg}`, "error");
      } finally {
        refreshLed();
      }
    };

    const handleEvent = (ev: PortalTagEvent) => {
      const gen = (readGen.get(ev.slot) ?? 0) + 1;
      readGen.set(ev.slot, gen);
      if (ev.kind === "removed") {
        setSlot(ev.slot, null);
        log(`Figure removed from slot ${ev.slot}`);
        refreshLed();
        return;
      }
      setSlot(ev.slot, { slot: ev.slot, phase: "reading" });
      refreshLed();
      void readSlot(ev.slot, gen);
    };

    driver.onTagEvent(handleEvent);
    // Seed from any figures already on the pad at connect: diffing against a
    // null prior yields an `added` for every currently-occupied slot.
    const status = driver.currentStatus;
    if (status) for (const ev of diffStatus(null, status)) handleEvent(ev);
    void setLed(LED_OFF);

    return () => {
      driver.onTagEvent(null);
    };
  }, [driver, log, setSlot]);

  const handleDisconnect = useCallback(async () => {
    // Turn the LED off and deactivate while the transport is still open —
    // dispose() runs after it closes, too late to send commands.
    await driver.shutdown();
    onDisconnect();
  }, [driver, onDisconnect]);

  const handleSave = useCallback(
    async (slot: number) => {
      const entry = slotsRef.current.get(slot);
      if (entry?.phase !== "done" || !entry.data || !entry.identity) return;
      try {
        await saveFile(entry.data, figureFilename(entry.identity), [".bin"]);
      } catch (e) {
        log(`Couldn't save figure: ${(e as Error).message}`, "error");
      }
    },
    [log],
  );

  const rows = [...slots.values()].sort((a, b) => a.slot - b.slot);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between text-sm">
        {deviceInfo && (
          <span className="text-muted-foreground">
            {deviceInfo.deviceName}
            {deviceInfo.hardwareRevision
              ? ` · ${deviceInfo.hardwareRevision}`
              : ""}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={handleDisconnect}>
          Disconnect
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Figures on portal
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="flex items-center gap-3 py-4">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm text-muted-foreground">
                Place a Skylanders figure on the portal...
              </span>
            </div>
          ) : (
            <ul className="flex flex-col gap-3 text-sm">
              {rows.map((entry) => (
                <SlotRow
                  key={entry.slot}
                  entry={entry}
                  onSave={() => handleSave(entry.slot)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-[11px] text-muted-foreground">
        Saved as the raw encrypted tag dump — identify or decrypt the .bin in an
        external tool.
      </p>
    </div>
  );
}

function SlotRow({ entry, onSave }: { entry: SlotEntry; onSave: () => void }) {
  const label = `Slot ${entry.slot}`;
  if (entry.phase === "error") {
    return (
      <li className="flex flex-col gap-1 border-l-2 border-destructive/60 pl-3">
        <div className="flex items-center justify-between">
          <span className="text-card-foreground">{label}</span>
          <span className="text-[11px] text-destructive">read failed</span>
        </div>
        <div className="text-[11px] text-muted-foreground">{entry.error}</div>
      </li>
    );
  }
  if (entry.phase === "reading" || !entry.identity) {
    return (
      <li className="flex flex-col gap-1 border-l-2 border-primary/40 pl-3">
        <div className="flex items-center justify-between">
          <span className="text-card-foreground">{label}</span>
          <span className="text-[11px] text-muted-foreground">reading…</span>
        </div>
      </li>
    );
  }
  const { nuidHex, figureId, variantId } = entry.identity;
  return (
    <li className="flex flex-col gap-1 border-l-2 border-primary/60 pl-3">
      <div className="flex items-center justify-between">
        <span className="text-card-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground">
          figure {figureId} · {variantHex(variantId)}
        </span>
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">
        NUID: {nuidHex}
      </div>
      <div>
        <Button size="sm" onClick={onSave}>
          Save .bin
        </Button>
      </div>
    </li>
  );
}
