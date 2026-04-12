/**
 * MMC5/ExROM (Mapper 5) — Nintendo MMC5, used by Castlevania III.
 *
 * PRG-ROM: configurable banking modes; we use mode 3 (4x 8KB banks)
 * CHR-ROM: configurable banking modes; we use mode 0 (single 8KB bank)
 *
 * Key registers:
 *   $5100: PRG banking mode (0x03 = 4x 8KB)
 *   $5101: CHR banking mode (0x00 = single 8KB)
 *   $5102/$5103: PRG-RAM write protect
 *   $5105: Nametable mirroring
 *   $5113: PRG-RAM bank at $6000-$7FFF
 *   $5114-$5117: PRG-ROM banks (mode 3: 8KB each, bit 7 = ROM select)
 *   $5127: CHR-ROM bank (mode 0: 8KB at $0000-$1FFF)
 *   $512B: CHR-ROM bank (mode 0: 8KB, 8x16 sprite mode)
 *
 * Reference: host/scripts/nes/mmc5.lua
 */

import type { INLDevice } from "../inl-device";
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
const KB_PER_CHR_BANK = 8;

/** Initialize MMC5 into a known state for dumping. */
async function initMapper(device: INLDevice): Promise<void> {
  // Disable PRG-RAM writes for safety
  await device.nes(NES.NES_CPU_WR, 0x5102, 0x01);
  await device.nes(NES.NES_CPU_WR, 0x5103, 0x02);

  // Vertical mirroring
  await device.nes(NES.NES_CPU_WR, 0x5105, 0x44);

  // PRG banking mode 3: 4x 8KB banks
  await device.nes(NES.NES_CPU_WR, 0x5100, 0x03);

  // CHR banking mode 0: single 8KB bank
  await device.nes(NES.NES_CPU_WR, 0x5101, 0x00);

  // PRG-RAM bank at $6000
  await device.nes(NES.NES_CPU_WR, 0x5113, 0x00);

  // PRG-ROM banks (bit 7 must be set to select ROM)
  await device.nes(NES.NES_CPU_WR, 0x5114, 0x80);
  await device.nes(NES.NES_CPU_WR, 0x5115, 0x81);
  await device.nes(NES.NES_CPU_WR, 0x5116, 0x82);
  await device.nes(NES.NES_CPU_WR, 0x5117, 0x83);

  // CHR-ROM bank 0 at $0000-$1FFF
  await device.nes(NES.NES_CPU_WR, 0x5127, 0x00);
  await device.nes(NES.NES_CPU_WR, 0x512b, 0x00);
}

export const mmc5: NesMapper = {
  id: 5,
  name: "MMC5",
  defaultPrgSizes: [512, 256, 128],
  defaultChrSizes: [512, 256, 128, 0],

  detectMirroring: detectCiramMirroring,

  async dumpPrgRom(device, sizeKB, onProgress) {
    await initMapper(device);

    const numBanks = sizeKB / KB_PER_PRG_BANK;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let bank = 0; bank < numBanks; bank++) {
      // Select 8KB PRG-ROM bank at $8000 (bit 7 = ROM)
      await device.nes(NES.NES_CPU_WR, 0x5114, bank | 0x80);

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

    await initMapper(device);

    const numBanks = sizeKB / KB_PER_CHR_BANK;
    const result = new Uint8Array(sizeKB * 1024);
    let bytesRead = 0;

    for (let bank = 0; bank < numBanks; bank++) {
      // Select 8KB CHR-ROM bank at $0000-$1FFF (both normal and 8x16 sprite)
      await device.nes(NES.NES_CPU_WR, 0x5127, bank);
      await device.nes(NES.NES_CPU_WR, 0x512b, bank);

      const chunk = await dumpRegion(device, {
        sizeKB: KB_PER_CHR_BANK,
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
