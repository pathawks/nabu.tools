/**
 * UxROM (Mapper 2) — 16KB switchable + 16KB fixed PRG bank, CHR-RAM only.
 *
 * PRG-ROM: 16KB switchable bank at CPU $8000-$BFFF, 16KB fixed at $C000-$FFFF
 * CHR-ROM: none (CHR-RAM)
 *
 * Bus conflict: writes go through a bank table in the fixed bank ($C000-$FFFF).
 *
 * Reference: host/scripts/nes/unrom.lua
 */

import type { NesMapper } from "./types";
import { dumpRegion } from "../inl-dump";
import { NES, MEM, MAPVAR } from "../inl-opcodes";
import { findBankTable } from "./bus-conflict";
import { detectCiramMirroring } from "./detect-mirroring";

const ADDR_PAGE = {
  PRG_8000: 0x08,
  PRG_C000: 0x0c,
} as const;

const KB_PER_BANK = 16;

export const unrom: NesMapper = {
  id: 2,
  name: "UxROM",
  defaultPrgSizes: [256, 128],
  defaultChrSizes: [0],

  detectMirroring: detectCiramMirroring,

  async dumpPrgRom(device, sizeKB, onProgress) {
    const numBanks = sizeKB / KB_PER_BANK;

    // Find the bank table in the fixed bank ($C000-$FFFF).
    // Bus-conflict boards need a table [0,1,...,N-2] so the ROM data bus
    // agrees with the CPU data bus during mapper register writes.
    const bankTableAddr = await findBankTable(device, 0xc000, 16, numBanks - 1);

    const totalBytes = sizeKB * 1024;
    const result = new Uint8Array(totalBytes);
    let bytesRead = 0;

    // Dump switchable banks 0..(N-2) from $8000
    for (let bank = 0; bank < numBanks - 1; bank++) {
      // Bus-conflict-safe write through bank table, or direct write to $8000
      const writeAddr = bankTableAddr !== null ? bankTableAddr + bank : 0x8000;
      await device.nes(NES.NES_CPU_WR, writeAddr, bank);

      const chunk = await dumpRegion(device, {
        sizeKB: KB_PER_BANK,
        memType: MEM.NESCPU_4KB,
        mapper: ADDR_PAGE.PRG_8000,
        mapVar: MAPVAR.NOVAR,
      });
      result.set(chunk, bytesRead);
      bytesRead += chunk.length;
      onProgress?.(bytesRead, totalBytes);
    }

    // Dump the fixed bank from $C000
    const fixedChunk = await dumpRegion(device, {
      sizeKB: KB_PER_BANK,
      memType: MEM.NESCPU_4KB,
      mapper: ADDR_PAGE.PRG_C000,
      mapVar: MAPVAR.NOVAR,
    });
    result.set(fixedChunk, bytesRead);
    bytesRead += fixedChunk.length;
    onProgress?.(bytesRead, totalBytes);

    return result;
  },

  async dumpChrRom(_device, sizeKB) {
    if (sizeKB !== 0) {
      throw new Error("UxROM: CHR-ROM not supported (CHR-RAM only)");
    }
    return new Uint8Array(0);
  },
};
