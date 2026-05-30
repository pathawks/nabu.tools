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
import { selectBank } from "./bus-conflict";
import { readBankWithRetry } from "./bank-reliability";

const PRG_BANK_BYTES = 32 * 1024;
const CHR_BANK_BYTES = 8 * 1024;

export const gxrom: NesMapper = {
  id: 66,
  name: "GxROM",
  defaultPrgSizes: [128, 64, 32],
  defaultChrSizes: [32, 16, 8],

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();

    const totalBytes = sizeKB * 1024;
    const numBanks = totalBytes / PRG_BANK_BYTES;
    const out = new Uint8Array(totalBytes);

    // Land on bank 0 and read it — both the first chunk and the dropout
    // reference. The bank latch is volatile RAM that survives the
    // dumper's SETUP_NES, so a 0x00 write (conflict-immune) forces a
    // known starting bank.
    await bus.writeCpu(0x8000, 0x00);
    const bank0 = await bus.readCpu(0x8000, PRG_BANK_BYTES);
    out.set(bank0, 0);
    onProgress?.(PRG_BANK_BYTES, totalBytes);

    for (let bank = 1; bank < numBanks; bank++) {
      const offset = bank * PRG_BANK_BYTES;
      const chunk = await readBankWithRetry({
        label: `GxROM PRG bank ${bank}`,
        reference: bank0,
        attempt: async () => {
          // PRG bank N in bits 5-4 (CHR bits stay 0).
          await selectBank(bus, bank << 4, bank0);
          return bus.readCpu(0x8000, PRG_BANK_BYTES);
        },
      });
      out.set(chunk, offset);
      onProgress?.(offset + PRG_BANK_BYTES, totalBytes);
    }

    return out;
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);
    if (!bus.readPpu) {
      throw new Error(
        "GxROM (mapper 66) CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific `dumpChrRom` override for mapper 66.",
      );
    }

    await bus.setup();

    const totalBytes = sizeKB * 1024;
    const numBanks = totalBytes / CHR_BANK_BYTES;
    const out = new Uint8Array(totalBytes);

    // CHR selects keep the PRG-bank bits at 0, so PRG bank 0 stays mapped
    // and is the gate bank throughout.
    await bus.writeCpu(0x8000, 0x00);
    const bank0 = await bus.readCpu(0x8000, PRG_BANK_BYTES);

    for (let bank = 0; bank < numBanks; bank++) {
      // CHR bank N in bits 1-0 (PRG bits stay 0).
      await selectBank(bus, bank, bank0);
      const chunk = await bus.readPpu(0x0000, CHR_BANK_BYTES);
      const offset = bank * CHR_BANK_BYTES;
      out.set(chunk, offset);
      onProgress?.(offset + CHR_BANK_BYTES, totalBytes);
    }

    return out;
  },
};
