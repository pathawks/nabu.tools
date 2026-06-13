/**
 * Kazzo — NES/Famicom device driver.
 *
 * Drives the shared, device-agnostic NES mapper catalog
 * (`@/lib/systems/nes/mappers`) through `KazzoNesBus`, which adapts the
 * generic CPU/PPU bus primitives to the Kazzo firmware's per-byte
 * read/write requests. Runs on kazzo hardware or on an AVR-based INL Retro
 * board (v1.x, pre-2018) reflashed with the Kazzo firmware.
 *
 * The device/protocol layer is reimplemented from the documented Kazzo
 * protocol. Hardware-validated over WebUSB on the INL-distributed clipped
 * build of the 2010-01 firmware (NROM, MMC3, and — that build idles M2
 * high — the CPLD mappers 268 and 470, byte-perfect against references).
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
import type { KazzoDevice } from "./kazzo-device";
import type { KazzoTransport } from "./kazzo-transport";
import { KazzoNesBus } from "./kazzo-nes-bus";
import { detectKazzoMirroring } from "./detect-mirroring";
// Catalog mappers gated on the firmware's M2 idle level (the SMD172-family
// CPLD boards need M2 to idle high; post-2010-01-24 Kazzo builds idle it
// low). The gate is classified per connection from the firmware version
// fingerprint in initialize(); when closed, the affected mappers are greyed
// out in the config UI and pre-flight-rejected in readROM/readSave.
import {
  M2_IDLE_GATED_MAPPERS,
  unsupportedMappersFor,
} from "./unsupported-mappers";
import { classifyKazzoFirmware } from "./firmware-m2";
import { getNesMapper } from "@/lib/systems/nes/mappers";

/** $6000-$7FFF — the battery-backed PRG-RAM (SRAM) window on the CPU bus. */
const SRAM_BASE = 0x6000;

export class KazzoDriver implements DeviceDriver {
  readonly id = "kazzo";
  readonly name = "Kazzo";
  readonly capabilities: DeviceCapability[] = [
    {
      systemId: "nes",
      operations: ["dump_rom"],
      autoDetect: true,
      // Greys these mappers out in the config UI; readROM pre-flight-
      // rejects them too. Pre-probe default assumes an M2-idle-low build;
      // initialize() re-derives this from the firmware classification.
      unsupportedMappers: [...unsupportedMappersFor(false).keys()],
    },
  ];

  /**
   * Whether the connected firmware idles M2 high between bus operations —
   * the feature the SMD172-family CPLD mappers require. Classified once per
   * connection in initialize() from the FIRMWARE_VERSION fingerprint (see
   * ./firmware-m2); false (gated) until then.
   */
  private _m2IdleHigh = false;
  get m2IdleHigh(): boolean {
    return this._m2IdleHigh;
  }
  /** Effective unsupported-mapper map for this session (see ./unsupported-mappers). */
  private unsupportedMappers = unsupportedMappersFor(false);

  private events: Partial<DeviceDriverEvents> = {};
  /**
   * The connection transport, exposed so the generic connection lifecycle
   * (Disconnect, page unload) can close the device. `kazzoDevice` is its
   * underlying control-transfer wrapper, which the dump paths drive.
   */
  readonly transport: KazzoTransport;
  readonly kazzoDevice: KazzoDevice;

  constructor(transport: KazzoTransport) {
    this.transport = transport;
    this.kazzoDevice = transport.device;
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
    this.log("Initializing Kazzo...");

    // Classify the firmware's M2 idle level from its version fingerprint.
    // FIRMWARE_VERSION is a benign flash read present in every firmware
    // era; a failed read classifies as idle-low, keeping the gate closed.
    let versionBytes: Uint8Array | null = null;
    try {
      await this.kazzoDevice.fetchFirmwareVersion();
      versionBytes = this.kazzoDevice.firmwareVersionBytes;
    } catch {
      versionBytes = null;
    }
    const firmware = classifyKazzoFirmware(versionBytes);
    this._m2IdleHigh = firmware.m2IdleHigh;
    this.unsupportedMappers = unsupportedMappersFor(firmware.m2IdleHigh);
    const nesCapability = this.capabilities.find((c) => c.systemId === "nes");
    if (nesCapability) {
      nesCapability.unsupportedMappers = [...this.unsupportedMappers.keys()];
    }
    const gatedIds = [...M2_IDLE_GATED_MAPPERS.keys()].join("/");
    this.log(
      `Firmware ${firmware.label}: M2 idles ${
        firmware.m2IdleHigh
          ? `high — CPLD mappers (${gatedIds}) enabled`
          : `low — CPLD mappers (${gatedIds}) unavailable`
      }`,
    );

    this.log("Device ready");

    return {
      firmwareVersion: firmware.label,
      deviceName: this.kazzoDevice.productName,
      capabilities: this.capabilities,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    this.log("Detecting cartridge...");

    let mirroring = "unknown";
    try {
      mirroring = await detectKazzoMirroring(this.kazzoDevice);
    } catch (e) {
      this.log(
        `Mirroring detection not supported (${(e as Error).message})`,
        "warn",
      );
    }

    return {
      systemId: "nes",
      cartInfo: {
        // NES carts carry no self-reported title; describe what detection
        // found and let the app emit the single "Detected: ..." log line.
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

  private resolveMapper(mapperId: number) {
    const mapper = getNesMapper(mapperId);
    if (!mapper) throw new Error(`Unsupported mapper: ${mapperId}`);
    const unsupportedReason = this.unsupportedMappers.get(mapperId);
    if (unsupportedReason) {
      throw new Error(
        `Mapper ${mapperId} (${mapper.name}) can't be dumped with this ` +
          `Kazzo firmware: ${unsupportedReason}. The cart itself is fine.`,
      );
    }
    return mapper;
  }

  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const mapperId = (config.params.mapper as number) ?? 0;
    const prgKB = ((config.params.prgSizeBytes as number) ?? 32768) / 1024;
    const chrKB = ((config.params.chrSizeBytes as number) ?? 8192) / 1024;

    const mapper = this.resolveMapper(mapperId);

    // The mapper drives the cart through the bus; `bus.setup()` (issued
    // inside the mapper before each region) runs PHI2_INIT. The signal rides
    // along so an abort interrupts per 256-byte page, not per region.
    const bus = new KazzoNesBus(this.kazzoDevice, signal);
    const startTime = Date.now();
    const totalBytes = (prgKB + chrKB) * 1024;

    this.log(`Reading ${prgKB}KB PRG-ROM...`);
    signal?.throwIfAborted();

    const prgData = await mapper.dumpPrgRom(bus, prgKB, (bytesRead) => {
      const elapsed = (Date.now() - startTime) / 1000;
      this.progress({
        phase: "rom",
        bytesRead,
        totalBytes,
        fraction: bytesRead / totalBytes,
        speed: elapsed > 0 ? bytesRead / elapsed : undefined,
      });
    });

    let chrData: Uint8Array = new Uint8Array(0);
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

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.log(
      `ROM read complete (${prgData.length + chrData.length} bytes in ${elapsed}s)`,
    );

    // Return PRG + CHR concatenated (system handler adds the iNES header).
    const result = new Uint8Array(prgData.length + chrData.length);
    result.set(prgData, 0);
    result.set(chrData, prgData.length);
    return result;
  }

  async readSave(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const mapperId = (config.params.mapper as number) ?? 0;
    const sramKB = ((config.params.prgRamSizeBytes as number) ?? 8192) / 1024;

    if (sramKB <= 0) throw new Error("No SRAM to read");

    const mapper = this.resolveMapper(mapperId);
    const bus = new KazzoNesBus(this.kazzoDevice, signal);
    this.log(`Reading ${sramKB}KB SRAM...`);

    let data: Uint8Array;
    if (mapper.dumpSave) {
      data = await mapper.dumpSave(bus, sramKB);
    } else {
      // Default path: enable WRAM (where the mapper supports it) and read the
      // $6000-$7FFF PRG-RAM window directly off the CPU bus.
      await bus.setup();
      if (mapper.enableSram) await mapper.enableSram(bus);
      data = await bus.readCpu(SRAM_BASE, sramKB * 1024);
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
