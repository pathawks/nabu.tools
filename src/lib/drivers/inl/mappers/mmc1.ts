/**
 * MMC1/SxROM (Mapper 1) — serial shift-register mapper.
 *
 * PRG-ROM: up to 512KB, switched in 32KB banks at CPU $8000-$FFFF
 * CHR-ROM: up to 128KB, switched in 4KB banks at PPU $0000-$1FFF
 *
 * Register writes use the NES_MMC1_WR opcode, which handles the
 * 5-write serial shift register protocol in firmware.
 *
 * Reference: host/scripts/nes/mmc1.lua
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
 * Reset the MMC1 shift register and configure for dumping.
 *
 * Sets 32KB PRG mode (control = 0x10), selects PRG bank 0 with
 * WRAM disabled, and configures CHR in 4KB mode for banking.
 */
async function initMapper(device: INLDevice): Promise<void> {
  // Reset MMC1 shift register (D7 set)
  await device.nes(NES.NES_CPU_WR, 0x8000, 0x80);

  // Control register: 32KB PRG mode, 4KB CHR mode
  await device.nes(NES.NES_MMC1_WR, 0x8000, 0x10);

  // PRG bank 0, WRAM disabled (bit4=1)
  await device.nes(NES.NES_MMC1_WR, 0xe000, 0x10);

  // CHR bank 0 at PPU $0000
  await device.nes(NES.NES_MMC1_WR, 0xa000, 0x00);
  // CHR bank 1 at PPU $1000
  await device.nes(NES.NES_MMC1_WR, 0xc000, 0x01);
}

export const mmc1: NesMapper = {
  id: 1,
  name: "MMC1",
  defaultPrgSizes: [256, 128, 64, 32],
  defaultChrSizes: [128, 64, 32, 16, 8, 0],

  async enableSram(device: INLDevice): Promise<void> {
    // Reference: mmc1.lua lines 551-558
    await initMapper(device);
    // PRG bank register: bit4=0 enables WRAM
    await device.nes(NES.NES_MMC1_WR, 0xe000, 0x00);
    // On SNROM, CHR A16 (bit4 of CHR bank reg) controls WRAM /CE.
    // bit4=0 activates WRAM chip enable.
    await device.nes(NES.NES_MMC1_WR, 0xa000, 0x02);
    await device.nes(NES.NES_MMC1_WR, 0xc000, 0x05);
  },

  detectMirroring: detectCiramMirroring,

  async dumpPrgRom(device, sizeKB, onProgress) {
    await initMapper(device);

    const bankSizeKB = 32;
    const numBanks = sizeKB / bankSizeKB;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let bank = 0; bank < numBanks; bank++) {
      // Select 32KB PRG bank (LSBit ignored in 32KB mode)
      await device.nes(NES.NES_MMC1_WR, 0xe000, bank << 1);

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

    const bankSizeKB = 8;
    const numBanks = sizeKB / bankSizeKB;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let bank = 0; bank < numBanks; bank++) {
      // 4KB bank at PPU $0000
      await device.nes(NES.NES_MMC1_WR, 0xa000, bank * 2);
      // 4KB bank at PPU $1000
      await device.nes(NES.NES_MMC1_WR, 0xc000, bank * 2 + 1);

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
