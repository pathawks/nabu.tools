import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useNDSScanner } from "@/hooks/use-nds-scanner";
import { hexStr, formatBytes } from "@/lib/core/hashing";
import { saveFile } from "@/lib/core/file-save";
import type { DeviceInfo, VerificationDB } from "@/lib/types";
import type { NDSDeviceDriver } from "@/lib/systems/nds/nds-header";

interface NDSScannerProps {
  driver: NDSDeviceDriver;
  deviceInfo: DeviceInfo | null;
  onDisconnect: () => void;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  nointroDb?: VerificationDB | null;
}

export function NDSScanner({
  driver,
  deviceInfo,
  onDisconnect,
  log,
  nointroDb = null,
}: NDSScannerProps) {
  const { phase, result, error, progress, cartInfo } = useNDSScanner(
    driver,
    log,
    nointroDb,
  );

  const handleDownload = useCallback(() => {
    if (!result) return;
    saveFile(result.outputFile.data, result.outputFile.filename, [".sav"]);
  }, [result]);

  return (
    <div className="flex flex-col gap-6">
      {/* Device info bar */}
      <div className="flex items-center justify-between text-sm">
        {deviceInfo && (
          <span className="text-muted-foreground">
            {deviceInfo.deviceName}
            {deviceInfo.firmwareVersion && (
              <span className="ml-2 text-muted-foreground/50">
                fw {deviceInfo.firmwareVersion}
              </span>
            )}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>

      {/* Error alert */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            <br />
            Unplug the adapter from USB, wait 3 seconds, plug it back in, and
            reconnect to try again.
          </AlertDescription>
        </Alert>
      )}

      {/* Polling state */}
      {(phase === "polling" || phase === "idle") && (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">
              Insert a DS cartridge...
            </span>
          </CardContent>
        </Card>
      )}

      {/* Reading state */}
      {phase === "reading" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Save Backup In Progress
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {cartInfo && (
              // Placeholders keep the grid layout stable — Save Type and
              // Save Size are populated mid-read after probeSaveChip
              // runs, so without placeholders cells would pop in.
              <div className="grid grid-flow-col grid-rows-2 gap-x-6 gap-y-2 md:grid-cols-3">
                <InfoRow label="Game" value={cartInfo.title ?? "—"} />
                <InfoRow
                  label="Game Code"
                  value={(cartInfo.meta?.gameCode as string) ?? "—"}
                  mono
                />
                <InfoRow
                  label="Maker"
                  value={(cartInfo.meta?.makerCode as string) ?? "—"}
                />
                <InfoRow
                  label="Region"
                  value={(cartInfo.meta?.region as string) ?? "—"}
                />
                <InfoRow
                  label="Save Type"
                  value={cartInfo.saveType ?? "Probing…"}
                />
                <InfoRow
                  label="Save Size"
                  value={
                    cartInfo.saveSize != null
                      ? formatBytes(cartInfo.saveSize)
                      : "Probing…"
                  }
                />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-chart-3">Reading save data...</span>
                {progress && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatBytes(progress.bytesRead)} /{" "}
                    {formatBytes(progress.totalBytes)}
                  </span>
                )}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-chart-3 transition-all duration-150"
                  style={{ width: `${(progress?.fraction ?? 0) * 100}%` }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Result state */}
      {phase === "done" && result && (
        <>
          <Card className="border-primary/40 bg-primary/5">
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                Save Backup Complete
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Cart info */}
              {result.cartInfo.meta?.is3DS ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-3">
                  <InfoRow label="System" value="3DS Cartridge" />
                  {result.cartInfo.saveType && (
                    <InfoRow
                      label="Save Type"
                      value={result.cartInfo.saveType}
                    />
                  )}
                  {result.cartInfo.saveSize != null && (
                    <InfoRow
                      label="Save Size"
                      value={formatBytes(result.cartInfo.saveSize)}
                    />
                  )}
                </div>
              ) : (
                <div className="grid grid-flow-col grid-rows-2 gap-x-6 gap-y-2 md:grid-cols-3">
                  {result.cartInfo.title && (
                    <InfoRow label="Game" value={result.cartInfo.title} />
                  )}
                  {result.cartInfo.meta?.gameCode != null && (
                    <InfoRow
                      label="Game Code"
                      value={result.cartInfo.meta.gameCode as string}
                      mono
                    />
                  )}
                  {result.cartInfo.meta?.makerCode != null && (
                    <InfoRow
                      label="Maker"
                      value={result.cartInfo.meta.makerCode as string}
                    />
                  )}
                  {result.cartInfo.meta?.region != null && (
                    <InfoRow
                      label="Region"
                      value={result.cartInfo.meta.region as string}
                    />
                  )}
                  {result.cartInfo.saveType && (
                    <InfoRow
                      label="Save Type"
                      value={result.cartInfo.saveType}
                    />
                  )}
                  {result.cartInfo.saveSize != null && (
                    <InfoRow
                      label="Save Size"
                      value={formatBytes(result.cartInfo.saveSize)}
                    />
                  )}
                </div>
              )}

              {/* Header-CRC failure — title/gameCode are not trustworthy
                  but the SPI save dump may still be valid. */}
              {result.cartInfo.meta?.headerVerified === false &&
                !result.cartInfo.meta?.is3DS && (
                  <Alert variant="destructive">
                    <AlertTitle>Cartridge identification uncertain</AlertTitle>
                    <AlertDescription>
                      The on-cart header didn't pass CRC validation, so
                      the title and game code shown above may be wrong.
                      The save data dump may still be usable — download
                      it and try loading it in your emulator. If the
                      cart is a regular DS cart, re-seat it (its
                      contacts may be dirty) and dump again.
                    </AlertDescription>
                  </Alert>
                )}

              {/* Dump-quality warnings — non-blocking, the user can still
                  download and try the file. */}
              {result.warnings.length > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>Dump quality warning</AlertTitle>
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      {result.warnings.map((w, i) => (
                        <div key={i}>{w}</div>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {/* Hashes + size / duration */}
              <div className="flex flex-col gap-1 font-mono text-xs">
                <div>
                  <span className="text-muted-foreground">CRC32: </span>
                  <span className="text-card-foreground">
                    {hexStr(result.hashes.crc32)}
                  </span>
                </div>
                <div className="break-all">
                  <span className="text-muted-foreground">SHA-1: </span>
                  <span className="text-card-foreground">
                    {result.hashes.sha1}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Size: </span>
                  <span className="text-card-foreground">
                    {formatBytes(result.data.length)}
                  </span>
                  <span className="text-muted-foreground"> · Duration: </span>
                  <span className="text-card-foreground">
                    {(result.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={handleDownload}>
                  Save .sav
                </Button>
              </div>
            </CardContent>
          </Card>

          <p className="text-center text-[11px] text-muted-foreground">
            Disconnect the adapter from USB to back up another save.
          </p>
        </>
      )}
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-sm text-card-foreground ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
