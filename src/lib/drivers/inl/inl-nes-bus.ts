/**
 * `NesBus` adapter for the INL Retro Programmer. Translates the
 * generic CPU/PPU bus primitives into INL's firmware-driven
 * double-buffered dump protocol (`dumpRegion`) and dictionary opcodes
 * (`NES_CPU_WR`).
 */

import type { NesBus, BusProgressCb } from "@/lib/systems/nes/bus";
import type { INLDevice } from "./inl-device";
import { IO, MEM, MAPVAR, NES } from "./inl-opcodes";
import { dumpRegion } from "./inl-dump";

export class InlNesBus implements NesBus {
  private readonly device: INLDevice;

  constructor(device: INLDevice) {
    this.device = device;
  }

  async setup(): Promise<void> {
    await this.device.io(IO.IO_RESET);
    await this.device.io(IO.NES_INIT);
  }

  async writeCpu(addr: number, value: number): Promise<void> {
    await this.device.nes(NES.NES_CPU_WR, addr, value);
  }

  // Optional `NesBus.writeSerialRegister` capability. MMC1's five-write
  // serial load needs correct per-write bus timing, which individual CPU
  // writes over USB don't reliably provide; the firmware's NES_MMC1_WR
  // opcode performs the whole shift-in atomically. Implementing this is all
  // it takes for the shared `mmc1` mapper to clock the shift register
  // through firmware instead of per-bit writes.
  async writeSerialRegister(addr: number, value: number): Promise<void> {
    await this.device.nes(NES.NES_MMC1_WR, addr, value);
  }

  async readCpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    // INL's `dumpRegion` takes an "addr_page" hint that maps to the high
    // nibble of the read address: $8000 → 0x08, $C000 → 0x0C, etc.
    // The CPU $6000–$7FFF SRAM window goes through PRGRAM instead.
    if (length === 0) return new Uint8Array(0);
    if (length % 1024 !== 0) {
      throw new Error(
        `InlNesBus.readCpu requires multiple-of-1KB length; got ${length}`,
      );
    }
    const sizeKB = length / 1024;

    if (addr === 0x6000) {
      return dumpRegion(this.device, {
        sizeKB,
        memType: MEM.PRGRAM,
        mapper: 0,
        mapVar: MAPVAR.NOVAR,
        onProgress,
      });
    }

    const addrPage = (addr >>> 12) & 0x0f;
    if (addr !== addrPage << 12) {
      throw new Error(
        `InlNesBus.readCpu requires 4 KiB-aligned addr; got $${addr.toString(16)}`,
      );
    }
    return dumpRegion(this.device, {
      sizeKB,
      memType: MEM.NESCPU_4KB,
      mapper: addrPage,
      mapVar: MAPVAR.NOVAR,
      onProgress,
    });
  }

  async readPpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    if (length % 1024 !== 0) {
      throw new Error(
        `InlNesBus.readPpu requires multiple-of-1KB length; got ${length}`,
      );
    }
    // PPU reads always start at $0000 in INL's firmware — it streams
    // sequentially from there for the requested length.
    if (addr !== 0x0000) {
      throw new Error(
        `InlNesBus.readPpu only supports addr=$0000; got $${addr.toString(16)}`,
      );
    }
    return dumpRegion(this.device, {
      sizeKB: length / 1024,
      memType: MEM.NESPPU_1KB,
      mapper: 0x00,
      mapVar: MAPVAR.NOVAR,
      onProgress,
    });
  }
}
