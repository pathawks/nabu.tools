/**
 * INL Retro Programmer — NES/Famicom device driver.
 *
 * Drives the shared, device-agnostic NES mapper catalog
 * (`@/lib/systems/nes/mappers`) through `InlNesBus`, which adapts the
 * generic CPU/PPU bus primitives to INL's firmware dump protocol.
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
import type { INLDevice } from "./inl-device";
import type { InlTransport } from "./inl-transport";
import { IO, MEM, MAPVAR } from "./inl-opcodes";
import { dumpRegion } from "./inl-dump";
import { InlNesBus } from "./inl-nes-bus";
import { detectCiramMirroring } from "./detect-mirroring";
import { getNesMapper } from "@/lib/systems/nes/mappers";

export class INLDriver implements DeviceDriver {
  readonly id = "inl-retro";
  readonly name = "INL Retro Programmer";
  readonly capabilities: DeviceCapability[] = [
    {
      systemId: "nes",
      operations: ["dump_rom"],
      autoDetect: true,
    },
  ];

  private events: Partial<DeviceDriverEvents> = {};
  /**
   * The connection transport, exposed so the generic connection lifecycle
   * (Disconnect, page unload) can close the device. `inlDevice` is its
   * underlying control-transfer wrapper, which the dump paths drive.
   */
  readonly transport: InlTransport;
  readonly inlDevice: INLDevice;

  constructor(transport: InlTransport) {
    this.transport = transport;
    this.inlDevice = transport.device;
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
    this.log("Initializing NES mode...");

    await this.inlDevice.io(IO.IO_RESET);
    await this.inlDevice.io(IO.NES_INIT);

    this.log("Device ready");

    return {
      firmwareVersion: this.inlDevice.firmwareVersion,
      deviceName: this.inlDevice.productName,
      capabilities: this.capabilities,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    this.log("Detecting cartridge...");

    let mirroring = "unknown";
    try {
      mirroring = await detectCiramMirroring(this.inlDevice);
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

    const mapper = getNesMapper(mapperId);
    if (!mapper) throw new Error(`Unsupported mapper: ${mapperId}`);

    // Each mapper drives the cart through the bus; `bus.setup()` (issued
    // inside the mapper before each region) handles the reset/init. The
    // signal rides along so an abort interrupts per chunk, not per region.
    const bus = new InlNesBus(this.inlDevice, signal);
    const startTime = Date.now();
    const totalBytes = (prgKB + chrKB) * 1024;

    let prgData: Uint8Array;
    let chrData: Uint8Array = new Uint8Array(0);
    try {
      // Dump PRG-ROM
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

      // Dump CHR-ROM (if present)
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
    } finally {
      // Always reset the device, including when an abort or error unwinds the
      // dump. dumpRegion already resets the operation engine on its way out;
      // this restores the I/O/bus layer so the *next* dump starts from a known
      // state instead of inheriting a half-configured bus. Best-effort so a
      // reset failure (e.g. the device was unplugged) doesn't mask the cause.
      try {
        await this.inlDevice.io(IO.IO_RESET);
      } catch {
        /* best-effort cleanup */
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.log(
      `ROM read complete (${prgData.length + chrData.length} bytes in ${elapsed}s)`,
    );

    // Return PRG + CHR concatenated (system handler adds the iNES header)
    const result = new Uint8Array(prgData.length + chrData.length);
    result.set(prgData, 0);
    result.set(chrData, prgData.length);
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

    const bus = new InlNesBus(this.inlDevice, signal);
    this.log(`Reading ${sramKB}KB SRAM...`);

    let data: Uint8Array;
    try {
      if (mapper.dumpSave) {
        data = await mapper.dumpSave(bus, sramKB);
      } else {
        // Default path: enable WRAM (where the mapper supports it) and read
        // the $6000-$7FFF PRG-RAM window directly.
        await bus.setup();
        if (mapper.enableSram) await mapper.enableSram(bus);
        data = await dumpRegion(this.inlDevice, {
          sizeKB: sramKB,
          memType: MEM.PRGRAM,
          mapper: 0,
          mapVar: MAPVAR.NOVAR,
          signal,
        });
      }
    } finally {
      // Reset on every exit, including an error mid-read, so the next dump
      // isn't left inheriting a half-configured SRAM-enabled bus state.
      try {
        await this.inlDevice.io(IO.IO_RESET);
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
