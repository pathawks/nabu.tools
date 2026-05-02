import { useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
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
import { Ps1SystemHandler } from "@/lib/systems/ps1/ps1-system-handler";
import { NOINTRO_SYSTEM_NAMES } from "@/lib/core/nointro";
import { AmiiboScanner } from "@/components/wizard/amiibo-scanner";
import { InfinityScanner } from "@/components/wizard/infinity-scanner";
import type { InfinityDriver } from "@/lib/drivers/infinity/infinity-driver";
import type {
  DeviceDriver,
  DeviceInfo,
  DeviceCapability,
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
  new Ps1SystemHandler(),
];

/** True when the driver exposes both ROM and save dumping as separate ops. */
const hasSeparateSaveRead = (cap: DeviceCapability | undefined): boolean =>
  !!cap &&
  cap.operations.includes("dump_rom") &&
  cap.operations.includes("dump_save");

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
  const [unsupportedDetection, setUnsupportedDetection] = useState<{
    title: string;
    reason: string;
  } | null>(null);

  /** Build prefilled config values from detected CartridgeInfo. */
  const prefillFromCartInfo = useCallback(
    (
      system: SystemHandler,
      info: CartridgeInfo,
      hasSeparateSaveRead: boolean,
    ): ConfigValues => {
      const prefilled: ConfigValues = {};
      if (info.romSize) prefilled.romSizeBytes = info.romSize;
      if (info.saveSize) {
        prefilled.saveSizeBytes = info.saveSize;
        // Only request a second readSave() pass when the driver declares
        // dump_rom and dump_save as separate operations. Save-only drivers
        // (e.g. PS3 MCA) emit the save image directly from readROM().
        if (hasSeparateSaveRead) {
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
      setUnsupportedDetection(null);
      log("Auto-detecting cartridge system...");
      try {
        let result: Awaited<ReturnType<DeviceDriver["detectSystem"]>> = null;
        try {
          result = await drv.detectSystem();
        } catch (e) {
          log((e as Error).message, "error");
        }

        // Driver flagged the cartridge as detectable but not dumpable.
        if (result?.unsupported) {
          const reason = result.unsupported.reason;
          log(reason, "warn");
          setUnsupportedDetection({
            title: result.cartInfo.title ?? "Unsupported cartridge",
            reason,
          });
          setSelectedSystem(null);
          return;
        }

        if (!result) {
          log("No cartridge detected", "warn");
          // If the driver has exactly one dumpable system, pre-select it so
          // the user has a Start Dump button once they insert the right card.
          const dumpableIds = new Set(
            drv.capabilities
              .filter((c) => c.operations.length > 0)
              .map((c) => c.systemId),
          );
          const dumpable = ALL_SYSTEMS.filter((s) =>
            dumpableIds.has(s.systemId),
          );
          if (dumpable.length === 1) {
            setSelectedSystem(dumpable[0]);
          }
          return;
        }

        const system = ALL_SYSTEMS.find((s) => s.systemId === result.systemId);
        if (!system) return;

        log(
          result.cartInfo.mapper
            ? `Detected: ${result.cartInfo.title ?? "Unknown"} (${result.cartInfo.mapper.name ?? "unknown mapper"})`
            : `Detected: ${result.cartInfo.title ?? "Unknown"}`,
        );
        const cap = drv.capabilities.find((c) => c.systemId === result.systemId);
        const prefilled = prefillFromCartInfo(
          system,
          result.cartInfo,
          hasSeparateSaveRead(cap),
        );
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
        (c) => c.systemId === "amiibo" || c.systemId === "disney-infinity",
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
    setUnsupportedDetection(null);
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
  const isInfinityDevice =
    connection.driver?.capabilities.some(
      (c) => c.systemId === "disney-infinity",
    ) ?? false;

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
        const cap = connection.driver.capabilities.find(
          (c) => c.systemId === system.systemId,
        );
        const canAutoDetect = !!cap?.autoDetect;
        if (canAutoDetect) {
          log(`Auto-detecting ${system.displayName} cartridge...`);
          const info = await connection.driver.detectCartridge(system.systemId);
          if (info) {
            detected = info;
            log(
              info.mapper
                ? `Detected: ${info.title ?? "Unknown"} (${info.mapper.name ?? "unknown mapper"})`
                : `Detected: ${info.title ?? "Unknown"}`,
            );
            prefilled = prefillFromCartInfo(system, info, hasSeparateSaveRead(cap));
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

  /** Re-run cartridge detection on hot-swap devices. Resets any prior dump
   *  result so transitioning from a completed dump back to detect feels
   *  natural. */
  const handleScan = useCallback(() => {
    dumpJob.reset();
    setAutoDetected(null);
    setUnsupportedDetection(null);
    if (connection.driver) autoDetectSystem(connection.driver);
  }, [dumpJob, connection.driver, autoDetectSystem]);

  const hotSwap = connection.deviceInfo?.hotSwap === true;

  return (
    <TooltipProvider>
      <ScanlineOverlay />
      <div className="flex h-screen">
        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex items-center justify-between border-b border-border px-6 py-3">
            <button
              className="cursor-pointer font-display text-2xl font-bold text-primary hover:text-primary/80 transition-colors"
              onClick={handleReset}
            >
              nabu
            </button>
            <div className="flex items-center gap-4">
              <a
                href="https://github.com/pathawks/nabu.tools"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View source on GitHub"
                title="View source on GitHub"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                </svg>
              </a>
              <StatusBadge state={badgeState} />
            </div>
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
            ) : isInfinityDevice ? (
              <InfinityScanner
                driver={connection.driver! as InfinityDriver}
                deviceInfo={connection.deviceInfo}
                onDisconnect={handleDisconnect}
                log={log}
              />
            ) : (
              <div className="flex flex-col gap-6">
                {/* Persistent device header — Disconnect (and Scan, on
                    hot-swap devices) stays visible across all wizard states. */}
                <div className="flex items-center justify-between text-sm">
                  {connection.deviceInfo && (
                    <span className="text-muted-foreground">
                      {connection.deviceInfo.deviceName}
                      {connection.deviceInfo.firmwareVersion && (
                        <span className="ml-2 text-muted-foreground/50">
                          fw {connection.deviceInfo.firmwareVersion}
                        </span>
                      )}
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    {hotSwap && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleScan}
                        disabled={
                          detecting ||
                          (dumpJob.state !== "idle" &&
                            dumpJob.state !== "complete" &&
                            dumpJob.state !== "error" &&
                            dumpJob.state !== "aborted")
                        }
                      >
                        Scan
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDisconnect}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
                {dumpJob.state !== "complete" && (
                  <ConfigureStep
                    systems={availableSystems}
                    selectedSystem={selectedSystem}
                    onSelectSystem={handleSelectSystem}
                    configValues={configValues}
                    onConfigChange={handleConfigChange}
                    autoDetected={autoDetected}
                    unsupportedDetection={unsupportedDetection}
                    suggestLoadDat={
                      !!selectedSystem &&
                      NOINTRO_SYSTEM_NAMES[selectedSystem.systemId] !==
                        undefined &&
                      !nointro.getDb(selectedSystem.systemId) &&
                      !!connection.driver?.capabilities
                        .find((c) => c.systemId === selectedSystem.systemId)
                        ?.operations.includes("dump_rom")
                    }
                    detecting={detecting}
                    busy={
                      dumpJob.state !== "idle" &&
                      dumpJob.state !== "error" &&
                      dumpJob.state !== "aborted"
                    }
                    onStartDump={handleStartDump}
                    hotSwap={hotSwap}
                    compatibilityNote={connection.deviceInfo?.compatibilityNote}
                  />
                )}
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
                    hotSwap={hotSwap}
                    saveOnly={
                      !connection.driver?.capabilities
                        .find((c) => c.systemId === selectedSystem?.systemId)
                        ?.operations.includes("dump_rom")
                    }
                    summary={
                      dumpJob.result.rom
                        ? (selectedSystem?.summarizeDump?.(
                            dumpJob.result.rom.data,
                          ) ?? null)
                        : null
                    }
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
