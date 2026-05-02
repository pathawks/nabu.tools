import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfigField } from "@/components/shared/config-field";
import type {
  SystemHandler,
  ConfigValues,
  CartridgeInfo,
} from "@/lib/types";

interface ConfigureStepProps {
  systems: SystemHandler[];
  selectedSystem: SystemHandler | null;
  onSelectSystem: (system: SystemHandler) => void;
  configValues: ConfigValues;
  onConfigChange: (key: string, value: unknown) => void;
  autoDetected: CartridgeInfo | null;
  /** A cartridge was detected that the adapter can't read; render an explanation instead of the dump UI. */
  unsupportedDetection?: { title: string; reason: string } | null;
  /** Whether to hint that the user should load a No-Intro DAT. */
  suggestLoadDat: boolean;
  detecting: boolean;
  busy: boolean;
  onStartDump: () => void;
  /** Whether the device supports re-detection after a physical cart swap. */
  hotSwap: boolean;
  /** Optional cartridge-compatibility note shown under the "insert" prompt. */
  compatibilityNote?: string;
}

export function ConfigureStep({
  systems,
  selectedSystem,
  onSelectSystem,
  configValues,
  onConfigChange,
  autoDetected,
  unsupportedDetection,
  suggestLoadDat,
  detecting,
  busy,
  onStartDump,
  hotSwap,
  compatibilityNote,
}: ConfigureStepProps) {
  const fields = useMemo(
    () =>
      selectedSystem?.getConfigFields(
        configValues,
        autoDetected ?? undefined,
      ) ?? [],
    [selectedSystem, configValues, autoDetected],
  );

  const validation = useMemo(
    () => selectedSystem?.validate(configValues),
    [selectedSystem, configValues],
  );

  const dumpSizeLabel = useMemo(() => {
    const bytes = selectedSystem?.estimateDumpSize?.(configValues);
    if (bytes == null) return null;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
    return `${Math.round(bytes / 1024)}KB`;
  }, [selectedSystem, configValues]);

  // Group fields by their group key
  const groups = useMemo(() => {
    const map = new Map<string, typeof fields>();
    for (const f of fields) {
      const group = f.group ?? "other";
      const list = map.get(group) ?? [];
      list.push(f);
      map.set(group, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    return map;
  }, [fields]);

  return (
    <div className="flex flex-col gap-6">
      {/* Unsupported cartridge detected — show explanation instead of dump UI */}
      {unsupportedDetection && !detecting && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Detected
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Cartridge
              </label>
              <div className="font-mono text-sm">
                {unsupportedDetection.title}
              </div>
            </div>
            <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{unsupportedDetection.reason}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* System + Configuration — single card */}
      {!unsupportedDetection && (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {detecting ? (
            <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              Detecting cartridge...
            </div>
          ) : systems.length === 1 ? (
            /* Single system — static label, no dropdown */
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                System
              </label>
              <div className="flex h-9 items-center font-mono text-sm">
                {systems[0].displayName}
              </div>
            </div>
          ) : (
            /* System selector */
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                System
              </label>
              <Select
                value={selectedSystem?.systemId ?? ""}
                onValueChange={(id) => {
                  const sys = systems.find((s) => s.systemId === id);
                  if (sys) onSelectSystem(sys);
                }}
                disabled={busy}
              >
                <SelectTrigger className="h-9 bg-background font-mono text-sm">
                  <SelectValue placeholder="Select system...">
                    {selectedSystem?.displayName}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {systems.map((s) => (
                    <SelectItem key={s.systemId} value={s.systemId}>
                      {s.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Manual config nudge — only when there are user-editable fields */}
          {selectedSystem &&
            autoDetected &&
            !autoDetected.mapper &&
            !busy &&
            fields.some(
              (f) => f.type !== "readonly" && f.type !== "hidden" && !f.locked,
            ) && (
              <div className="flex gap-2 rounded-md border border-chart-3/30 bg-chart-3/5 px-3 py-2 text-xs text-chart-3">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Mapper and ROM sizes need to be set manually. Look up your
                  game to choose the correct settings.
                </span>
              </div>
            )}

          {/* Config fields from system handler */}
          {selectedSystem && (
            <>
              {[...groups.entries()].map(([groupKey, groupFields]) => {
                // Two-column grid for compact field groups
                if (groupKey === "rom_sizes" || groupKey === "cartridge") {
                  return (
                    <div key={groupKey} className="grid grid-cols-2 gap-3">
                      {groupFields.map((field) => (
                        <ConfigField
                          key={field.key}
                          field={busy ? { ...field, locked: true } : field}
                          onChange={(v) => onConfigChange(field.key, v)}
                        />
                      ))}
                    </div>
                  );
                }

                return (
                  <div key={groupKey} className="flex flex-col gap-3">
                    {groupFields.map((field) => (
                      <ConfigField
                        key={field.key}
                        field={busy ? { ...field, locked: true } : field}
                        onChange={(v) => onConfigChange(field.key, v)}
                      />
                    ))}
                  </div>
                );
              })}

              {!busy && (
                <>
                  {validation &&
                    !validation.valid &&
                    "errors" in validation && (
                      <ul className="text-xs text-destructive">
                        {validation.errors.map((e, i) => (
                          <li key={i}>{e.message}</li>
                        ))}
                      </ul>
                    )}

                  <div className="mt-2 flex flex-col gap-2">
                    {autoDetected ? (
                      <>
                        <Button
                          className="w-full"
                          size="lg"
                          onClick={onStartDump}
                          disabled={validation && !validation.valid}
                        >
                          Start Dump{dumpSizeLabel && ` (${dumpSizeLabel})`}
                        </Button>
                        {suggestLoadDat && (
                          <p className="text-center text-[11px] text-muted-foreground">
                            Load a No-Intro DAT in the sidebar to verify your
                            dump.
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <p className="text-center text-xs text-muted-foreground">
                          {hotSwap
                            ? "Insert a cartridge and click Scan."
                            : "Insert a cartridge, then click Disconnect and reconnect."}
                        </p>
                        {compatibilityNote && (
                          <p className="text-center text-[11px] text-muted-foreground/70">
                            {compatibilityNote}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
