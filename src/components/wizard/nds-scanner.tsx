import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { useNDSScanner } from "@/hooks/use-nds-scanner";
import { formatBytes } from "@/lib/core/hashing";
import { saveFile } from "@/lib/core/file-save";
import { NDSCartInfo } from "@/components/shared/nds-cart-info";
import { SaveDumpResult } from "@/components/shared/save-dump-result";
import { CartHeading } from "@/components/shared/cart-heading";
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
  const { phase, result, error, errorRecoverable, progress, cartInfo } =
    useNDSScanner(driver, log, nointroDb);

  const handleDownload = useCallback(() => {
    if (!result) return;
    saveFile(result.outputFile.data, result.outputFile.filename, [".sav"]).catch(
      (e) => log(`Couldn't save file: ${(e as Error).message}`, "error"),
    );
  }, [result, log]);

  const activeInfo = result?.cartInfo ?? cartInfo;
  // Keep the cart panel visible on "error" too: the failure can come from
  // the SPI save chip *after* a successful header read (e.g. IR-equipped
  // carts whose save chip sits on a CS line this device can't reach),
  // and the user wants to see what the scanner identified even when the
  // dump itself didn't complete.
  const showCartCard =
    (phase === "reading" || phase === "done" || phase === "error") &&
    activeInfo;

  return (
    <div className="flex flex-col gap-6">
      {/* Device info bar */}
      <div className="flex items-center justify-between text-sm">
        {deviceInfo && (
          <span className="text-muted-foreground">
            {deviceInfo.deviceName}
            {deviceInfo.firmwareVersion && (
              <>
                {" "}
                <span className="ml-1 text-muted-foreground/50">
                  {deviceInfo.firmwareVersion}
                </span>
              </>
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
            {errorRecoverable && (
              <>
                <br />
                Unplug the adapter from USB, wait 3 seconds, plug it back in,
                and reconnect to try again.
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Detecting state — brief, while the one-shot detect is in flight. */}
      {(phase === "detecting" || phase === "idle") && (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">
              Detecting cartridge...
            </span>
          </CardContent>
        </Card>
      )}

      {/* No-cart terminal state — detect ran and found nothing. */}
      {phase === "no-cart" && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            No DS cartridge detected. Disconnect the adapter from USB, insert
            a cart, and reconnect.
          </CardContent>
        </Card>
      )}

      {/* Single "cart detected" card — body swaps between progress (reading)
          and the nested SaveDumpResult panel (done). */}
      {showCartCard && activeInfo && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              <CartHeading info={activeInfo} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Cart info — 3DS carts skip the NDS header fields (which would
                be all-zero garbage from the all-FF probe); plain NDS / DSi
                shows the full set. */}
            <NDSCartInfo
              info={activeInfo}
              showHeader={!activeInfo.meta?.is3DS}
            />

            {/* Reading state: progress bar. */}
            {phase === "reading" && (
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
                <Progress value={(progress?.fraction ?? 0) * 100} />
              </div>
            )}

            {/* Done state: nested result panel with hashes, optional yellow
                warning Alert, and Save File button. */}
            {phase === "done" && result && (
              <SaveDumpResult
                data={result.data}
                hashes={result.hashes}
                warnings={result.warnings}
                onDownload={handleDownload}
              />
            )}

            {phase === "done" && (
              <p className="text-[11px] text-muted-foreground">
                To dump another cartridge, disconnect and reconnect after
                swapping carts.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
