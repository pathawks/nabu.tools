/**
 * DxROM / Tengen MIMIC-1 (iNES mapper 206) — MMC3's ancestor.
 *
 * Same $8000 (bank select) / $8001 (bank data) register pair as MMC3, and
 * the same bank layout MMC3 calls mode 0: R0/R1 = 2 KiB CHR at PPU
 * $0000/$0800, R2-R5 = 1 KiB CHR at $1000-$1FFF, R6/R7 = 8 KiB PRG at
 * $8000/$A000, $C000-$FFFF fixed to the last 16 KiB. The shared MMC3 dump
 * core therefore walks it unchanged. What the chip *lacks* shapes the
 * variant:
 *
 *   - There are no registers anywhere in $A000-$FFFF — no mirroring, no
 *     IRQ, no PRG-RAM protect. Init is `programBanks`, which writes only
 *     $8000/$8001; MMC3's init ($A001 then $A000) and RAMBO-1's
 *     `setupBanks` (a $A000 mirroring write) must not be reused here.
 *   - Bank select decodes 3 bits: MMC3's CHR-inversion (bit 7) and
 *     PRG-mode (bit 6) bits do not exist, so the chip is permanently in
 *     the layout above — exactly what the shared walk programs. Bank data
 *     decodes 6 bits. Every value the walk writes fits: selects are
 *     0/1/6/7, and the largest data value is $3E (R1 on the last 4 KiB
 *     stride of a 64 KiB CHR-ROM).
 *
 * 32 KiB PRG is a special case. Most 32 KiB boards (the 3407/3417/3451
 * PCBs, NES 2.0 submapper 1) wire CPU A13/A14 straight to PRG-ROM: the
 * R6/R7 PRG registers have NO effect, so an R6 walk would read $8000-$9FFF
 * — physical bank 0 — for every register value and dump bank 0 four times.
 * So at 32 KiB we read the whole $8000-$FFFF space flat instead. That is
 * also correct for the one 32 KiB board that does bank (the 3401 PCB):
 * after `programBanks` (R6=0, R7=1, last 16 KiB fixed) its $8000-$FFFF
 * tiles as banks 0,1,2,3. The R6 walk is used only for >= 64 KiB, which is
 * always genuinely banked.
 *
 * Limits: PRG <= 128 KiB, CHR <= 64 KiB and always ROM (the DB size lists
 * enforce both). Mirroring is hardwired on the board; the one four-screen
 * variant (DRROM) differs only in its header, which a No-Intro content
 * match restamps canonically.
 *
 * Reference: nesdev wiki "INES Mapper 206".
 */

import type { NesMapper } from "./types";
import {
  type Mmc3StyleVariant,
  programBanks,
  dumpMmc3StylePrgRom,
  dumpMmc3StyleChrRom,
} from "./mmc3";

// DxROM init = MMC3's bank programming alone — the chip has no other
// registers to touch.
const DXROM: Mmc3StyleVariant = {
  name: "DxROM",
  id: 206,
  init: programBanks,
};

export const dxrom: NesMapper = {
  id: 206,
  name: "DxROM",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    // 32 KiB (or smaller) boards are read flat — their PRG registers don't
    // bank; see the header. `programBanks` only writes $8000/$8001, which is
    // safe on every mapper-206 board.
    if (sizeKB <= 32) {
      await bus.setup();
      await programBanks(bus);
      return bus.readCpu(0x8000, sizeKB * 1024, onProgress);
    }
    return dumpMmc3StylePrgRom(bus, sizeKB, DXROM, onProgress);
  },

  dumpChrRom: (bus, sizeKB, onProgress) =>
    dumpMmc3StyleChrRom(bus, sizeKB, DXROM, onProgress),
};
