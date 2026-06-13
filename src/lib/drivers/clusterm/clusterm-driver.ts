/**
 * Famicom Dumper/Writer (ClusterM) — NES/Famicom device driver.
 *
 * Drives the shared, device-agnostic NES mapper catalog
 * (`@/lib/systems/nes/mappers`) through `ClusterMNesBus`. Unlike the
 * INL Retro, this hardware free-runs M2 as a continuous ~1.8 MHz clock
 * from power-on, so no catalog mapper is pre-flight-rejected — including
 * the CPLD multicart boards (268/470) that need sustained M2 clocking.
 */

/**
 * Field note — an independent board variant in the wild (2026-06-13).
 *
 * ClusterM's Famicom Dumper/Writer is an open hardware design, and
 * independent builds of it are sold (e.g. on AliExpress). This driver was
 * exercised against one such build — a respin by GitHub user @hualazimo7:
 * Famicom-slot only, a power-latch button, and (on at least one unit) the
 * status LED's red/green channels swapped in hardware. It runs a RECOMPILE
 * of ClusterM's 3.4.0 (not the stock release binary). Its builder could
 * not get ClusterM's stock open-source bootloader's USB mass-storage
 * ("U-drive") update mode to enumerate on these boards, so he modified the
 * bootloader and abandoned that entry path — and was kind enough to
 * explain all of this when asked (see the issue below). We did NOT
 * determine why stock MSD won't enumerate here: the bootloader's USB
 * descriptors and 48 MHz USB clock config are byte-identical to stock,
 * which rules out the firmware and points to an (undetermined)
 * board-level cause. Practical upshot: shorting cart /IRQ to GND does
 * nothing useful on this variant — load custom firmware over the rear
 * SWD pads (ST-Link / OpenOCD) instead.
 * The CDC dump firmware is ClusterM 3.4.0 recompiled and drives the full
 * mapper catalog normally; this note just spares the next person from
 * chasing a "bootloader won't enter" ghost.
 *
 * Investigation, SWD backup + firmware analysis:
 *   https://github.com/hualazimo7/retro-console-mod-collection/issues/2
 *
 * sha256 of firmware pulled from one such unit, vs ClusterM stock 3.4
 * (carve the regions from a 512 KB SWD flash dump to reproduce):
 *   bootloader    33648 B @ 0x08000000
 *     @hualazimo7: 8a75e516f6c5c0c6e3d2a762eff384ea2200cbb2a5091a6d5a558747f7b15f3a
 *     stock 3.4  : 34d24e523f9560fb72aefdedba6e8b47fd06f33e756845d425e8116b2cdb6122
 *   dump firmware 30336 B @ 0x08040000
 *     @hualazimo7: dca3343f131ec3e8ba1a330b3b85166b6d985db36f58ae2a13f5c0777f32cdf7
 *     stock 3.4  : a32d22e2eda6db9daa02617050a3243671aedd5a4b93e68fc02562e082106362
 *   full 512 KB flash image @hualazimo7:
 *     fabd7d7d012cfa3c9e3d8aa947cf7e825e1f1771a29dc0e42cf2caf180a19e64
 */

import type {
  DeviceDriver,
  DeviceDriverEvents,
  DeviceInfo,
  DeviceCapability,
  DetectSystemResult,
  CartridgeInfo,
  ReadConfig,
  DumpProgress,
  SystemId,
} from "@/lib/types";
import type { SerialTransport } from "@/lib/transport/serial-transport";
import { ClusterMProtocol } from "./clusterm-protocol";
import { ClusterMNesBus } from "./clusterm-bus";
import { getNesMapper } from "@/lib/systems/nes/mappers";

/**
 * Decode the 4-byte CIRAM A10 probe (nametables $2000/$2400/$2800/$2C00)
 * into the same vocabulary the INL driver reports. Solder-pad and
 * mapper-controlled boards that match none of the fixed patterns read as
 * "unknown". A 1-byte reply (ancient firmware) carries only V-vs-H.
 */
export function decodeMirroring(raw: boolean[]): string {
  if (raw.length === 1) return raw[0] ? "vertical" : "horizontal";
  if (raw.length !== 4) return "unknown";
  const pattern = raw.map((v) => (v ? "1" : "0")).join("");
  switch (pattern) {
    case "0011":
      return "horizontal";
    case "0101":
      return "vertical";
    case "0000":
      return "one_screen_a";
    case "1111":
      return "one_screen_b";
    default:
      return "unknown";
  }
}

/**
 * Catalog mappers this device cannot fully dump, with the reason shown to
 * the user. Mapper 413 (BATMAP) carries an 8 MiB serial sample flash whose
 * SPI read this device's stock firmware cannot pace — the CDC buffer flush
 * shears the bit phase mid-stream (see the note in clusterm-bus.ts). PRG
 * and CHR dump fine, but a cartridge dump missing that 8 MiB section is
 * incomplete, so the whole mapper is refused rather than writing a partial
 * file. The key set also feeds `capability.unsupportedMappers`, which greys
 * the option out in the config UI.
 */
const UNSUPPORTED_MAPPERS = new Map<number, string>([
  [
    413,
    "BATMAP (mapper 413) carries an 8 MiB serial sample flash this device's " +
      "stock firmware cannot pace, so the cartridge cannot be fully dumped " +
      "here (only its PRG and CHR, which would be an incomplete dump).",
  ],
]);

export class ClusterMDriver implements DeviceDriver {
  readonly id = "clusterm";
  readonly name = "ClusterM Famicom Dumper/Writer";
  readonly capabilities: DeviceCapability[] = [
    {
      systemId: "nes",
      operations: ["dump_rom", "dump_save"],
      autoDetect: true,
      unsupportedMappers: [...UNSUPPORTED_MAPPERS.keys()],
    },
  ];

  private events: Partial<DeviceDriverEvents> = {};
  readonly transport: SerialTransport;
  private readonly protocol: ClusterMProtocol;

  constructor(transport: SerialTransport) {
    this.transport = transport;
    this.protocol = new ClusterMProtocol(transport);
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  private log(message: string, level: "info" | "warn" | "error" = "info") {
    this.events.onLog?.(message, level);
  }

  private progress(p: DumpProgress) {
    this.events.onProgress?.(p);
  }

  async initialize(): Promise<DeviceInfo> {
    this.log("Initializing dumper...");

    const info = await this.protocol.init();
    this.log(`Device ready (protocol v${info.protocolVersion})`);
    if (info.protocolVersion < 5) {
      // Protocol 5 = firmware 3.2+ (Nov 2022); later 3.x releases fixed
      // flash-write and FDS bugs. The dump paths here only need the
      // PRG/CHR primitives, so old firmware still works — but say so.
      this.log(
        "Firmware predates protocol v5 — consider updating " +
          "(drop the release .bin/.svf onto the device's bootloader drive)",
        "warn",
      );
    }

    return {
      firmwareVersion: info.firmwareVersion ?? `protocol v${info.protocolVersion}`,
      hardwareRevision: info.hardwareVersion,
      deviceName: this.name,
      capabilities: this.capabilities,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    this.log("Detecting cartridge...");

    let mirroring = "unknown";
    try {
      mirroring = decodeMirroring(await this.protocol.getMirroringRaw());
    } catch (e) {
      this.log(
        `Mirroring detection failed (${(e as Error).message})`,
        "warn",
      );
    }

    return {
      systemId: "nes",
      cartInfo: {
        // NES carts carry no self-reported title; describe what detection
        // found and let the app emit the single "Detected: ..." log line
        // through the same path as title-bearing systems.
        summary: `NES cartridge (mirroring: ${mirroring})`,
        meta: { mirroring },
      },
    };
  }

  async detectCartridge(systemId: SystemId): Promise<CartridgeInfo | null> {
    if (systemId !== "nes") return null;
    const result = await this.detectSystem();
    return result?.cartInfo ?? null;
  }

  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const mapperId = (config.params.mapper as number) ?? 0;
    const prgKB = ((config.params.prgSizeBytes as number) ?? 32768) / 1024;
    const chrKB = ((config.params.chrSizeBytes as number) ?? 8192) / 1024;
    const miscKB = ((config.params.miscSizeBytes as number) ?? 0) / 1024;

    const mapper = getNesMapper(mapperId);
    if (!mapper) throw new Error(`Unsupported mapper: ${mapperId}`);
    const unsupported = UNSUPPORTED_MAPPERS.get(mapperId);
    if (unsupported) throw new Error(unsupported);

    // Each mapper drives the cart through the bus; `bus.setup()` (issued
    // inside the mapper before each region) performs the console-reset.
    // The signal rides along so an abort interrupts per chunk.
    const bus = new ClusterMNesBus(this.protocol, signal);
    const startTime = Date.now();
    const totalBytes = (prgKB + chrKB + miscKB) * 1024;

    let prgData: Uint8Array;
    let chrData: Uint8Array = new Uint8Array(0);
    let miscData: Uint8Array = new Uint8Array(0);
    try {
      this.log(`Reading ${prgKB}KB PRG-ROM...`);
      signal?.throwIfAborted();

      prgData = await mapper.dumpPrgRom(bus, prgKB, (bytesRead) => {
        const elapsed = (Date.now() - startTime) / 1000;
        this.progress({
          phase: "rom",
          bytesRead,
          totalBytes,
          fraction: bytesRead / totalBytes,
          speed: elapsed > 0 ? bytesRead / elapsed : undefined,
        });
      });

      if (chrKB > 0) {
        this.log(`Reading ${chrKB}KB CHR-ROM...`);
        signal?.throwIfAborted();

        chrData = await mapper.dumpChrRom(bus, chrKB, (bytesRead) => {
          const elapsed = (Date.now() - startTime) / 1000;
          const totalRead = prgKB * 1024 + bytesRead;
          this.progress({
            phase: "rom",
            bytesRead: totalRead,
            totalBytes,
            fraction: totalRead / totalBytes,
            speed: elapsed > 0 ? totalRead / elapsed : undefined,
          });
        });
      }

      // Dump the miscellaneous-ROM area (mapper 413's sample flash) —
      // the NES 2.0 file section appended after CHR.
      if (miscKB > 0) {
        if (!mapper.dumpMiscRom) {
          throw new Error(
            `Mapper ${mapperId} (${mapper.name}) declares a miscellaneous ROM but supplies no dump path for it`,
          );
        }
        this.log(`Reading ${miscKB}KB miscellaneous ROM...`);
        signal?.throwIfAborted();

        miscData = await mapper.dumpMiscRom(bus, miscKB, (bytesRead) => {
          const elapsed = (Date.now() - startTime) / 1000;
          const totalRead = (prgKB + chrKB) * 1024 + bytesRead;
          this.progress({
            phase: "rom",
            bytesRead: totalRead,
            totalBytes,
            fraction: totalRead / totalBytes,
            speed: elapsed > 0 ? totalRead / elapsed : undefined,
          });
        });
      }
    } finally {
      // Leave the cart in power-on state on every exit, including abort
      // or error, so the next dump can't inherit half-latched banks.
      // Best-effort so a reset failure (e.g. the device was unplugged)
      // doesn't mask the original cause.
      try {
        await this.protocol.reset();
      } catch {
        /* best-effort cleanup */
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.log(
      `ROM read complete (${prgData.length + chrData.length + miscData.length} bytes in ${elapsed}s)`,
    );

    // Return PRG + CHR + misc concatenated in NES 2.0 file order (the
    // system handler prepends the header).
    const result = new Uint8Array(
      prgData.length + chrData.length + miscData.length,
    );
    result.set(prgData, 0);
    result.set(chrData, prgData.length);
    result.set(miscData, prgData.length + chrData.length);
    return result;
  }

  async readSave(
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const mapperId = (config.params.mapper as number) ?? 0;
    const sramKB = ((config.params.prgRamSizeBytes as number) ?? 8192) / 1024;

    if (sramKB <= 0) throw new Error("No SRAM to read");

    const mapper = getNesMapper(mapperId);
    if (!mapper) throw new Error(`Unsupported mapper: ${mapperId}`);

    const bus = new ClusterMNesBus(this.protocol, signal);
    this.log(`Reading ${sramKB}KB SRAM...`);

    let data: Uint8Array;
    try {
      if (mapper.dumpSave) {
        data = await mapper.dumpSave(bus, sramKB);
      } else {
        // Default path: enable WRAM (where the mapper supports it) and
        // read the $6000-$7FFF PRG-RAM window directly.
        await bus.setup();
        if (mapper.enableSram) await mapper.enableSram(bus);
        data = await bus.readCpu(0x6000, sramKB * 1024);
      }
    } finally {
      // Reset on every exit so the next dump isn't left inheriting an
      // SRAM-enabled bus state.
      try {
        await this.protocol.reset();
      } catch {
        /* best-effort cleanup */
      }
    }

    this.log(`SRAM read complete (${data.length} bytes)`);
    return data;
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("Save RAM writing not yet implemented");
  }
}
