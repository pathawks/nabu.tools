/**
 * NROM (Mapper 0) — simplest NES mapper, no bank switching.
 *
 * PRG-ROM: 16KB or 32KB at CPU $8000-$FFFF
 * CHR-ROM: 8KB at PPU $0000-$1FFF (or CHR-RAM if 0KB)
 *
 * Reference: host/scripts/nes/nrom.lua
 */

import type { NesMapper } from "./types";
import { dumpRegion } from "../inl-dump";
import { MEM, MAPVAR } from "../inl-opcodes";
import { detectCiramMirroring } from "./detect-mirroring";

/**
 * Address page values for SET_MAP_N_MAPVAR.
 * These are NOT iNES mapper IDs — they tell the firmware which
 * address range to read from. $8000 → 0x08, $0000 → 0x00.
 */
const ADDR_PAGE = {
  PRG_8000: 0x08,
  CHR_0000: 0x00,
} as const;

export const nrom: NesMapper = {
  id: 0,
  name: "NROM",
  defaultPrgSizes: [32, 16],
  defaultChrSizes: [8, 0],

  detectMirroring: detectCiramMirroring,

  async dumpPrgRom(device, sizeKB, onProgress) {
    // NROM PRG: read from CPU $8000 (addr_page=0x08)
    return dumpRegion(device, {
      sizeKB,
      memType: MEM.NESCPU_4KB,
      mapper: ADDR_PAGE.PRG_8000,
      mapVar: MAPVAR.NOVAR,
      onProgress,
    });
  },

  async dumpChrRom(device, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);

    // NROM CHR: read from PPU $0000 (addr_page=0x00)
    return dumpRegion(device, {
      sizeKB,
      memType: MEM.NESPPU_1KB,
      mapper: ADDR_PAGE.CHR_0000,
      mapVar: MAPVAR.NOVAR,
      onProgress,
    });
  },
};
