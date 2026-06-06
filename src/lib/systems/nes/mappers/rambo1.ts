/**
 * RAMBO-1 (iNES mapper 64) — an MMC3 superset that adds a third switchable
 * 8 KiB PRG bank, an all-1 KiB CHR mode, and a CPU-cycle IRQ option.
 *
 * None of those extras matter for dumping. In the configuration we program
 * — bank-select bits 5/6/7 clear → CHR 2 KiB+1 KiB mode, PRG mode 0, no CHR
 * inversion — RAMBO-1's PRG and CHR banking is bit-for-bit MMC3:
 *   - PRG mode 0 maps R6 to $8000, so walking R6 reads every 8 KiB bank,
 *     exactly as MMC3 does (the third bank R15 and the fixed last bank are
 *     never needed when R6 alone covers all of PRG).
 *   - CHR mode 0 maps R0/R1 as 2 KiB banks at PPU $0000/$0800 and R2-R5 as
 *     1 KiB banks at $1000-$1FFF — the same layout MMC3's CHR walk drives.
 * So the dump reuses the shared MMC3 core verbatim (see `./mmc3`).
 *
 * The one init difference: RAMBO-1 has no PRG-RAM, and its $A001 register
 * is unused (no PRG-RAM protect like MMC3's), so we skip MMC3's PRG-RAM
 * control write and only program the banks. The free-running IRQ counter is
 * left disabled (we never touch $C000-$E001) and is irrelevant to a
 * register-driven static dump.
 *
 * Reference: nesdev wiki "RAMBO-1".
 */

import type { NesMapper } from "./types";
import {
  type Mmc3StyleVariant,
  setupBanks,
  dumpMmc3StylePrgRom,
  dumpMmc3StyleChrRom,
} from "./mmc3";

// RAMBO-1 init = MMC3's bank setup minus the PRG-RAM control write.
const RAMBO1: Mmc3StyleVariant = { name: "RAMBO-1", id: 64, init: setupBanks };

export const rambo1: NesMapper = {
  id: 64,
  name: "RAMBO-1",

  dumpPrgRom: (bus, sizeKB, onProgress) =>
    dumpMmc3StylePrgRom(bus, sizeKB, RAMBO1, onProgress),

  dumpChrRom: (bus, sizeKB, onProgress) =>
    dumpMmc3StyleChrRom(bus, sizeKB, RAMBO1, onProgress),
};
