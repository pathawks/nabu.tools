/**
 * Camerica BF909x (iNES mapper 71) — UNROM-style Camerica boards:
 * BF9093 (submapper 0, the common board) and BF9097 (submapper 1).
 *
 * Bank register at $C000-$FFFF: the low 4 bits select the 16 KiB PRG bank
 * at $8000-$BFFF (up to 16 banks = 256 KiB); $C000-$FFFF is fixed to the
 * last bank. As with UxROM, the highest bank index maps the same physical
 * bank the fixed window shows, so walking the $8000 window covers all of
 * PRG.
 *
 * Register writes go to exactly $C000 — the only safe address:
 *   - $8000-$9FFF is BF9097's one-screen mirroring latch. The common
 *     BF9093 ignores writes there, but the dump must be safe for both
 *     submappers, so nothing is ever written below $C000.
 *   - $E000-$FFFF additionally drives a CIC-stun latch (A0 controls it) on
 *     all BF909x boards — a lockout-defeat circuit there is no reason to
 *     poke from a cart reader. The bank register decodes the full
 *     $C000-$FFFF, so writing at $C000 (staying below $E000) selects a bank
 *     without ever reaching the stun latch.
 * Those exclusions are why this mapper does NOT use the shared bus-conflict
 * helpers: `selectBank` re-homes through a $8000 write (the mirroring
 * latch), and a gate scan's offset could push the write address anywhere in
 * the 16 KiB register window, including the $E000+ stun-latch range. The
 * helpers are also unnecessary — BF909x boards have no bus conflicts
 * (74HC02-buffered writes), so a plain $C000 write latches the exact value.
 * Each select still departs from a 0x00 home write, so a dropped latch reads
 * back as bank 0 — the signature `readBankWithRetry` recovers.
 *
 * CHR is 8 KiB CHR-RAM — there is no CHR-ROM to dump.
 *
 * Reference: nesdev wiki "INES Mapper 071".
 */

import type { NesMapper } from "./types";
import { walkBanks } from "./bank-walk";

const BANK_REG = 0xc000; // bank register, kept below $E000 (no stun latch)
const PRG_BANK_KB = 16;
const PRG_BANK_BYTES = PRG_BANK_KB * 1024;

export const bf909x: NesMapper = {
  id: 71,
  name: "BF909x",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();
    return walkBanks(
      {
        label: "BF909x PRG",
        bankBytes: PRG_BANK_BYTES,
        numBanks: sizeKB / PRG_BANK_KB,
        // Home to bank 0, then latch the bank directly at $C000 — no
        // conflict gate; see the header for why.
        readBank: async (bank) => {
          await bus.writeCpu(BANK_REG, 0x00);
          await bus.writeCpu(BANK_REG, bank);
          return bus.readCpu(0x8000, PRG_BANK_BYTES);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(_bus, sizeKB) {
    // BF909x carts use CHR-RAM, so there is no CHR-ROM to read. The DB
    // lists only the 0 KiB CHR size; anything else is a caller error.
    if (sizeKB === 0) return new Uint8Array(0);
    throw new Error(
      `BF909x (mapper 71) has CHR-RAM, not CHR-ROM; cannot dump ${sizeKB}KB of CHR-ROM.`,
    );
  },
};
