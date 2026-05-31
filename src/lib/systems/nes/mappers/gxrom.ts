/**
 * GxROM (iNES mapper 66) — up to 128 KiB PRG in 32 KiB switchable
 * banks, up to 32 KiB CHR-ROM in 8 KiB switchable banks.
 *
 * Register: single byte at any address $8000-$FFFF.
 *   bits 4-5: PRG bank (0-3, selects a 32 KiB block at $8000-$FFFF)
 *   bits 0-1: CHR bank (0-3, selects an 8 KiB block at PPU $0000)
 *   bits 2-3 and 6-7: unused (don't-care on real silicon).
 *
 * The register sits in PRG-ROM space, so selects go through the bus
 * conflict handled by `selectBank` (see `./bus-conflict`): each select
 * re-homes to bank 0 (a conflict-immune 0x00 write) and writes the value
 * through a bank-0 byte that passes it under the AND. Departing from a
 * known bank means a dropped latch leaves us on bank 0, which the
 * `readBankWithRetry` dropout check detects and re-issues — the same
 * recovery MMC3 uses on clone carts.
 *
 * Reference: nesdev wiki "GxROM".
 */

import type { NesMapper } from "./types";
import { selectBank, readLatchedChrBank } from "./bus-conflict";
import { walkBanks } from "./bank-walk";

const PRG_BANK_KB = 32;
const CHR_BANK_KB = 8;
const PRG_BANK_BYTES = PRG_BANK_KB * 1024;
const CHR_BANK_BYTES = CHR_BANK_KB * 1024;

export const gxrom: NesMapper = {
  id: 66,
  name: "GxROM",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();
    return walkBanks(
      {
        label: "GxROM PRG",
        bankBytes: PRG_BANK_BYTES,
        numBanks: sizeKB / PRG_BANK_KB,
        // PRG bank N in bits 5-4 (CHR bits stay 0). Bank 0's select homes
        // to a conflict-immune 0x00 write; later banks gate through bank 0.
        readBank: async (bank, gate) => {
          await selectBank(bus, bank << 4, gate);
          return bus.readCpu(0x8000, PRG_BANK_BYTES);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);
    await bus.setup();

    // CHR selects keep the PRG bits at 0, so PRG bank 0 stays mapped and is
    // the bus-conflict gate throughout — read it once up front.
    await bus.writeCpu(0x8000, 0x00);
    const prgGate = await bus.readCpu(0x8000, PRG_BANK_BYTES);

    return walkBanks(
      {
        label: "GxROM CHR",
        bankBytes: CHR_BANK_BYTES,
        numBanks: sizeKB / CHR_BANK_KB,
        // CHR bank N in bits 1-0 (PRG bits stay 0).
        readBank: (bank) =>
          readLatchedChrBank(bus, bank, prgGate, CHR_BANK_BYTES),
      },
      onProgress,
    );
  },
};
