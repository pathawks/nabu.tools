import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { LogEntry } from "@/hooks/use-log";

const LEVEL_COLORS: Record<string, string> = {
  info: "text-muted-foreground",
  warn: "text-chart-3",
  error: "text-destructive",
};

export function LogPanel({ entries }: { entries: LogEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border">
      <div className="border-b border-border px-4 py-2">
        <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">
          Event Log
        </h2>
      </div>
      <ScrollArea className="min-h-0 flex-1 p-3">
        <div className="flex flex-col gap-0.5">
          {entries.length === 0 && (
            <span className="text-xs text-muted-foreground">
              Waiting for activity...
            </span>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="flex gap-2 text-[11px]">
              <span className="shrink-0 text-muted-foreground/50">
                {entry.timestamp.toLocaleTimeString()}
              </span>
              <span className={LEVEL_COLORS[entry.level] ?? ""}>
                {entry.message}
              </span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
