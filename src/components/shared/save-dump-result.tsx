import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatBytes, hexStr } from "@/lib/core/hashing";
import type { VerificationEntry, VerificationHashes } from "@/lib/types";

/**
 * "Dump complete" panel shared between single-shot scanners. Visually
 * parallels `CompleteStep` (the wizard-flow panel) so post-dump UX is
 * consistent across both flows — round status badge, prominent Verified /
 * Unverified / Complete heading, themed border, hash block whose colour
 * reflects verification, and an action button row.
 *
 * Verification semantics:
 *   - `verification === undefined`: no lookup was attempted (e.g. save
 *     dumps — No-Intro doesn't index those). Render plain "Complete"
 *     with the `title` text as subtext.
 *   - `verification === null`: lookup attempted, no match in the loaded
 *     DAT. Render "Unverified" with amber border.
 *   - `verification` is a `VerificationEntry`: lookup matched. Render
 *     "Verified" with the canonical game name and primary-coloured
 *     border / hash block.
 */
export interface SaveDumpResultProps {
  data: Uint8Array;
  hashes: VerificationHashes;
  warnings: string[];
  onDownload: () => void;
  /** Heading shown when no verification was attempted. Defaults to
   *  "Save dump complete" — appropriate for save dumps. */
  title?: string;
  /** Override the download button label. Defaults to "Save File". */
  buttonLabel?: string;
  /** Verification result; see component-level docs for tri-state
   *  semantics. */
  verification?: VerificationEntry | null;
}

export function SaveDumpResult({
  data,
  hashes,
  warnings,
  onDownload,
  title = "Save dump complete",
  buttonLabel = "Save File",
  verification,
}: SaveDumpResultProps) {
  const lookupAttempted = verification !== undefined;
  const verified = !!verification;
  const ok = !lookupAttempted || verified;

  const heading = lookupAttempted
    ? verified
      ? "Verified"
      : "Unverified"
    : title;
  const subText = lookupAttempted
    ? verified
      ? (verification?.name ?? "")
      : "No match in verification database"
    : `${formatBytes(data.length)} dumped`;

  return (
    <div
      className={`flex flex-col gap-4 rounded-md border p-4 ${
        ok
          ? "border-primary/40 bg-primary/5"
          : "border-chart-3/30 bg-chart-3/5"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl ${
            ok ? "bg-primary/20 text-primary" : "bg-chart-3/20 text-chart-3"
          }`}
        >
          {ok ? "✓" : "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={`font-display font-bold ${
              ok ? "text-primary" : "text-chart-3"
            }`}
          >
            {heading}
          </div>
          <div className="break-all text-sm text-card-foreground">
            {subText}
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Dump quality warning</AlertTitle>
          <AlertDescription>
            <div className="flex flex-col gap-2">
              {warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1 font-mono text-xs">
        <div>
          <span className="text-muted-foreground">CRC32: </span>
          <span className={ok ? "text-primary" : "text-card-foreground"}>
            {hexStr(hashes.crc32)}
          </span>
        </div>
        <div className="break-all">
          <span className="text-muted-foreground">SHA-1: </span>
          <span className={ok ? "text-primary" : "text-card-foreground"}>
            {hashes.sha1}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Size:  </span>
          <span className="text-card-foreground">{formatBytes(data.length)}</span>
        </div>
      </div>

      <div>
        <Button size="sm" onClick={onDownload}>
          {buttonLabel}
        </Button>
      </div>
    </div>
  );
}
