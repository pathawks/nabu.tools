import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
  DumpResult,
  DeviceInfo,
  CartridgeInfo,
  DumpSummary,
  DumpSummaryCell,
} from "@/lib/types";
import { hexStr, formatBytes } from "@/lib/core/hashing";
import { saveFile } from "@/lib/core/file-save";
import { generateDumpReport } from "@/lib/core/dump-report";

type IconCell = Extract<DumpSummaryCell, { kind: "icon" }>;

function IconCanvas({ cell }: { cell: IconCell }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const draw = (i: number) => {
      ctx.putImageData(
        new ImageData(cell.frames[i], cell.width, cell.height),
        0,
        0,
      );
    };
    draw(0);
    if (cell.frames.length <= 1) return;
    let i = 0;
    const id = window.setInterval(() => {
      i = (i + 1) % cell.frames.length;
      draw(i);
    }, cell.frameDurationMs ?? 320);
    return () => window.clearInterval(id);
  }, [cell]);
  return (
    <canvas
      ref={ref}
      width={cell.width}
      height={cell.height}
      aria-label={cell.alt}
      role={cell.alt ? "img" : undefined}
      className="block"
      style={{
        imageRendering: "pixelated",
        width: cell.width * cell.displayScale,
        height: cell.height * cell.displayScale,
      }}
    />
  );
}

interface CompleteStepProps {
  result: DumpResult;
  title: string;
  fileExtension: string;
  deviceInfo: DeviceInfo | null;
  cartInfo: CartridgeInfo | null;
  systemDisplayName: string;
  /** Device supports re-detection without a full USB reconnect. */
  hotSwap: boolean;
  /** True when the dump output is save data, not a ROM (no verification DB applies). */
  saveOnly: boolean;
  /** Optional system-specific breakdown of the dump's contents. */
  summary?: DumpSummary | null;
}

export function CompleteStep({
  result,
  title,
  fileExtension,
  deviceInfo,
  cartInfo,
  systemDisplayName,
  hotSwap,
  saveOnly,
  summary,
}: CompleteStepProps) {
  const verified = result.verification.matched;
  const verifiedName = result.verification.entry?.name;
  const integrityFailed = summary?.integrity?.ok === false;
  const ok = saveOnly ? !integrityFailed : verified;
  const headingText = saveOnly
    ? integrityFailed
      ? "Unverified"
      : "Complete"
    : verified
      ? "Verified"
      : "Unverified";
  const subText = saveOnly
    ? integrityFailed
      ? (summary?.integrity?.message ?? "Integrity check failed")
      : "Dump complete"
    : verified
      ? verifiedName
      : "No match in verification database";

  const baseName = verifiedName ?? (title || "dump");
  // Save-only systems (e.g. PS1 memory card) have no verification DB and
  // their handlers build a sensible date-stamped filename in `buildOutputFile`.
  // ROM systems use the cartridge title (or verified name when available).
  const romFilename =
    verifiedName !== undefined
      ? verifiedName + fileExtension
      : saveOnly && result.rom
        ? result.rom.filename
        : (title || "dump") + fileExtension;
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

  return (
    <Card
      className={
        ok
          ? "border-primary/40 bg-primary/5"
          : "border-chart-3/30 bg-chart-3/5"
      }
    >
      <CardContent className="flex flex-col gap-4 pt-5">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl ${
              ok ? "bg-primary/20 text-primary" : "bg-chart-3/20 text-chart-3"
            }`}
          >
            {ok ? "\u2713" : "?"}
          </div>
          <div>
            <div
              className={`font-display font-bold ${ok ? "text-primary" : "text-chart-3"}`}
            >
              {headingText}
            </div>
            <div className="text-sm text-card-foreground">{subText}</div>
          </div>
        </div>

        {/* Hashes */}
        <div className="flex flex-col gap-1 font-mono text-xs">
          <div>
            <span className="text-muted-foreground">CRC32: </span>
            <span className={ok ? "text-primary" : "text-card-foreground"}>
              {hexStr(result.hashes.crc32)}
            </span>
          </div>
          <div className="break-all">
            <span className="text-muted-foreground">SHA-1: </span>
            <span className={ok ? "text-primary" : "text-card-foreground"}>
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

        {!verified && !saveOnly && result.verification.suggestions && (
          <ul className="list-inside list-disc text-[11px] text-muted-foreground">
            {result.verification.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}

        {summary && (
          <div className="flex flex-col gap-2">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {summary.title}
            </div>
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    {summary.columns.map((c, i) => (
                      <th
                        key={i}
                        className="px-3 py-1.5 text-left font-normal"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => {
                        const mono = summary.monoColumns?.includes(j) ?? false;
                        const muted =
                          summary.mutedColumns?.includes(j) ?? false;
                        return (
                          <td
                            key={j}
                            className={`px-3 py-1 ${mono ? "font-mono" : ""} ${muted ? "text-muted-foreground" : ""}`}
                          >
                            {typeof cell === "string" ? (
                              cell
                            ) : (
                              <IconCanvas cell={cell} />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary.footer && (
              <div className="text-[11px] text-muted-foreground">
                {summary.footer}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {result.rom && (
            <Button
              size="sm"
              onClick={() =>
                saveFile(
                  result.rom!.data,
                  romFilename,
                  result.rom!.acceptExtensions ?? [
                    result.rom!.filename.match(/\.[^.]+$/)?.[0] ?? ".bin",
                  ],
                )
              }
            >
              {result.rom.actionLabel ?? (saveOnly ? "Save File" : "Save ROM")}
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
          {!saveOnly && (
            <Button variant="outline" size="sm" onClick={handleSaveReport}>
              Save Report
            </Button>
          )}
        </div>

        {!hotSwap && (
          <p className="text-[11px] text-muted-foreground">
            {saveOnly
              ? `Disconnect the ${deviceInfo?.deviceName ?? "device"} from USB to back up another save.`
              : `To dump another cartridge, unplug the ${deviceInfo?.deviceName ?? "device"} from USB, swap the cartridge, then plug it back in.`}
          </p>
        )}
        {hotSwap && (
          <p className="text-[11px] text-muted-foreground">
            Swap the cartridge and click Scan to back up another.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
