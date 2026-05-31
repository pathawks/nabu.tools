/**
 * AxROM (iNES mapper 7, also AOROM/AMROM/ANROM) — up to 256 KiB PRG in
 * 32 KiB switchable banks; CHR is RAM, not ROM.
 *
 * Register: single byte at any address $8000-$FFFF.
 *   bits 0-2: PRG bank (0-7) — selects a 32 KiB block at $8000-$FFFF.
 *     The whole 32 KiB region switches as one; there is no fixed bank.
 *     The select value IS the bank index, so the bank number is written
 *     straight through.
 *   bit 4: 1-screen nametable select (mirroring) — affects only which
 *     CIRAM page the PPU sees, not dumped content, so it stays 0.
 *   other bits: unused (don't-care on real silicon).
 *
 * The register sits in PRG-ROM space, so on the bus-conflicted board
 * variants (AMROM/ANROM use a 74HC161 + discrete AND, AOROM uses a
 * conflict-free 74HC161 latch) selects suffer a bus conflict handled by
 * `selectBank` (see `./bus-conflict`): each select re-homes to bank 0 (a
 * conflict-immune 0x00 write) and writes the value through a bank-0 byte
 * that passes it under the AND. AOROM latches the same writes cleanly, so
 * this path is correct either way. Departing from a known bank means a
 * dropped latch leaves us on bank 0, which the `readBankWithRetry` dropout
 * check detects and re-issues — the same recovery MMC3 uses on clone carts.
 *
 * CHR is CHR-RAM, so there is no CHR-ROM to dump: `dumpChrRom` returns an
 * empty array for the 0 KiB CHR size these carts carry.
 *
 * Reference: nesdev wiki "AxROM" and "INES Mapper 007"; cross-checked
 * against INL-retro's host/scripts/nes/bnrom.lua (the analogous 32 KiB
 * direct-index banking with a bank-table write gate).
 */

import type { NesMapper } from "./types";
import { selectBank } from "./bus-conflict";
import { walkBanks } from "./bank-walk";

const PRG_BANK_KB = 32;
const PRG_BANK_BYTES = PRG_BANK_KB * 1024;

export const axrom: NesMapper = {
  id: 7,
  name: "AxROM",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();
    return walkBanks(
      {
        label: "AxROM PRG",
        bankBytes: PRG_BANK_BYTES,
        numBanks: sizeKB / PRG_BANK_KB,
        // PRG bank N in bits 0-2 — the select value is the bank index
        // (mirroring bit 4 stays 0).
        readBank: async (bank, gate) => {
          await selectBank(bus, bank, gate);
          return bus.readCpu(0x8000, PRG_BANK_BYTES);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(_bus, sizeKB) {
    // AxROM carts use CHR-RAM, so there is no CHR-ROM to read. The DB
    // lists only the 0 KiB CHR size; anything else is a caller error, but
    // an empty dump is the only sensible result for size 0.
    if (sizeKB === 0) return new Uint8Array(0);
    throw new Error(
      `AxROM (mapper 7) has CHR-RAM, not CHR-ROM; cannot dump ${sizeKB}KB of CHR-ROM.`,
    );
  },
};
