/**
 * INL Retro Programmer — NES/Famicom device driver.
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
import { INLDevice } from "./inl-device";
import { IO, MEM, MAPVAR } from "./inl-opcodes";
import { dumpRegion } from "./inl-dump";
import { nrom } from "./mappers/nrom";
import { mmc1 } from "./mappers/mmc1";
import { unrom } from "./mappers/unrom";
import { cnrom } from "./mappers/cnrom";
import { mmc3 } from "./mappers/mmc3";
import { mmc5 } from "./mappers/mmc5";
import { axrom, bnrom } from "./mappers/bnrom";
import { mmc2 } from "./mappers/mmc2";
import { mmc4 } from "./mappers/mmc4";
import { fme7 } from "./mappers/fme7";
import type { NesMapper } from "./mappers/types";

const MAPPERS: Record<number, NesMapper> = {
  0: nrom,
  1: mmc1,
  2: unrom,
  3: cnrom,
  4: mmc3,
  5: mmc5,
  7: axrom,
  9: mmc2,
  10: mmc4,
  34: bnrom,
  69: fme7,
};

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
  readonly inlDevice: INLDevice;

  constructor(inlDevice: INLDevice) {
    this.inlDevice = inlDevice;
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
      mirroring = await nrom.detectMirroring(this.inlDevice);
    } catch (e) {
      this.log(
        `Mirroring detection not supported (${(e as Error).message})`,
        "warn",
      );
    }

    this.log(`Detected: NES cartridge (mirroring: ${mirroring})`);

    return {
      systemId: "nes",
      cartInfo: {
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

    const mapper = MAPPERS[mapperId];
    if (!mapper) throw new Error(`Unsupported mapper: ${mapperId}`);

    // Re-init NES mode before dump
    await this.inlDevice.io(IO.IO_RESET);
    await this.inlDevice.io(IO.NES_INIT);

    const startTime = Date.now();
    const totalBytes = (prgKB + chrKB) * 1024;

    // Dump PRG-ROM
    this.log(`Reading ${prgKB}KB PRG-ROM...`);
    signal?.throwIfAborted();

    const prgData = await mapper.dumpPrgRom(
      this.inlDevice,
      prgKB,
      (bytesRead) => {
        const elapsed = (Date.now() - startTime) / 1000;
        this.progress({
          phase: "rom",
          bytesRead,
          totalBytes,
          fraction: bytesRead / totalBytes,
          speed: elapsed > 0 ? bytesRead / elapsed : undefined,
        });
      },
    );

    // Dump CHR-ROM (if present)
    let chrData: Uint8Array = new Uint8Array(0);
    if (chrKB > 0) {
      this.log(`Reading ${chrKB}KB CHR-ROM...`);
      signal?.throwIfAborted();

      chrData = await mapper.dumpChrRom(this.inlDevice, chrKB, (bytesRead) => {
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

    // Reset device
    await this.inlDevice.io(IO.IO_RESET);

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
    _signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const mapperId = (config.params.mapper as number) ?? 0;
    const sramKB = ((config.params.prgRamSizeBytes as number) ?? 8192) / 1024;

    if (sramKB <= 0) throw new Error("No SRAM to read");

    const mapper = MAPPERS[mapperId];
    if (!mapper) throw new Error(`Unsupported mapper: ${mapperId}`);

    // Re-init and enable WRAM access
    await this.inlDevice.io(IO.IO_RESET);
    await this.inlDevice.io(IO.NES_INIT);
    if (mapper.enableSram) await mapper.enableSram(this.inlDevice);

    this.log(`Reading ${sramKB}KB SRAM...`);
    const data = await dumpRegion(this.inlDevice, {
      sizeKB: sramKB,
      memType: MEM.PRGRAM,
      mapper: 0,
      mapVar: MAPVAR.NOVAR,
    });

    await this.inlDevice.io(IO.IO_RESET);
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
