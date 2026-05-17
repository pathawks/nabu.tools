import type { ReactNode } from "react";
import { formatBytes } from "@/lib/core/hashing";
import type { NDSCartridgeInfo } from "@/lib/systems/nds/nds-header";

/**
 * Shared cart-info grid for NDS-capable drivers. Renders the parsed
 * header fields plus save-chip info in a consistent 4-column layout.
 *
 * The cart's System family (DS / DSi / 3DS) is intentionally NOT
 * displayed here — scanners surface it as the card heading via the
 * shared CartHeading component. Chip ID is also omitted from the grid;
 * drivers log it to the event log on detect.
 *
 * `showHeader` exists for 3DS carts which return all-0xFF for the NDS
 * header — the header rows would be garbage in that case.
 *
 * `saveTypeContent` lets the parent replace the Save Type cell's value
 * with arbitrary JSX (e.g. a dropdown to override auto-detection).
 * Leave undefined to fall back to the plain `info.saveType` string.
 */
export interface NDSCartInfoProps {
  info: NDSCartridgeInfo;
  /** Show NDS header fields (title, gameCode, maker, region, ROM size, version). */
  showHeader?: boolean;
  /** Show save-chip rows (save type + save size). */
  showSave?: boolean;
  /** Optional replacement for the Save Type cell's value. */
  saveTypeContent?: ReactNode;
  /** Optional replacement for the Save Size cell's value. */
  saveSizeContent?: ReactNode;
}

export function NDSCartInfo({
  info,
  showHeader = true,
  showSave = true,
  saveTypeContent,
  saveSizeContent,
}: NDSCartInfoProps) {
  const m = info.meta ?? {};

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4">
      {showHeader && info.title && <InfoRow label="Game" value={info.title} />}
      {showHeader && m.makerCode != null && (
        <InfoRow label="Maker" value={String(m.makerCode)} />
      )}
      {showHeader && m.romSizeMiB != null && (
        <InfoRow label="ROM Size" value={`${m.romSizeMiB} MiB`} />
      )}
      {showSave && (saveTypeContent !== undefined || info.saveType) && (
        <InfoRow
          label="Save Type"
          value={info.saveType ?? ""}
          customValue={saveTypeContent}
        />
      )}
      {showHeader && m.gameCode != null && (
        <InfoRow label="Game Code" value={String(m.gameCode)} mono />
      )}
      {showHeader && m.region != null && (
        <InfoRow label="Region" value={String(m.region)} />
      )}
      {showHeader && m.romVersion != null && (
        <InfoRow label="ROM Version" value={`v${String(m.romVersion)}`} />
      )}
      {showSave && (saveSizeContent !== undefined || info.saveSize != null) && (
        <InfoRow
          label="Save Size"
          value={info.saveSize != null ? formatBytes(info.saveSize) : ""}
          customValue={saveSizeContent}
        />
      )}
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
  customValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  customValue?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      {customValue !== undefined ? (
        customValue
      ) : (
        <span
          className={`text-sm text-card-foreground ${mono ? "font-mono" : ""}`}
        >
          {value}
        </span>
      )}
    </div>
  );
}
