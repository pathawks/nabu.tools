import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAmiiboScanner } from "@/hooks/use-amiibo-scanner";
import { hexStr, formatBytes } from "@/lib/core/hashing";
import { saveFile } from "@/lib/core/file-save";
import type { DeviceDriver, DeviceInfo } from "@/lib/types";

interface AmiiboScannerProps {
  driver: DeviceDriver;
  deviceInfo: DeviceInfo | null;
  onDisconnect: () => void;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
}

export function AmiiboScanner({
  driver,
  deviceInfo,
  onDisconnect,
  log,
}: AmiiboScannerProps) {
  const { phase, result, error } = useAmiiboScanner(driver, log);

  const handleDownload = useCallback(() => {
    if (!result) return;
    const date = new Date().toISOString().slice(0, 10);
    const sanitize = (s: string) =>
      s.replace(/[^\w\- .']/g, "").replace(/\s+/g, " ").trim();

    let filename: string;
    if (result.parsed.modelInfo) {
      const series = sanitize(result.parsed.modelInfo.seriesName);
      const character = sanitize(result.characterName ?? "Unknown");
      const id = result.parsed.modelInfo.amiiboId.replace(/^0+/, "") || "0";
      filename = `${series} - ${character} - ${id} - ${date}.bin`;
    } else {
      filename = `NFC Tag - ${result.parsed.uidHex} - ${date}.bin`;
    }

    saveFile(result.outputFile.data, filename, [".bin"]);
  }, [result]);

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

      {/* Unsupported tag / read error — replaces the spinner */}
      {error && (phase === "polling" || phase === "idle") && (
        <>
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="py-8">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
          <p className="text-center text-[11px] text-muted-foreground">
            Remove to scan an Amiibo.
          </p>
        </>
      )}

      {/* Polling state — waiting for tag */}
      {!error && (phase === "polling" || phase === "idle") && (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">
              Place an Amiibo on the portal...
            </span>
          </CardContent>
        </Card>
      )}

      {/* Reading state */}
      {phase === "reading" && (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-chart-3 border-t-transparent" />
            <span className="text-sm text-chart-3">Reading tag...</span>
          </CardContent>
        </Card>
      )}

      {/* Result state */}
      {phase === "done" && result && (
        <>
          <Card className="border-primary/40 bg-primary/5">
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                {result.parsed.isAmiibo ? "Amiibo" : "NFC Tag"}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Left column: tag identity */}
                <div className="flex flex-col gap-2">
                  {result.parsed.isAmiibo && result.parsed.modelInfo ? (
                    <>
                      <InfoRow
                        label="Character"
                        value={result.characterName ?? "Unknown"}
                      />
                      <InfoRow label="Series" value={result.parsed.modelInfo.seriesName} />
                      <InfoRow label="Type" value={result.parsed.modelInfo.figureTypeName} />
                      <InfoRow label="Model" value={`#${result.parsed.modelInfo.modelNumber}`} />
                      <InfoRow label="Size" value={formatBytes(result.hashes.size)} />
                    </>
                  ) : (
                    <>
                      {result.ndefUri && (
                        <InfoRow label="URL" value={result.ndefUri} link />
                      )}
                      {result.ndefText && (
                        <InfoRow label="Text" value={result.ndefText} />
                      )}
                      <InfoRow label="Size" value={formatBytes(result.hashes.size)} />
                    </>
                  )}
                </div>

                {/* Right column: UID + hashes */}
                <div className="flex flex-col gap-2 overflow-hidden">
                  {result.parsed.isAmiibo && result.parsed.modelInfo && (
                    <InfoRow label="Amiibo ID" value={result.parsed.modelInfo.amiiboId} mono />
                  )}
                  <InfoRow
                    label="UID"
                    value={result.parsed.uidFormatted}
                    mono
                    badge={result.rewritten ? "rewritten" : undefined}
                  />
                  <InfoRow label="CRC32" value={hexStr(result.hashes.crc32)} mono />
                  <InfoRow label="SHA-1" value={result.hashes.sha1} mono truncate />
                  <InfoRow label="SHA-256" value={result.hashes.sha256 ?? ""} mono truncate />
                  {result.signature && (
                    <InfoRow
                      label="NXP Sig"
                      value={signatureHex(result.signature)}
                      mono
                      truncate
                      badge={result.signatureValid ? "genuine" : "clone"}
                    />
                  )}
                </div>
              </div>

              {/* Partial dump warning */}
              {result.isPartial && (
                <p className="text-xs text-chart-3">
                  Only {formatBytes(result.hashes.size)} could be read from this
                  tag. The .bin file may not be a complete backup.
                </p>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleDownload}>
                  Save .bin
                </Button>
              </div>
            </CardContent>
          </Card>

          <p className="text-center text-[11px] text-muted-foreground">
            Remove to scan another Amiibo.
          </p>
        </>
      )}
    </div>
  );
}

function signatureHex(sig: Uint8Array): string {
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function InfoRow({
  label,
  value,
  mono,
  badge,
  link,
  truncate: shouldTruncate,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: "genuine" | "clone" | "rewritten";
  link?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      {link ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-primary underline underline-offset-2"
          title={value}
        >
          {value}
        </a>
      ) : (
        <span
          className={`text-card-foreground ${mono ? "font-mono" : ""} ${shouldTruncate ? "truncate" : ""}`}
          title={shouldTruncate ? value : undefined}
        >
          {value}
        </span>
      )}
      {badge && (
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            badge === "genuine"
              ? "bg-primary/20 text-primary"
              : "bg-destructive/20 text-destructive"
          }`}
        >
          {badge}
        </span>
      )}
    </div>
  );
}
