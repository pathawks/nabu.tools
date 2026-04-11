import { Badge } from "@/components/ui/badge";
import type { DumpJobState } from "@/lib/types";

const STATUS_STYLES: Record<string, string> = {
  idle: "border-border text-muted-foreground",
  connecting: "border-chart-3 text-chart-3",
  detecting: "border-chart-3 text-chart-3",
  configuring: "border-primary text-primary",
  dumping_rom: "border-chart-3 text-chart-3",
  dumping_save: "border-chart-3 text-chart-3",
  hashing: "border-chart-3 text-chart-3",
  verifying: "border-chart-3 text-chart-3",
  complete: "border-primary text-primary",
  error: "border-destructive text-destructive",
  aborted: "border-chart-3 text-chart-3",
  scanning: "border-chart-3 text-chart-3",
  reading: "border-chart-3 text-chart-3",
};

const STATUS_LABELS: Record<string, string> = {
  idle: "idle",
  connecting: "connecting",
  detecting: "detecting",
  configuring: "ready",
  dumping_rom: "dumping",
  dumping_save: "saving",
  hashing: "hashing",
  verifying: "verifying",
  complete: "complete",
  error: "error",
  aborted: "aborted",
  scanning: "scanning",
  reading: "reading",
};

export function StatusBadge({ state }: { state: DumpJobState | "connected" }) {
  const label = STATUS_LABELS[state] ?? state;
  const style = STATUS_STYLES[state] ?? STATUS_STYLES.idle;
  const pulsing = ["dumping_rom", "dumping_save", "hashing", "verifying", "connecting", "detecting", "scanning", "reading"].includes(state);

  return (
    <Badge variant="outline" className={`gap-1.5 ${style}`}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${pulsing ? "animate-pulse" : ""}`}
      />
      {label}
    </Badge>
  );
}
