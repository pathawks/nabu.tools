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
  DeviceInfo,
} from "@/lib/types";

interface ConfigureStepProps {
  deviceInfo: DeviceInfo | null;
  systems: SystemHandler[];
  selectedSystem: SystemHandler | null;
  onSelectSystem: (system: SystemHandler) => void;
  configValues: ConfigValues;
  onConfigChange: (key: string, value: unknown) => void;
  autoDetected: CartridgeInfo | null;
  hasVerificationDb: boolean;
  detecting: boolean;
  busy: boolean;
  onStartDump: () => void;
  onDisconnect: () => void;
}

export function ConfigureStep({
  deviceInfo,
  systems,
  selectedSystem,
  onSelectSystem,
  configValues,
  onConfigChange,
  autoDetected,
  hasVerificationDb,
  detecting,
  busy,
  onStartDump,
  onDisconnect,
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
      {/* Device info — compact header line */}
      <div className="flex items-center justify-between text-sm">
        {deviceInfo && (
          <span className="text-muted-foreground">
            {deviceInfo.deviceName}
            <span className="ml-2 text-muted-foreground/50">
              fw {deviceInfo.firmwareVersion}
            </span>
          </span>
        )}
        <Button variant="outline" size="sm" onClick={onDisconnect}>
          Swap Cartridge
        </Button>
      </div>

      {/* System + Configuration — single card */}
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
                    <Button
                      className="w-full"
                      size="lg"
                      onClick={onStartDump}
                      disabled={validation && !validation.valid}
                    >
                      Start Dump{dumpSizeLabel && ` (${dumpSizeLabel})`}
                    </Button>
                    {!hasVerificationDb &&
                      selectedSystem?.fileExtension !== ".sav" && (
                        <p className="text-center text-[11px] text-muted-foreground">
                          Load a No-Intro DAT in the sidebar to verify your
                          dump.
                        </p>
                      )}
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
