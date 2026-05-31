/**
 * CxROM (iNES mapper 3, the CNROM family) — fixed 16 KiB or 32 KiB
 * PRG-ROM, up to 32 KiB CHR-ROM in 8 KiB switchable banks.
 *
 * PRG-ROM does not bank: the whole 16/32 KiB sits at CPU $8000-$FFFF and
 * is read flat like NROM. The only switchable part is CHR — a single
 * register at any address $8000-$FFFF latches the 8 KiB CHR bank mapped
 * at PPU $0000.
 *   bits 0-1: CHR bank (0-3 for the stock 32 KiB part; the full byte is
 *     latched, so oversize boards just use more low bits — we always
 *     write the plain bank index).
 *   higher bits: unused on the stock part.
 *
 * The register sits in PRG-ROM space, so CHR selects suffer a bus
 * conflict and go through `selectBank` (see `./bus-conflict`): each
 * select re-homes to a conflict-immune 0x00 write and writes the value
 * through a bank-0 byte that passes it under the AND. The PRG is fixed,
 * so "bank 0" is simply the one PRG image, read once up front and reused
 * as the gate source for every CHR select — the same shape as GxROM's
 * `dumpChrRom`, which reads PRG bank 0 as the gate then selects CHR banks
 * and reads 8 KiB at PPU $0000.
 *
 * Submapper 1 boards have no bus conflicts and submapper 2 boards do;
 * `selectBank` is safe either way (a no-conflict board latches the value
 * directly, a conflict board latches it through the gate byte). Mirroring
 * is hardwired by cart layout, not register-controlled, so there is no
 * `detectMirroring` here.
 *
 * Cross-checked against INL's `host/scripts/nes/cnrom.lua`: PRG dumps flat
 * at $8000 (same as NROM), CHR dumps 8 KiB per bank with the bank index
 * written into PRG space through a byte whose ROM value carries the bank
 * bits (the bus-conflict gate). Reference: nesdev wiki "CNROM".
 */

import type { NesMapper } from "./types";
import { readLatchedChrBank } from "./bus-conflict";
import { walkBanks } from "./bank-walk";

const CHR_BANK_BYTES = 8 * 1024;

export const cxrom: NesMapper = {
  id: 3,
  name: "CxROM",
  defaultPrgSizes: [32, 16],
  defaultChrSizes: [32, 16, 8],

  async dumpPrgRom(bus, sizeKB, onProgress) {
    // PRG is fixed: the whole window is mapped at $8000 with no banking,
    // so this is a flat read like NROM.
    await bus.setup();
    const bytes = sizeKB * 1024;
    const out = await bus.readCpu(0x8000, bytes);
    onProgress?.(bytes, bytes);
    return out;
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);
    await bus.setup();

    // PRG is fixed, so the one PRG image is the bus-conflict gate for every
    // CHR select — read it once up front. The leading 0x00 write is
    // conflict-immune and starts from CHR bank 0.
    await bus.writeCpu(0x8000, 0x00);
    const prgGate = await bus.readCpu(0x8000, 0x8000);

    return walkBanks(
      {
        label: "CxROM CHR",
        bankBytes: CHR_BANK_BYTES,
        numBanks: (sizeKB * 1024) / CHR_BANK_BYTES,
        // CHR bank N is the plain register value (PRG is unaffected).
        readBank: (bank) =>
          readLatchedChrBank(bus, bank, prgGate, CHR_BANK_BYTES),
      },
      onProgress,
    );
  },
};
