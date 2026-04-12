/**
 * BxROM (Mapper 34) and AxROM (Mapper 7) — 32KB switchable PRG, CHR-RAM only.
 *
 * PRG-ROM: 32KB switchable bank at CPU $8000-$FFFF (no fixed bank)
 * CHR-ROM: none (CHR-RAM)
 *
 * Bus conflict: writes go through a bank table that must exist in every bank.
 * AxROM is functionally identical for dumping (it also controls mirroring via
 * a bit in the register, but that doesn't affect reading).
 *
 * Reference: host/scripts/nes/bnrom.lua
 */

import type { INLDevice } from "../inl-device";
import type { NesMapper } from "./types";
import { dumpRegion } from "../inl-dump";
import { NES, MEM, MAPVAR } from "../inl-opcodes";
import { findBankTable } from "./bus-conflict";
import { detectCiramMirroring } from "./detect-mirroring";

const ADDR_PAGE = {
  PRG_8000: 0x08,
} as const;

const KB_PER_BANK = 32;

async function dumpPrgRom(
  device: INLDevice,
  sizeKB: number,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
): Promise<Uint8Array> {
  const numBanks = sizeKB / KB_PER_BANK;

  // Find the bank table in the currently visible 32KB bank ($8000-$FFFF).
  // Unlike UxROM there is no fixed bank, so whatever bank is visible at
  // power-on must contain the table (it should be in every bank).
  // If no table found, fall back to direct writes (board has no bus conflicts).
  const bankTableAddr = await findBankTable(device, 0x8000, 32, numBanks);

  const totalBytes = sizeKB * 1024;
  const result = new Uint8Array(totalBytes);
  let bytesRead = 0;

  for (let bank = 0; bank < numBanks; bank++) {
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

  return result;
}

async function dumpChrRom(
  _device: INLDevice,
  sizeKB: number,
): Promise<Uint8Array> {
  if (sizeKB !== 0) {
    throw new Error("BxROM/AxROM: CHR-ROM not supported (CHR-RAM only)");
  }
  return new Uint8Array(0);
}

export const bnrom: NesMapper = {
  id: 34,
  name: "BxROM",
  defaultPrgSizes: [128, 64],
  defaultChrSizes: [0],
  detectMirroring: detectCiramMirroring,
  dumpPrgRom,
  dumpChrRom,
};

export const axrom: NesMapper = {
  id: 7,
  name: "AxROM",
  defaultPrgSizes: [256, 128],
  defaultChrSizes: [0],
  detectMirroring: detectCiramMirroring,
  dumpPrgRom,
  dumpChrRom,
};
