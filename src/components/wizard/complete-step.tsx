import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { DumpResult, DeviceInfo, CartridgeInfo } from "@/lib/types";
import { hexStr, formatBytes } from "@/lib/core/hashing";
import { saveFile } from "@/lib/core/file-save";
import { generateDumpReport } from "@/lib/core/dump-report";

interface CompleteStepProps {
  result: DumpResult;
  title: string;
  fileExtension: string;
  deviceInfo: DeviceInfo | null;
  cartInfo: CartridgeInfo | null;
  systemDisplayName: string;
  onReset: () => void;
}

export function CompleteStep({
  result,
  title,
  fileExtension,
  deviceInfo,
  cartInfo,
  systemDisplayName,
  onReset,
}: CompleteStepProps) {
  const verified = result.verification.matched;
  const verifiedName = result.verification.entry?.name;

  const baseName = verifiedName ?? (title || "dump");
  const romFilename = baseName + fileExtension;
  const saveFilename = baseName + ".sav";

  const handleSaveReport = useCallback(() => {
    const report = generateDumpReport({
      result,
      deviceInfo,
      cartInfo,
      systemDisplayName,
      filename: romFilename,
      durationMs: result.durationMs,
    });
    const data = new TextEncoder().encode(report);
    saveFile(data, baseName + ".txt", [".txt"]);
  }, [result, deviceInfo, cartInfo, systemDisplayName, romFilename, baseName]);

  const isSaveOnly = fileExtension === ".sav";

  return (
    <Card
      className={
        verified
          ? "border-primary/40 bg-primary/5"
          : isSaveOnly
            ? "border-primary/40 bg-primary/5"
            : "border-chart-3/30 bg-chart-3/5"
      }
    >
      <CardContent className="flex flex-col gap-4 pt-5">
        {/* Verification status — not applicable for save-only systems */}
        {isSaveOnly ? (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xl text-primary">
              {"\u2713"}
            </div>
            <div>
              <div className="font-display font-bold text-primary">
                Complete
              </div>
              <div className="text-sm text-card-foreground">
                Save data backed up successfully
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl ${
                verified
                  ? "bg-primary/20 text-primary"
                  : "bg-chart-3/20 text-chart-3"
              }`}
            >
              {verified ? "\u2713" : "?"}
            </div>
            <div>
              <div
                className={`font-display font-bold ${verified ? "text-primary" : "text-chart-3"}`}
              >
                {verified ? "Verified" : "Unverified"}
              </div>
              <div className="text-sm text-card-foreground">
                {verified ? verifiedName : "No match in verification database"}
              </div>
            </div>
          </div>
        )}

        {/* Hashes */}
        <div className="flex flex-col gap-1 font-mono text-xs">
          <div>
            <span className="text-muted-foreground">CRC32: </span>
            <span
              className={verified ? "text-primary" : "text-card-foreground"}
            >
              {hexStr(result.hashes.crc32)}
            </span>
          </div>
          <div className="break-all">
            <span className="text-muted-foreground">SHA-1: </span>
            <span
              className={verified ? "text-primary" : "text-card-foreground"}
            >
              {result.hashes.sha1}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Size: </span>
            <span className="text-card-foreground">
              {formatBytes(result.hashes.size)}
            </span>
          </div>
        </div>

        {!verified && result.verification.suggestions && (
          <ul className="list-inside list-disc text-[11px] text-muted-foreground">
            {result.verification.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {result.rom && (
            <Button
              size="sm"
              onClick={() =>
                saveFile(result.rom!.data, romFilename, [
                  result.rom!.filename.match(/\.[^.]+$/)?.[0] ?? ".bin",
                ])
              }
            >
              {isSaveOnly ? "Save File" : "Save ROM"}
            </Button>
          )}
          {result.save && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                saveFile(result.save!.data, saveFilename, [".sav"])
              }
            >
              Save SRAM
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleSaveReport}>
            Save Report
          </Button>
          <Button variant="outline" size="sm" onClick={onReset}>
            Swap Cartridge
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          To dump another cartridge, unplug the{" "}
          {deviceInfo?.deviceName ?? "device"} from USB, swap the cartridge,
          then plug it back in.
        </p>
      </CardContent>
    </Card>
  );
}
