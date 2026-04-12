import { useState, useCallback, useMemo } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ScanlineOverlay } from "@/components/shared/scanline-overlay";
import { StatusBadge } from "@/components/shared/status-badge";
import { LogPanel } from "@/components/layout/log-panel";
import { ConnectStep } from "@/components/wizard/connect-step";
import { ConfigureStep } from "@/components/wizard/configure-step";
import { DumpStep } from "@/components/wizard/dump-step";
import { CompleteStep } from "@/components/wizard/complete-step";
import { useLog } from "@/hooks/use-log";
import { useDumpJob } from "@/hooks/use-dump-job";
import { useNoIntro } from "@/hooks/use-nointro";
import { useAmiiboDb } from "@/hooks/use-amiibo-db";
import { useConnection } from "@/hooks/use-connection";
import { DatabasePanel } from "@/components/shared/database-panel";
import { GBSystemHandler } from "@/lib/systems/gb/gb-system-handler";
import { GBASystemHandler } from "@/lib/systems/gba/gba-system-handler";
import { NESSystemHandler } from "@/lib/systems/nes/nes-system-handler";
import { AmiiboScanner } from "@/components/wizard/amiibo-scanner";
import type {
  DeviceDriver,
  DeviceInfo,
  SystemHandler,
  ConfigValues,
  CartridgeInfo,
  DumpJobState,
} from "@/lib/types";

// Available system handlers (only systems with working device support)
const ALL_SYSTEMS: SystemHandler[] = [
  new GBSystemHandler("gb"),
  new GBSystemHandler("gbc"),
  new GBASystemHandler(),
  new NESSystemHandler(),
];

const ACTIVE_STATES: ReadonlySet<DumpJobState> = new Set<DumpJobState>([
  "dumping_rom",
  "dumping_save",
  "hashing",
  "verifying",
  "connecting",
  "detecting",
]);
const isDumping = (s: DumpJobState): boolean => ACTIVE_STATES.has(s);

/** Merge config field defaults with pre-filled values from auto-detection. */
function seedConfigDefaults(
  system: SystemHandler,
  prefilled: ConfigValues,
  cartInfo?: CartridgeInfo,
): ConfigValues {
  const fields = system.getConfigFields(prefilled, cartInfo);
  return fields.reduce<ConfigValues>(
    (acc, f) =>
      f.value !== undefined && !(f.key in acc)
        ? { ...acc, [f.key]: f.value }
        : acc,
    prefilled,
  );
}

function App() {
  const { entries, log } = useLog();
  const dumpJob = useDumpJob(log);
  const nointro = useNoIntro();
  const amiiboDb = useAmiiboDb();

  const [selectedSystem, setSelectedSystem] = useState<SystemHandler | null>(
    null,
  );
  const [configValues, setConfigValues] = useState<ConfigValues>({});
  const [autoDetected, setAutoDetected] = useState<CartridgeInfo | null>(null);
  const [detecting, setDetecting] = useState(false);

  /** Build prefilled config values from detected CartridgeInfo. */
  const prefillFromCartInfo = useCallback(
    (system: SystemHandler, info: CartridgeInfo): ConfigValues => {
      const prefilled: ConfigValues = {};
      if (info.romSize) prefilled.romSizeBytes = info.romSize;
      if (info.saveSize) {
        prefilled.saveSizeBytes = info.saveSize;
        // Save-only systems use readROM() for save data — don't trigger a second read
        if (system.fileExtension !== ".sav") {
          prefilled.backupSave = info.saveSize > 0;
        }
      }
      if (info.mapper?.name) prefilled.mbcType = info.mapper.name;
      if (info.mapper?.id !== undefined) prefilled.mapper = info.mapper.id;
      if (info.meta?.mirroring) prefilled.mirroring = info.meta.mirroring;
      if (info.title) prefilled.title = info.title;

      // Look up in No-Intro DB for better title and GBA ROM size
      const db = nointro.getDb(system.systemId);
      if (db && info.meta?.gameCode) {
        const match = db.lookupBySerial?.(info.meta.gameCode as string);
        if (match) {
          prefilled.title = match.name;
          if (system.systemId === "gba") {
            prefilled.romSizeBytes = match.size;
          }
          log(`No-Intro: ${match.name}`);
        }
      }
      return prefilled;
    },
    [nointro, log],
  );

  /** Run detectSystem() and pre-select the matching SystemHandler. */
  const autoDetectSystem = useCallback(
    async (drv: DeviceDriver) => {
      setDetecting(true);
      log("Auto-detecting cartridge system...");
      try {
        const result = await drv.detectSystem();
        if (!result) {
          log("No cartridge detected — select system manually", "warn");
          return;
        }

        const system = ALL_SYSTEMS.find((s) => s.systemId === result.systemId);
        if (!system) return;

        log(
          `Detected: ${result.cartInfo.title ?? "Unknown"} (${result.cartInfo.mapper?.name ?? "unknown mapper"})`,
        );
        const prefilled = prefillFromCartInfo(system, result.cartInfo);
        const seeded = seedConfigDefaults(system, prefilled, result.cartInfo);

        setSelectedSystem(system);
        setAutoDetected(result.cartInfo);
        setConfigValues(seeded);
      } finally {
        setDetecting(false);
      }
    },
    [log, prefillFromCartInfo],
  );

  const onDeviceReady = useCallback(
    (_driver: DeviceDriver, _info: DeviceInfo) => {
      // Scanner-based devices handle detection in their own polling loop
      const isScanner = _driver.capabilities.some(
        (c) => c.systemId === "amiibo",
      );
      if (!isScanner) autoDetectSystem(_driver);
    },
    [autoDetectSystem],
  );

  const connection = useConnection({ log, onReady: onDeviceReady });

  const handleDisconnect = useCallback(async () => {
    await connection.handleDisconnect();
    setSelectedSystem(null);
    setConfigValues({});
    setAutoDetected(null);
    dumpJob.reset();
  }, [connection, dumpJob]);

  // Filter systems to what the connected device supports
  const availableSystems = useMemo(() => {
    if (!connection.driver) return ALL_SYSTEMS;
    const supported = new Set(
      connection.driver.capabilities.map((c) => c.systemId),
    );
    return ALL_SYSTEMS.filter((s) => supported.has(s.systemId));
  }, [connection.driver]);

  // Determine the status badge state
  const isAmiiboDevice =
    connection.driver?.capabilities.some((c) => c.systemId === "amiibo") ??
    false;

  const badgeState = useMemo(() => {
    if (dumpJob.state !== "idle") return dumpJob.state;
    if (connection.driver) return "configuring" as const;
    return "idle" as const;
  }, [dumpJob.state, connection.driver]);

  const handleSelectSystem = useCallback(
    async (system: SystemHandler) => {
      dumpJob.reset();

      // Do auto-detection BEFORE updating state, so the UI renders once
      // with the final values instead of flashing empty then populated.
      let detected: CartridgeInfo | null = null;
      let prefilled: ConfigValues = {};

      if (connection.driver) {
        const canAutoDetect = connection.driver.capabilities.some(
          (c) => c.systemId === system.systemId && c.autoDetect,
        );
        if (canAutoDetect) {
          log(`Auto-detecting ${system.displayName} cartridge...`);
          const info = await connection.driver.detectCartridge(system.systemId);
          if (info) {
            detected = info;
            log(
              `Detected: ${info.title ?? "Unknown"} (${info.mapper?.name ?? "unknown mapper"})`,
            );
            prefilled = prefillFromCartInfo(system, info);
          } else {
            log("No cartridge detected", "warn");
          }
        }
      }

      const seeded = seedConfigDefaults(
        system,
        prefilled,
        detected ?? undefined,
      );

      // Single batch update — no flash
      setSelectedSystem(system);
      setAutoDetected(detected);
      setConfigValues(seeded);
    },
    [connection.driver, log, prefillFromCartInfo, dumpJob],
  );

  const handleConfigChange = useCallback((key: string, value: unknown) => {
    setConfigValues((prev) => {
      const next = { ...prev, [key]: value };
      // When mapper changes, clear dependent fields so they re-default
      if (key === "mapper") {
        delete next.prgSizeKB;
        delete next.chrSizeKB;
        delete next.mirroring;
        delete next.battery;
      }
      return next;
    });
  }, []);

  const handleStartDump = useCallback(async () => {
    if (!connection.driver || !selectedSystem) return;
    // Resolve field defaults for locked/unset keys (e.g. backupSave, battery)
    // so locked checkbox values that the user can't interact with are included.
    const resolved = seedConfigDefaults(
      selectedSystem,
      configValues,
      autoDetected ?? undefined,
    );
    log("Starting dump...");
    const result = await dumpJob.run(
      connection.driver,
      selectedSystem,
      resolved,
      nointro.getDb(selectedSystem.systemId),
    );
    if (result) {
      log(`Dump complete in ${(result.durationMs / 1000).toFixed(1)}s`);
    }
  }, [
    connection.driver,
    selectedSystem,
    configValues,
    autoDetected,
    dumpJob,
    log,
    nointro,
  ]);

  const handleReset = useCallback(async () => {
    dumpJob.reset();
    await handleDisconnect();
  }, [dumpJob, handleDisconnect]);

  return (
    <TooltipProvider>
      <ScanlineOverlay />
      <div className="flex h-screen">
        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex items-center justify-between border-b border-border px-6 py-3">
            <button
              className="font-display text-2xl font-bold text-primary hover:text-primary/80 transition-colors"
              onClick={handleReset}
            >
              nabu
            </button>
            <StatusBadge state={badgeState} />
          </header>

          <main className="flex-1 overflow-y-auto p-6">
            {!connection.connected ? (
              <ConnectStep
                onConnect={connection.handleConnect}
                onMockConnect={connection.handleMockConnect}
                error={connection.connectError}
                availableDevices={connection.availableDevices}
              />
            ) : isAmiiboDevice ? (
              <AmiiboScanner
                driver={connection.driver!}
                deviceInfo={connection.deviceInfo}
                onDisconnect={handleDisconnect}
                log={log}
              />
            ) : (
              <div className="flex flex-col gap-6">
                <ConfigureStep
                  deviceInfo={connection.deviceInfo}
                  systems={availableSystems}
                  selectedSystem={selectedSystem}
                  onSelectSystem={handleSelectSystem}
                  configValues={configValues}
                  onConfigChange={handleConfigChange}
                  autoDetected={autoDetected}
                  hasVerificationDb={
                    selectedSystem
                      ? !!nointro.getDb(selectedSystem.systemId)
                      : false
                  }
                  detecting={detecting}
                  busy={
                    dumpJob.state !== "idle" &&
                    dumpJob.state !== "complete" &&
                    dumpJob.state !== "error" &&
                    dumpJob.state !== "aborted"
                  }
                  onStartDump={handleStartDump}
                  onDisconnect={handleDisconnect}
                />
                {isDumping(dumpJob.state) && (
                  <DumpStep
                    state={dumpJob.state}
                    progress={dumpJob.progress}
                    error={dumpJob.error}
                    onAbort={dumpJob.abort}
                    onRetry={handleReset}
                  />
                )}
                {dumpJob.state === "error" && (
                  <DumpStep
                    state={dumpJob.state}
                    progress={dumpJob.progress}
                    error={dumpJob.error}
                    onAbort={dumpJob.abort}
                    onRetry={handleReset}
                  />
                )}
                {dumpJob.state === "complete" && dumpJob.result && (
                  <CompleteStep
                    result={dumpJob.result}
                    title={(configValues.title as string) ?? "dump"}
                    fileExtension={selectedSystem?.fileExtension ?? ""}
                    deviceInfo={connection.deviceInfo}
                    cartInfo={autoDetected}
                    systemDisplayName={selectedSystem?.displayName ?? ""}
                    onReset={handleReset}
                  />
                )}
              </div>
            )}
          </main>
        </div>

        {/* Sidebar: Databases + Event Log */}
        <div className="hidden h-screen w-80 flex-col overflow-hidden lg:flex">
          <DatabasePanel nointro={nointro} amiiboDb={amiiboDb} />
          <LogPanel entries={entries} />
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
