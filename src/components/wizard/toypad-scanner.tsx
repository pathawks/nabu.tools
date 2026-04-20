import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useToyPadScanner,
  type PadState,
  type PadResult,
} from "@/hooks/use-toypad-scanner";
import { PAD_NAMES, type PadId } from "@/lib/drivers/toypad/toypad-commands";
import { hexStr, formatBytes } from "@/lib/core/hashing";
import { saveFile } from "@/lib/core/file-save";
import type { DeviceDriver, DeviceInfo } from "@/lib/types";

interface ToyPadScannerProps {
  driver: DeviceDriver;
  deviceInfo: DeviceInfo | null;
  onDisconnect: () => void;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
}

export function ToyPadScanner({
  driver,
  deviceInfo,
  onDisconnect,
  log,
}: ToyPadScannerProps) {
  const { pads, allPads } = useToyPadScanner(driver, log);

  return (
    <div className="flex flex-col gap-6">
      {/* Device info bar */}
      <div className="flex items-center justify-between text-sm">
        {deviceInfo && (
          <span className="text-muted-foreground">{deviceInfo.deviceName}</span>
        )}
        <Button variant="outline" size="sm" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>

      {/* Three pads */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {allPads.map((padId) => (
          <PadCard key={padId} padId={padId} state={pads[padId]} />
        ))}
      </div>

      <p className="text-center text-[11px] text-muted-foreground">
        Place figures on the portal to scan them.
      </p>
    </div>
  );
}

function PadCard({ padId, state }: { padId: PadId; state: PadState }) {
  const handleDownload = useCallback(() => {
    if (!state.result) return;
    saveFile(state.result.data, state.result.outputFile.filename, [".bin"]);
  }, [state.result]);

  return (
    <Card
      className={
        state.phase === "done"
          ? "border-primary/40 bg-primary/5"
          : state.phase === "error"
            ? "border-destructive/40 bg-destructive/5"
            : ""
      }
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
          {PAD_NAMES[padId]}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {state.phase === "empty" && (
          <p className="py-4 text-center text-sm text-muted-foreground/50">
            Empty
          </p>
        )}

        {state.phase === "reading" && (
          <div className="flex items-center gap-2 py-4">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-chart-3 border-t-transparent" />
            <span className="text-sm text-chart-3">Reading...</span>
          </div>
        )}

        {state.phase === "error" && (
          <div className="flex flex-col gap-2 py-4">
            <p className="text-sm text-destructive">{state.error}</p>
            {state.uid && (
              <InfoLine label="UID" value={formatUid(state.uid)} mono />
            )}
          </div>
        )}

        {state.phase === "done" && state.result && (
          <PadResultCard
            result={state.result}
            uid={state.uid}
            onDownload={handleDownload}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PadResultCard({
  result,
  uid,
  onDownload,
}: {
  result: PadResult;
  uid: string | null;
  onDownload: () => void;
}) {
  const tagLabel = result.isVehicle ? "Vehicle" : "Character";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
          Lego Dimensions {tagLabel}
        </span>
        {result.characterName && (
          <span className="text-sm font-medium">{result.characterName}</span>
        )}
      </div>

      <div className="flex flex-col gap-1 text-[11px]">
        <InfoLine label="UID" value={uid ?? ""} mono />
        <InfoLine label="Size" value={formatBytes(result.hashes.size)} />
        <InfoLine label="CRC32" value={hexStr(result.hashes.crc32)} mono />
      </div>

      {result.isPartial && (
        <p className="text-[11px] text-chart-3">
          Partial read ({formatBytes(result.hashes.size)}). The .bin may be
          incomplete.
        </p>
      )}

      <Button size="sm" className="w-full" onClick={onDownload}>
        Save .bin
      </Button>
    </div>
  );
}

function formatUid(hex: string): string {
  return hex.match(/.{2}/g)?.join(":") ?? hex;
}

function InfoLine({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span
        className={`truncate text-muted-foreground ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
