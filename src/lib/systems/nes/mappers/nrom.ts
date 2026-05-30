/**
 * NROM (iNES mapper 0) — simplest NES mapper, no bank switching.
 *
 * PRG-ROM: 16 KiB or 32 KiB at CPU $8000–$FFFF.
 * CHR-ROM: 8 KiB at PPU $0000–$1FFF (or CHR-RAM if 0 KiB).
 *
 * Mirroring is selectable via cart wiring; not represented in any
 * mapper register, so this mapper has no `detectMirroring` of its
 * own (CIRAM probing lives in shared NES utilities — to be migrated).
 */

import type { NesMapper } from "./types";

export const nrom: NesMapper = {
  id: 0,
  name: "NROM",
  defaultPrgSizes: [32, 16],
  defaultChrSizes: [0, 8],

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();
    const bytes = sizeKB * 1024;
    const out = await bus.readCpu(0x8000, bytes);
    onProgress?.(bytes, bytes);
    return out;
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);
    if (!bus.readPpu) {
      throw new Error(
        "NROM CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific `dumpChrRom` override for mapper 0.",
      );
    }
    await bus.setup();
    const bytes = sizeKB * 1024;
    const out = await bus.readPpu(0x0000, bytes);
    onProgress?.(bytes, bytes);
    return out;
  },
};
