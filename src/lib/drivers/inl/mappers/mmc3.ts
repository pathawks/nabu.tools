/**
 * MMC3/TxROM (Mapper 4) — bank-switching mapper with IRQ counter.
 *
 * PRG-ROM: up to 512KB, switched in 8KB banks via registers 6 & 7
 * CHR-ROM: up to 256KB, switched in 2KB banks via registers 0 & 1
 *
 * Bank select register ($8000) selects which register to update;
 * bank data register ($8001) writes the bank number.
 *
 * Reference: host/scripts/nes/mmc3.lua
 */

import type { INLDevice } from "../inl-device";
import type { NesMapper } from "./types";
import { dumpRegion } from "../inl-dump";
import { NES, MEM, MAPVAR } from "../inl-opcodes";
import { detectCiramMirroring } from "./detect-mirroring";

const ADDR_PAGE = {
  PRG_8000: 0x08,
  CHR_0000: 0x00,
} as const;

/**
 * Initialize MMC3 for dumping.
 *
 * Disables WRAM writes, sets vertical mirroring, and configures
 * initial bank mappings for both PRG and CHR.
 */
async function initMapper(device: INLDevice): Promise<void> {
  // Disable WRAM writes, allow reads
  await device.nes(NES.NES_CPU_WR, 0xa001, 0x40);

  // Vertical mirroring
  await device.nes(NES.NES_CPU_WR, 0xa000, 0x00);

  // CHR: 2KB bank 0 at PPU $0000
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x00);
  await device.nes(NES.NES_CPU_WR, 0x8001, 0x00);

  // CHR: 2KB bank 1 at PPU $0800
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x01);
  await device.nes(NES.NES_CPU_WR, 0x8001, 0x02);

  // PRG: 8KB bank 0 at CPU $A000 (reg 7)
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x07);
  await device.nes(NES.NES_CPU_WR, 0x8001, 0x01);

  // PRG: 8KB bank 0 at CPU $8000 (reg 6)
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x06);
  await device.nes(NES.NES_CPU_WR, 0x8001, 0x00);
}

export const mmc3: NesMapper = {
  id: 4,
  name: "MMC3",
  defaultPrgSizes: [512, 256, 128, 64, 32],
  defaultChrSizes: [256, 128, 64, 32, 16, 8, 0],

  detectMirroring: detectCiramMirroring,

  async dumpPrgRom(device, sizeKB, onProgress) {
    await initMapper(device);

    // Dump 16KB at a time using registers 6 and 7 (two 8KB banks)
    const bankSizeKB = 16;
    const numBanks = sizeKB / bankSizeKB;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let bank = 0; bank < numBanks; bank++) {
      // Register 6: 8KB bank at CPU $8000
      await device.nes(NES.NES_CPU_WR, 0x8000, 0x06);
      await device.nes(NES.NES_CPU_WR, 0x8001, bank * 2);

      // Register 7: 8KB bank at CPU $A000
      await device.nes(NES.NES_CPU_WR, 0x8000, 0x07);
      await device.nes(NES.NES_CPU_WR, 0x8001, bank * 2 + 1);

      const chunk = await dumpRegion(device, {
        sizeKB: bankSizeKB,
        memType: MEM.NESCPU_4KB,
        mapper: ADDR_PAGE.PRG_8000,
        mapVar: MAPVAR.NOVAR,
        onProgress: onProgress
          ? (chunkRead) => onProgress(bytesRead + chunkRead, sizeKB * 1024)
          : undefined,
      });

      result.set(chunk, bytesRead);
      bytesRead += chunk.length;
    }

    return result;
  },

  async dumpChrRom(device, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);

    await initMapper(device);

    // Dump 4KB at a time using registers 0 and 1 (two 2KB banks)
    // Bit 0 is unused on 2KB bank registers, so values are shifted left by 1
    const bankSizeKB = 4;
    const numBanks = sizeKB / bankSizeKB;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let bank = 0; bank < numBanks; bank++) {
      // Register 0: 2KB bank at PPU $0000
      await device.nes(NES.NES_CPU_WR, 0x8000, 0x00);
      await device.nes(NES.NES_CPU_WR, 0x8001, (bank * 2) << 1);

      // Register 1: 2KB bank at PPU $0800
      await device.nes(NES.NES_CPU_WR, 0x8000, 0x01);
      await device.nes(NES.NES_CPU_WR, 0x8001, (bank * 2 + 1) << 1);

      const chunk = await dumpRegion(device, {
        sizeKB: bankSizeKB,
        memType: MEM.NESPPU_1KB,
        mapper: ADDR_PAGE.CHR_0000,
        mapVar: MAPVAR.NOVAR,
        onProgress: onProgress
          ? (chunkRead) => onProgress(bytesRead + chunkRead, sizeKB * 1024)
          : undefined,
      });

      result.set(chunk, bytesRead);
      bytesRead += chunk.length;
    }

    return result;
  },
};
