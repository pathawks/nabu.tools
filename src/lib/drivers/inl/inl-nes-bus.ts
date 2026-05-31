/**
 * `NesBus` adapter for the INL Retro Programmer. Translates the generic
 * CPU/PPU bus primitives into INL's firmware-driven dump protocol and
 * dictionary opcodes (`NES_CPU_WR`).
 *
 * The firmware can't bank-switch our mappers, so banking is host-driven in the
 * shared mapper layer: a mapper selects a bank (`writeCpu`/`writeSerialRegister`)
 * then reads a fixed window (`readCpu`/`readPpu`). Consecutive reads in a bank
 * walk share the same firmware addressing (`memType`, `mapper`, `mapVar`), so
 * this bus keeps a per-region "session": it allocates and configures the
 * buffers once, then per same-config read only re-zeros `page_num` and
 * re-`STARTDUMP`s, instead of re-allocating every bank. A differing config —
 * or a `setup()` (region boundary) — ends the session and re-allocates.
 */

import type { NesBus, BusProgressCb } from "@/lib/systems/nes/bus";
import type { INLDevice } from "./inl-device";
import { IO, MEM, MAPVAR, NES } from "./inl-opcodes";
import {
  allocateRegion,
  rewindRegion,
  streamRegion,
  DEFAULT_LAYOUT,
  type BufferLayout,
  type RegionCfg,
} from "./inl-dump";

export class InlNesBus implements NesBus {
  private readonly device: INLDevice;
  private readonly layout: BufferLayout;
  /** The currently-allocated region config, or null when no buffers are live. */
  private session: RegionCfg | null = null;

  constructor(device: INLDevice, layout: BufferLayout = DEFAULT_LAYOUT) {
    this.device = device;
    this.layout = layout;
  }

  async setup(): Promise<void> {
    await this.device.io(IO.IO_RESET);
    await this.device.io(IO.NES_INIT);
    // A region boundary: the next read re-allocates (its allocateRegion frees
    // any buffers still live in firmware).
    this.session = null;
  }

  async writeCpu(addr: number, value: number): Promise<void> {
    await this.device.nes(NES.NES_CPU_WR, addr, value);
  }

  // Optional `NesBus.writeSerialRegister` capability. MMC1's five-write serial
  // load needs correct per-write bus timing, which individual CPU writes over
  // USB don't reliably provide; the firmware's NES_MMC1_WR opcode performs the
  // whole shift-in atomically.
  async writeSerialRegister(addr: number, value: number): Promise<void> {
    await this.device.nes(NES.NES_MMC1_WR, addr, value);
  }

  async readCpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    // INL's read takes an "addr_page" hint that maps to the high nibble of the
    // read address: $8000 → 0x08, $C000 → 0x0C, etc. The CPU $6000–$7FFF SRAM
    // window goes through PRGRAM instead.
    if (length === 0) return new Uint8Array(0);
    this.assertKB(length, "readCpu");
    const sizeKB = length / 1024;

    if (addr === 0x6000) {
      return this.read(
        { memType: MEM.PRGRAM, mapper: 0, mapVar: MAPVAR.NOVAR },
        sizeKB,
        onProgress,
      );
    }

    const addrPage = (addr >>> 12) & 0x0f;
    if (addr !== addrPage << 12) {
      throw new Error(
        `InlNesBus.readCpu requires 4 KiB-aligned addr; got $${addr.toString(16)}`,
      );
    }
    return this.read(
      { memType: MEM.NESCPU_4KB, mapper: addrPage, mapVar: MAPVAR.NOVAR },
      sizeKB,
      onProgress,
    );
  }

  async readPpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    this.assertKB(length, "readPpu");
    // PPU reads always start at $0000 in INL's firmware — it streams
    // sequentially from there for the requested length.
    if (addr !== 0x0000) {
      throw new Error(
        `InlNesBus.readPpu only supports addr=$0000; got $${addr.toString(16)}`,
      );
    }
    return this.read(
      { memType: MEM.NESPPU_1KB, mapper: 0x00, mapVar: MAPVAR.NOVAR },
      length / 1024,
      onProgress,
    );
  }

  /**
   * Read one region's window, reusing the live buffer allocation when its
   * config is unchanged (a bank walk) and re-allocating otherwise.
   */
  private async read(
    cfg: RegionCfg,
    sizeKB: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    if (this.session && sameCfg(this.session, cfg)) {
      await rewindRegion(this.device, this.layout);
    } else {
      await allocateRegion(this.device, cfg, this.layout);
      this.session = cfg;
    }
    return streamRegion(this.device, sizeKB, this.layout, onProgress);
  }

  private assertKB(length: number, method: string): void {
    if (length % 1024 !== 0) {
      throw new Error(
        `InlNesBus.${method} requires a multiple-of-1KB length; got ${length}`,
      );
    }
  }
}

function sameCfg(a: RegionCfg, b: RegionCfg): boolean {
  return (
    a.memType === b.memType && a.mapper === b.mapper && a.mapVar === b.mapVar
  );
}
