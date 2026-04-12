/**
 * FME-7/Sunsoft 5B (Mapper 69) — Sunsoft FME-7, used by Batman: Return of the Joker.
 *
 * PRG-ROM: 4x 8KB banks, register pair $8000/$A000
 * CHR-ROM: 8x 1KB banks, register pair $8000/$A000
 *
 * Register interface:
 *   $8000: Command register (selects which internal register to write)
 *   $A000: Parameter register (value to write to the selected register)
 *
 * Command register values:
 *   $00-$07: CHR bank select (1KB each for PPU $0000-$1FFF)
 *   $08: PRG bank at $6000 (bit 6 = RAM enable, bit 7 = RAM select)
 *   $09: PRG-ROM 8KB bank at $8000
 *   $0A: PRG-ROM 8KB bank at $A000
 *   $0B: PRG-ROM 8KB bank at $C000
 *   $0C: Mirroring control (0=vert, 1=horz, 2=1scnA, 3=1scnB)
 *
 * Reference: host/scripts/nes/fme7.lua
 */

import type { INLDevice } from "../inl-device";
import type { NesMapper } from "./types";
import { dumpRegion } from "../inl-dump";
import { NES, MEM, MAPVAR } from "../inl-opcodes";
import { detectCiramMirroring } from "./detect-mirroring";

/**
 * Address page values for the dump engine.
 * NESCPU_4KB: mapper bits 3-0 specify A12-A15; 0x08 = $8000.
 * NESPPU_1KB: 0x00 = $0000.
 */
const ADDR_PAGE = {
  PRG_8000: 0x08,
  CHR_0000: 0x00,
} as const;

const KB_PER_PRG_READ = 16;
const KB_PER_CHR_READ = 2;

/** Initialize FME-7 into a known state for dumping. */
async function initMapper(device: INLDevice): Promise<void> {
  // Disable WRAM, map PRG-ROM to $6000
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x08);
  await device.nes(NES.NES_CPU_WR, 0xa000, 0x00);

  // Vertical mirroring
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x0c);
  await device.nes(NES.NES_CPU_WR, 0xa000, 0x00);

  // CHR banks: identity mapping (bank 0-7 -> PPU $0000-$1FFF)
  for (let i = 0; i < 8; i++) {
    await device.nes(NES.NES_CPU_WR, 0x8000, i);
    await device.nes(NES.NES_CPU_WR, 0xa000, i);
  }

  // PRG banks: identity mapping
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x09);
  await device.nes(NES.NES_CPU_WR, 0xa000, 0x00);
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x0a);
  await device.nes(NES.NES_CPU_WR, 0xa000, 0x01);
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x0b);
  await device.nes(NES.NES_CPU_WR, 0xa000, 0x02);
}

export const fme7: NesMapper = {
  id: 69,
  name: "FME-7",
  defaultPrgSizes: [256, 128],
  defaultChrSizes: [256, 128],

  detectMirroring: detectCiramMirroring,

  async dumpPrgRom(device, sizeKB, onProgress) {
    await initMapper(device);

    const numReads = sizeKB / KB_PER_PRG_READ;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let i = 0; i < numReads; i++) {
      // Select two consecutive 8KB banks to fill $8000-$BFFF
      await device.nes(NES.NES_CPU_WR, 0x8000, 0x09);
      await device.nes(NES.NES_CPU_WR, 0xa000, i * 2);
      await device.nes(NES.NES_CPU_WR, 0x8000, 0x0a);
      await device.nes(NES.NES_CPU_WR, 0xa000, i * 2 + 1);

      const chunk = await dumpRegion(device, {
        sizeKB: KB_PER_PRG_READ,
        memType: MEM.NESCPU_4KB,
        mapper: ADDR_PAGE.PRG_8000,
        mapVar: MAPVAR.NOVAR,
      });

      result.set(chunk, bytesRead);
      bytesRead += chunk.length;
      onProgress?.(bytesRead, sizeKB * 1024);
    }

    return result;
  },

  async dumpChrRom(device, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);

    await initMapper(device);

    const numReads = sizeKB / KB_PER_CHR_READ;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let i = 0; i < numReads; i++) {
      // Select two consecutive 1KB CHR banks at $0000-$07FF
      await device.nes(NES.NES_CPU_WR, 0x8000, 0x00);
      await device.nes(NES.NES_CPU_WR, 0xa000, i * 2);
      await device.nes(NES.NES_CPU_WR, 0x8000, 0x01);
      await device.nes(NES.NES_CPU_WR, 0xa000, i * 2 + 1);

      const chunk = await dumpRegion(device, {
        sizeKB: KB_PER_CHR_READ,
        memType: MEM.NESPPU_1KB,
        mapper: ADDR_PAGE.CHR_0000,
        mapVar: MAPVAR.NOVAR,
      });

      result.set(chunk, bytesRead);
      bytesRead += chunk.length;
      onProgress?.(bytesRead, sizeKB * 1024);
    }

    return result;
  },
};
