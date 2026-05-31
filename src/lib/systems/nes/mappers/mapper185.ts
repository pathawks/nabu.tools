/**
 * iNES mapper 185 — CNROM with a CHR-ROM lockout (a small family of
 * mid-1980s CNROM boards; nescartdb/retrospector label them "CNROM with
 * protection diodes"). Which carts are mapper 185 is best confirmed
 * empirically — see the note on disambiguation below.
 *
 * Electrically this is plain CNROM: fixed 32 KiB PRG at CPU $8000-$FFFF
 * (read flat like NROM) and a single 8 KiB CHR-ROM bank at PPU $0000. There
 * is no CHR banking — the "bank select" data lines are repurposed as a
 * lockout instead. So a correctly-dumped 185 cart is byte-shaped exactly
 * like an NROM dump; the only difference 185 adds is the CHR lockout. A cart
 * therefore tells you which it is: dump CHR as plain NROM/CxROM, and if it
 * reads back as open bus rather than tile data, the lockout is active and
 * this mapper's probe is needed.
 *
 * The lockout: the CHR-ROM only drives the PPU data bus when an enabling
 * value is latched into the $8000-$FFFF register; latch the wrong value and
 * the CHR output stays disabled, so the PPU reads open bus. The game writes
 * the magic value, reads a known CHR byte back, and refuses to run if it
 * sees open bus. Only the low two latch bits are decoded (the two CHR data
 * lines that CNROM banking would otherwise use), so exactly one of the four
 * 2-bit values releases CHR on any given board. NES 2.0 submappers 4-7 fix
 * which; submapper 0 leaves it unknown — and a raw cart can't tell us its
 * submapper — so we probe: latch each candidate, read CHR, and take the
 * first read that comes back as real (non-uniform) data rather than open
 * bus. This is safe to brute-force because a NES register write can't harm
 * the cart, and benign because every candidate departs from a re-homed bank
 * (see `selectBank`).
 *
 * The register sits in PRG-ROM space, so latching a value suffers a bus
 * conflict; we go through `readLatchedChrBank`, which writes the value via a
 * gate byte in the (fixed) PRG image — the same path CxROM uses for its CHR
 * bank selects. Reference: nesdev wiki "CNROM" / "INES Mapper 185".
 */

import type { NesMapper } from "./types";
import { readLatchedChrBank } from "./bus-conflict";
import { isUniformFill } from "./bank-reliability";

/**
 * Latch values to try, in order, to release the CHR-ROM. Only the low two
 * latch bits decode the enable (NES 2.0 submappers 4/5/6/7 fix the value as
 * 0/1/2/3), so these four classes cover every 185 board. We deliberately use
 * the *bare* class values with the high bits clear rather than the fuller
 * bytes real games write (0x11, 0x21, 0x22, …):
 *   - The bus conflict is already neutralized by `findWriteGate` (it picks a
 *     PRG write-address whose byte passes the value under the AND), so we
 *     don't need extra high bits set "to survive the conflict".
 *   - Some 185 boards diode-wire latch bits 4-5 to CHR A10/A12 as an
 *     anti-dump measure; keeping those bits clear stops them displacing the
 *     PPU's own address lines, so the full 8 KiB reads back linearly instead
 *     of folded.
 * 0x00 leads: it's the submapper-4 case (which emulator submapper-0
 * heuristics can never unlock, since they require `(v & 3) != 0`), it's
 * CxROM's natural rest value, and it survives any bus conflict trivially.
 * We never probe 0x13: it disables some submapper-5 boards yet would falsely
 * enable a submapper-7 board, making it an ambiguous signal.
 */
const LOCKOUT_VALUES = [0x00, 0x01, 0x02, 0x03];

export const mapper185: NesMapper = {
  id: 185,
  name: "CNROM (protection diodes)",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    // Identical to NROM/CxROM: the whole 32 KiB window is mapped at
    // $8000 with no banking, so this is a flat read.
    await bus.setup();
    const bytes = sizeKB * 1024;
    const out = await bus.readCpu(0x8000, bytes);
    onProgress?.(bytes, bytes);
    return out;
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);
    await bus.setup();
    const bytes = sizeKB * 1024;

    // PRG is fixed, so the one PRG image is the bus-conflict gate for every
    // latch — read it once up front. The leading 0x00 write is
    // conflict-immune and re-homes the register to a known state.
    await bus.writeCpu(0x8000, 0x00);
    const prgGate = await bus.readCpu(0x8000, 0x8000);

    // Probe the lockout values. The first read that isn't uniform open bus
    // is the released CHR-ROM (`isUniformFill` is the shared "blank/dead
    // read" predicate). There's a single CHR bank, so any enabling value
    // yields the same bytes — no need to keep looking once one releases it.
    let fallback: Uint8Array | null = null;
    for (const value of LOCKOUT_VALUES) {
      const chr = await readLatchedChrBank(bus, value, prgGate, bytes);
      if (!isUniformFill(chr)) {
        onProgress?.(bytes, bytes);
        return chr;
      }
      fallback ??= chr;
    }

    // No candidate released the CHR — every read was uniform open bus. The
    // board may use an unknown lockout variant (or the CHR genuinely reads
    // blank). Return the first read so the dump still completes; the
    // No-Intro check will flag the mismatch rather than us silently passing.
    const tried = LOCKOUT_VALUES.map(
      (v) => `0x${v.toString(16).padStart(2, "0")}`,
    ).join(", ");
    console.warn(
      `[nes] mapper 185: no lockout value in [${tried}] released the CHR-ROM ` +
        "— every read was open bus. The cart may use an unrecognized " +
        "lockout variant; the dump's CHR is suspect.",
    );
    onProgress?.(bytes, bytes);
    return fallback ?? new Uint8Array(bytes);
  },
};
