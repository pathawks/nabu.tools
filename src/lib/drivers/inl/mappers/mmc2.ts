/**
 * MMC2/PxROM (Mapper 9) — Nintendo MMC2, used by Punch-Out!!
 *
 * PRG-ROM: 8KB switchable at $8000 + fixed 24KB at $A000-$FFFF
 * CHR-ROM: 4KB switchable via latch at $0000 and $1000
 *
 * Bank registers:
 *   $A000: PRG-ROM 8KB bank select ($8000-$9FFF)
 *   $B000: CHR-ROM 4KB bank select (PPU $0000, $0FD8 latch)
 *   $C000: CHR-ROM 4KB bank select (PPU $0000, $0FE8 latch)
 *   $D000: CHR-ROM 4KB bank select (PPU $1000, $1FD8 latch)
 *   $E000: CHR-ROM 4KB bank select (PPU $1000, $1FE8 latch)
 *   $F000: Mirroring (bit 0: 0=vertical, 1=horizontal)
 *
 * Reference: host/scripts/nes/mmc2.lua
 */

import type { NesMapper } from "./types";
import { dumpRegion } from "../inl-dump";
import { NES, MEM, MAPVAR } from "../inl-opcodes";
import { detectCiramMirroring } from "./detect-mirroring";

/**
 * Address page values for the dump engine.
 * NESCPU_PAGE mapper byte specifies A15-A8: 0x80 = $8000.
 * NESPPU_PAGE mapper byte specifies A13-A8: 0x00 = $0000.
 */
const ADDR_PAGE = {
  PRG_8000: 0x80,
  CHR_0000: 0x00,
} as const;

const KB_PER_PRG_BANK = 8;
const KB_PER_CHR_READ = 8;

export const mmc2: NesMapper = {
  id: 9,
  name: "MMC2",
  defaultPrgSizes: [128],
  defaultChrSizes: [128],

  detectMirroring: detectCiramMirroring,

  async dumpPrgRom(device, sizeKB, onProgress) {
    const numBanks = sizeKB / KB_PER_PRG_BANK;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let bank = 0; bank < numBanks; bank++) {
      // Select 8KB PRG bank at $8000
      await device.nes(NES.NES_CPU_WR, 0xa000, bank);

      const chunk = await dumpRegion(device, {
        sizeKB: KB_PER_PRG_BANK,
        memType: MEM.NESCPU_PAGE,
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

    const numReads = sizeKB / KB_PER_CHR_READ;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let i = 0; i < numReads; i++) {
      // Set both latch registers for lower 4KB (PPU $0000)
      await device.nes(NES.NES_CPU_WR, 0xb000, i * 2);
      await device.nes(NES.NES_CPU_WR, 0xc000, i * 2);
      // Set both latch registers for upper 4KB (PPU $1000)
      await device.nes(NES.NES_CPU_WR, 0xd000, i * 2 + 1);
      await device.nes(NES.NES_CPU_WR, 0xe000, i * 2 + 1);

      const chunk = await dumpRegion(device, {
        sizeKB: KB_PER_CHR_READ,
        memType: MEM.NESPPU_PAGE,
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
