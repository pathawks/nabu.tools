/**
 * UxROM (iNES mapper 2, also UNROM/UOROM) — up to 256 KiB PRG in 16 KiB
 * switchable banks; CHR is RAM, not ROM.
 *
 * Register: single byte at any address $8000-$FFFF.
 *   bits 0-3: PRG bank — selects a 16 KiB block at $8000-$BFFF.
 *     UNROM uses bits 0-2 (8 banks, 128 KiB); UOROM uses bits 0-3 (16
 *     banks, 256 KiB). Writing the bank index straight through covers
 *     both; the high don't-care bits stay 0.
 *   $C000-$FFFF is FIXED to the last 16 KiB bank.
 *
 * The register sits in PRG-ROM space, so on submapper 0 selects suffer a
 * bus conflict handled by `selectBank` (see `./bus-conflict`): each select
 * re-homes to bank 0 (a conflict-immune 0x00 write) and writes the value
 * through a bank-0 byte that passes it under the AND. Submapper 1 (UNROM
 * 74HC08, bus-conflict-free) latches the same writes cleanly, so this path
 * is correct either way. Departing from a known bank means a dropped latch
 * leaves us on bank 0, which the `readBankWithRetry` dropout check detects
 * and re-issues — the same recovery MMC3 uses on clone carts.
 *
 * CHR is CHR-RAM, so there is no CHR-ROM to dump: `dumpChrRom` returns an
 * empty array for the 0 KiB CHR size these carts carry.
 *
 * Reference: nesdev wiki "UxROM" and "INES Mapper 002"; cross-checked
 * against INL-retro's host/scripts/nes/unrom.lua (mapname "UxROM").
 */

import type { NesMapper } from "./types";
import { selectBank } from "./bus-conflict";
import { walkBanks } from "./bank-walk";

const PRG_BANK_KB = 16;
const PRG_BANK_BYTES = PRG_BANK_KB * 1024;

export const uxrom: NesMapper = {
  id: 2,
  name: "UxROM",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();
    // Walk every switchable 16 KiB bank at $8000-$BFFF. The highest bank
    // index maps the same physical bank fixed at $C000-$FFFF, so reading
    // the $8000 window across all banks already captures the fixed bank.
    return walkBanks(
      {
        label: "UxROM PRG",
        bankBytes: PRG_BANK_BYTES,
        numBanks: sizeKB / PRG_BANK_KB,
        // PRG bank N in bits 0-3 (high bits stay 0).
        readBank: async (bank, gate) => {
          await selectBank(bus, bank, gate);
          return bus.readCpu(0x8000, PRG_BANK_BYTES);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(_bus, sizeKB) {
    // UxROM carts use CHR-RAM, so there is no CHR-ROM to read. The DB
    // lists only the 0 KiB CHR size; anything else is a caller error, but
    // an empty dump is the only sensible result for size 0.
    if (sizeKB === 0) return new Uint8Array(0);
    throw new Error(
      `UxROM (mapper 2) has CHR-RAM, not CHR-ROM; cannot dump ${sizeKB}KB of CHR-ROM.`,
    );
  },
};
