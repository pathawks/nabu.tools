/**
 * CNROM (Mapper 3) — fixed PRG, switchable 8KB CHR banks.
 *
 * PRG-ROM: 16KB or 32KB fixed at CPU $8000-$FFFF (no bank switching)
 * CHR-ROM: 8KB switchable banks at PPU $0000-$1FFF
 *
 * Bus conflict: CHR bank select writes go through a bank table in PRG space.
 *
 * Reference: host/scripts/nes/cnrom.lua
 */

import type { NesMapper } from "./types";
import { dumpRegion } from "../inl-dump";
import { NES, MEM, MAPVAR } from "../inl-opcodes";
import { findBankTable } from "./bus-conflict";
import { detectCiramMirroring } from "./detect-mirroring";

const ADDR_PAGE = {
  PRG_8000: 0x08,
  CHR_0000: 0x00,
} as const;

const CHR_BANK_KB = 8;

export const cnrom: NesMapper = {
  id: 3,
  name: "CNROM",
  defaultPrgSizes: [32, 16],
  defaultChrSizes: [32, 16, 8],

  detectMirroring: detectCiramMirroring,

  async dumpPrgRom(device, sizeKB, onProgress) {
    // CNROM PRG is fixed, same as NROM: read from CPU $8000
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

    const numBanks = sizeKB / CHR_BANK_KB;

    // Find bank table in PRG space ($8000-$FFFF) for bus-conflict-safe writes.
    // If no table found, fall back to direct writes (board has no bus conflicts).
    const bankTableAddr = await findBankTable(device, 0x8000, 32, numBanks);

    const totalBytes = sizeKB * 1024;
    const result = new Uint8Array(totalBytes);
    let bytesRead = 0;

    for (let bank = 0; bank < numBanks; bank++) {
      const writeAddr = bankTableAddr !== null ? bankTableAddr + bank : 0x8000;
      await device.nes(NES.NES_CPU_WR, writeAddr, bank);

      const chunk = await dumpRegion(device, {
        sizeKB: CHR_BANK_KB,
        memType: MEM.NESPPU_1KB,
        mapper: ADDR_PAGE.CHR_0000,
        mapVar: MAPVAR.NOVAR,
      });
      result.set(chunk, bytesRead);
      bytesRead += chunk.length;
      onProgress?.(bytesRead, totalBytes);
    }

    return result;
  },
};
