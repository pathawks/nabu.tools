/**
 * CNROM (iNES mapper 3) — fixed 16 KiB or 32 KiB PRG-ROM, up to 32 KiB
 * CHR-ROM in 8 KiB switchable banks.
 *
 * NOT HARDWARE-VALIDATED — intentionally NOT wired into the INL driver's
 * `MAPPERS` catalog or `NES_MAPPER_DB`. The implementation is unit-tested
 * (`mappers.test.ts`) and follows the same discrete bus-conflict pattern as
 * the hardware-verified GxROM/UxROM/AxROM mappers, but no CNROM cart was on
 * hand to confirm it on real silicon. Wire it into both lists once a CNROM
 * dump verifies against the database.
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
 * through a bank-0 byte that passes it under the AND. CNROM's PRG is
 * fixed, so "bank 0" is simply the one PRG image, read once up front and
 * reused as the gate source for every CHR select — the same shape as
 * GxROM's `dumpChrRom`, which reads PRG bank 0 as the gate then selects
 * CHR banks and reads 8 KiB at PPU $0000.
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
import { selectBank } from "./bus-conflict";
import { readBankWithRetry } from "./bank-reliability";

const CHR_BANK_BYTES = 8 * 1024;

export const cnrom: NesMapper = {
  id: 3,
  name: "CNROM",
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
    if (!bus.readPpu) {
      throw new Error(
        "CNROM (mapper 3) CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific `dumpChrRom` override for mapper 3.",
      );
    }
    const readPpu = bus.readPpu.bind(bus);

    await bus.setup();

    const totalBytes = sizeKB * 1024;
    const numBanks = totalBytes / CHR_BANK_BYTES;
    const out = new Uint8Array(totalBytes);

    // PRG is fixed, so the one PRG image is the gate source for every CHR
    // select — read it once up front. The leading 0x00 write is
    // conflict-immune and selects CHR bank 0 to start from a known state.
    await bus.writeCpu(0x8000, 0x00);
    const prg = await bus.readCpu(0x8000, 0x8000);

    // A dropped CHR select on a clone cart reads back as CHR bank 0 — the
    // same dropout signature the bank-switched mappers recover from. CHR is
    // CNROM's only banked region, so retry it the same way.
    let chr0: Uint8Array | null = null;
    for (let bank = 0; bank < numBanks; bank++) {
      const offset = bank * CHR_BANK_BYTES;
      const chunk = await readBankWithRetry({
        label: `CNROM CHR bank ${bank}`,
        reference: chr0,
        attempt: async () => {
          // CHR bank N is the plain register value (PRG is unaffected).
          await selectBank(bus, bank, prg);
          return readPpu(0x0000, CHR_BANK_BYTES);
        },
      });
      if (bank === 0) chr0 = chunk;
      out.set(chunk, offset);
      onProgress?.(offset + CHR_BANK_BYTES, totalBytes);
    }

    return out;
  },
};
