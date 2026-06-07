/**
 * NES 2.0 (and iNES 1.0-compatible) 16-byte header construction.
 *
 * We always emit NES 2.0 (byte 7 bit 3 set, bit 2 clear). Tools that
 * only understand iNES 1.0 see the same low-byte fields they always
 * have; tools that understand NES 2.0 pick up the extended fields
 * (submapper, mapper bits 8-11, CHR-RAM size, expansion device).
 *
 * Reference: https://www.nesdev.org/wiki/NES_2.0
 */

export type NesMirroring =
  | "horizontal"
  | "vertical"
  | "four_screen"
  | "mapper_controlled";

export type NesTvSystem = "ntsc" | "pal" | "multi" | "dendy";

export interface Nes2HeaderInputs {
  prgBytes: number;
  chrBytes: number;
  mapper: number;
  /** NES 2.0 submapper (0-15). Default 0. */
  submapper?: number;
  mirroring: NesMirroring;
  battery: boolean;
  /** Volatile CHR-RAM size in KiB (e.g. 8 for typical CHR-RAM carts). */
  chrRamKB?: number;
  /** Non-volatile (battery-backed) CHR-RAM size in KiB. Rare. */
  chrNvramKB?: number;
  /** Volatile PRG-RAM in KiB (the unbatteried portion). */
  prgRamKB?: number;
  /** Non-volatile (battery-backed) PRG-RAM in KiB. */
  prgNvramKB?: number;
  /**
   * TV system. Default "ntsc" — overridable when we know better
   * (e.g. PAL-only carts).
   */
  tvSystem?: NesTvSystem;
}

/** Convert a power-of-two size in bytes to NES 2.0's shift count. */
function ramShift(bytes: number): number {
  if (bytes <= 0) return 0;
  // NES 2.0 RAM-size encoding: size = 64 << shift, max shift = 14 (1 MiB)
  for (let s = 0; s <= 14; s++) {
    if (64 << s === bytes) return s;
  }
  throw new Error(
    `NES 2.0 RAM size ${bytes} is not 64 << n for any n in [0, 14]`,
  );
}

const TV_SYSTEM_BITS: Record<NesTvSystem, number> = {
  ntsc: 0,
  pal: 1,
  multi: 2,
  dendy: 3,
};

/**
 * Build a 16-byte NES 2.0 iNES header.
 *
 * Header format (each row is one byte):
 *   0-3   "NES\x1A"
 *   4     PRG-ROM size (low 8 bits of 16 KiB units)
 *   5     CHR-ROM size (low 8 bits of 8 KiB units)
 *   6     flags6: mapper bits 0-3 in high nibble, mirroring/battery/four-screen
 *   7     flags7: mapper bits 4-7 in high nibble, NES 2.0 indicator (bits 2-3 = 10)
 *   8     mapper bits 8-11 in low nibble, submapper in high nibble
 *   9     PRG/CHR MSB nibbles (both 0 in our scope)
 *   10    PRG-RAM (low nibble) / PRG-NVRAM (high nibble) shift counts
 *   11    CHR-RAM (low nibble) / CHR-NVRAM (high nibble) shift counts
 *   12    TV system (bits 0-1)
 *   13    Vs./PlayChoice = 0
 *   14    Misc ROM count = 0
 *   15    Default expansion device = 1 (Standard NES Controller)
 */
export function buildNes2Header(p: Nes2HeaderInputs): Uint8Array {
  const h = new Uint8Array(16);
  h[0] = 0x4e; // N
  h[1] = 0x45; // E
  h[2] = 0x53; // S
  h[3] = 0x1a;

  // PRG/CHR size: low 8 bits in bytes 4/5, MSB nibbles in byte 9. The
  // plain (non-exponent) NES 2.0 size form tops out at 0xEFF units —
  // ~60 MiB PRG / ~30 MiB CHR — which comfortably covers the largest
  // boards we offer (32 MiB mapper-268 multicarts). An MSB nibble of
  // 0xF would flip the field into exponent form, so guard loudly
  // rather than emit a header that silently means something else.
  const prgUnits = p.prgBytes / 16384;
  const chrUnits = p.chrBytes / 8192;
  if (prgUnits > 0xeff || chrUnits > 0xeff) {
    throw new Error(
      `ROM too large for NES 2.0 plain size form: ${prgUnits}x16K PRG / ${chrUnits}x8K CHR`,
    );
  }
  h[4] = prgUnits & 0xff;
  h[5] = chrUnits & 0xff;

  // Flags 6: mapper bits 0-3, mirroring, battery, four-screen
  let flags6 = (p.mapper & 0x0f) << 4;
  if (p.mirroring === "vertical") flags6 |= 0x01;
  if (p.battery) flags6 |= 0x02;
  if (p.mirroring === "four_screen") flags6 |= 0x08;
  h[6] = flags6;

  // Flags 7: mapper bits 4-7, NES 2.0 indicator (bits 2-3 = 10 → 0x08)
  h[7] = (p.mapper & 0xf0) | 0x08;

  // Byte 8: submapper (high), mapper bits 8-11 (low)
  const submapper = p.submapper ?? 0;
  h[8] = ((submapper & 0x0f) << 4) | ((p.mapper >> 8) & 0x0f);

  // Byte 9: CHR MSB nibble (high), PRG MSB nibble (low).
  h[9] = (((chrUnits >> 8) & 0x0f) << 4) | ((prgUnits >> 8) & 0x0f);

  // Byte 10: PRG-RAM (low), PRG-NVRAM (high). Battery → NVRAM nibble.
  const prgRamShift = ramShift((p.prgRamKB ?? 0) * 1024);
  const prgNvramShift = ramShift((p.prgNvramKB ?? 0) * 1024);
  h[10] = ((prgNvramShift & 0x0f) << 4) | (prgRamShift & 0x0f);

  // Byte 11: CHR-RAM (low), CHR-NVRAM (high).
  const chrRamShift = ramShift((p.chrRamKB ?? 0) * 1024);
  const chrNvramShift = ramShift((p.chrNvramKB ?? 0) * 1024);
  h[11] = ((chrNvramShift & 0x0f) << 4) | (chrRamShift & 0x0f);

  // Byte 12: TV system. Default 0 (NTSC) — the cart can't tell us, and
  // when the dump matches No-Intro we'll overwrite the whole header
  // with the DAT entry's canonical bytes anyway.
  h[12] = TV_SYSTEM_BITS[p.tvSystem ?? "ntsc"];

  // Byte 13: Vs. / PlayChoice = 0 (not relevant for our scope).
  h[13] = 0;

  // Byte 14: Miscellaneous ROMs = 0 (none).
  h[14] = 0;

  // Byte 15: Default expansion device. 0 = unspecified — we don't
  // know what controller(s) the cart expects.
  h[15] = 0;

  return h;
}
