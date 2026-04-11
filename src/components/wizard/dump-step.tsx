import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import type { DumpProgress, DumpJobState } from "@/lib/types";
import { formatBytes } from "@/lib/core/hashing";

interface DumpStepProps {
  state: DumpJobState;
  progress: DumpProgress | null;
  error: string | null;
  onAbort: () => void;
  onRetry: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  rom: "Reading ROM",
  save: "Reading Save",
  header: "Reading Header",
  verify: "Verifying",
};

export function DumpStep({ state, progress, error, onAbort, onRetry }: DumpStepProps) {
  const fraction = progress?.fraction ?? 0;
  const phaseLabel = progress ? (PHASE_LABELS[progress.phase] ?? progress.phase) : "Preparing...";
  const [confirmAbort, setConfirmAbort] = useState(false);

  const handleAbort = useCallback(() => {
    if (confirmAbort) {
      onAbort();
      setConfirmAbort(false);
    } else {
      setConfirmAbort(true);
      setTimeout(() => setConfirmAbort(false), 3000);
    }
  }, [confirmAbort, onAbort]);

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={onRetry}>
            Back to Configuration
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
          {phaseLabel}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Progress value={fraction * 100} />
        {progress && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatBytes(progress.bytesRead)} / {formatBytes(progress.totalBytes)}</span>
            <span>{(fraction * 100).toFixed(1)}%</span>
          </div>
        )}
        {(state === "dumping_rom" || state === "dumping_save") && (
          <Button variant={confirmAbort ? "destructive" : "outline"} onClick={handleAbort}>
            {confirmAbort ? "Confirm Abort?" : "Abort"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
