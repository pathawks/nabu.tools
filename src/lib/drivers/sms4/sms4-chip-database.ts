/**
 * SMS4 save-chip identification.
 *
 * The chip identifier is a 3-byte JEDEC RDID response: manufacturer +
 * device-type + capacity. We extract two pieces of information from it:
 *
 *   1. **Family** — `(manufacturer, device-type)` → protocol family that
 *      shares a single 14-byte command-table template. Most NDS save chips
 *      fall into one of ~4 families (M25P / M25PE / M45PE / LE25FW).
 *   2. **Size** — `capacity` byte → bytes via the standard JEDEC encoding
 *      (`1 << (cap - 0x11) * 128 KB` for Numonyx-class chips).
 *
 * That decoder handles every chip the SMS4 hardware supports AND any
 * future chip in a known family, even one whose specific JEDEC ID is
 * not recognized by the device's built-in chip-detection logic.
 *
 * The specific-chip table below is retained for:
 *   - Future write support (per-chip page-program + erase opcodes differ)
 *   - Cross-validation when family inference is uncertain
 *   - Future per-chip override UI (not yet wired)
 */

export interface SaveChipFamily {
  /** Human-readable family name shown in the UI. */
  name: string;
  /** Expected JEDEC manufacturer byte (byte 0). */
  manufacturer: number;
  /**
   * Predicate on the JEDEC device-type byte (byte 1). Most families
   * pin it to a single value; some span a range.
   */
  matchesDeviceType: (deviceType: number) => boolean;
  /**
   * 14-byte SPI command-table template that the SMS4 firmware uses to
   * drive the chip's SPI lines. Byte 0 is the flag/family selector
   * (`0x07` for standard SPI, `0x0F` for Sanyo-style). The rest is
   * chip-specific opcodes (READ, WREN, RDSR, page-program, etc.).
   * For READ-ONLY operations, the relevant byte is `[1]` (READ DATA
   * opcode = `0x03` on every supported family).
   */
  cmdTable: readonly number[];
  /** Default flag bit assumed when no chip-specific override exists. */
  defaultFlag: 0x07 | 0x0f;
}

/**
 * SPI-flash family templates. Order matters for matching: more-specific
 * predicates come before more-permissive ones.
 */
export const SAVE_CHIP_FAMILIES: readonly SaveChipFamily[] = [
  // Numonyx M25PE-class (page-erasable, smaller pages, write opcode 0x0A)
  // Device type 0x80.
  {
    name: "M25PE-class",
    manufacturer: 0x20,
    matchesDeviceType: (b) => b === 0x80,
    cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7],
    defaultFlag: 0x07,
  },
  // Numonyx M45PE-class (similar to M25PE but device type 0x40).
  {
    name: "M45PE-class",
    manufacturer: 0x20,
    matchesDeviceType: (b) => b === 0x40,
    cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7],
    defaultFlag: 0x07,
  },
  // Numonyx M25P-class (standard SPI flash, write opcode 0x02, device type 0x20).
  {
    name: "M25P-class",
    manufacturer: 0x20,
    matchesDeviceType: (b) => b === 0x20,
    cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7],
    defaultFlag: 0x07,
  },
  // Sanyo LE25FW-class (manufacturer 0x62, distinct protocol byte 0x0F).
  {
    name: "LE25FW-class",
    manufacturer: 0x62,
    matchesDeviceType: () => true,
    cmdTable: [0x0f, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0x03, 0x05, 0x06, 0x00, 0x0a, 0xd8],
    defaultFlag: 0x0f,
  },
  // Fallback Numonyx (any device type). Test carts seen in the wild
  // with device-type 0x50 land here when that doesn't match the more-
  // specific families above. Uses M25P-class read opcodes (0x03), which
  // work universally on Numonyx-derived SPI flashes regardless of
  // device-type sub-family. Page-program / erase opcodes are best-effort
  // for any future write support.
  {
    name: "Generic Numonyx SPI flash",
    manufacturer: 0x20,
    matchesDeviceType: () => true,
    cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7],
    defaultFlag: 0x07,
  },
];

/**
 * Decode the JEDEC capacity byte (byte 2) into bytes. Returns 0 for
 * unrecognized capacity codes.
 *
 * Encoding for Numonyx-class chips:
 *   0x11 → 128 KB (1 Mbit)
 *   0x12 → 256 KB (2 Mbit)
 *   0x13 → 512 KB (4 Mbit)
 *   0x14 → 1 MB  (8 Mbit)
 *   0x15 → 2 MB  (16 Mbit)
 *   0x16 → 4 MB  (32 Mbit)
 *   0x17 → 8 MB  (64 Mbit)
 *
 * Sanyo LE25FW uses a different scheme; see SAVE_CHIPS table for
 * specific entries.
 */
export function decodeSpiCapacityByte(b: number): number {
  if (b < 0x11 || b > 0x18) return 0;
  return 128 * 1024 * (1 << (b - 0x11));
}

/**
 * Specific chips, indexed by exact 3-byte JEDEC ID. Used for:
 *   - Authoritative size info that contradicts the generic decoder
 *     (e.g. Sanyo LE25FW chips encode size differently)
 *   - Exact-match override before family fallback
 *   - Future write support (specific chip's exact opcodes)
 *   - Future per-chip override UI (not yet wired)
 */
export interface SaveChipDef {
  name: string;
  sizeBytes: number;
  pageSize: number;
  cmdTable: readonly number[];
  /** 3-byte JEDEC RDID response, or undefined for M95-class EEPROMs
   *  (which need wrap-probe identification rather than JEDEC). */
  jedecId?: readonly [number, number, number];
}

export const SAVE_CHIPS: readonly SaveChipDef[] = [
  // ─── Numonyx M25P (standard SPI flash) ─────────────────────────────
  { name: "M25P80",  sizeBytes: 1 * 1024 * 1024, pageSize: 256, jedecId: [0x20, 0x20, 0x14], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7] },
  { name: "M25P64",  sizeBytes: 8 * 1024 * 1024, pageSize: 256, jedecId: [0x20, 0x20, 0x17], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xd8] },
  // ─── Numonyx M25PE (pageable, smaller pages) ───────────────────────
  { name: "M25PE10", sizeBytes:       128 * 1024, pageSize: 256, jedecId: [0x20, 0x80, 0x11], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7] },
  { name: "M25PE20", sizeBytes:       256 * 1024, pageSize: 256, jedecId: [0x20, 0x80, 0x12], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7] },
  { name: "M25PE40", sizeBytes:       512 * 1024, pageSize: 256, jedecId: [0x20, 0x80, 0x13], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7] },
  { name: "M25PE80", sizeBytes: 1 * 1024 * 1024, pageSize: 256, jedecId: [0x20, 0x80, 0x14], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7] },
  { name: "M25PE16", sizeBytes: 2 * 1024 * 1024, pageSize: 256, jedecId: [0x20, 0x80, 0x15], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7] },
  // ─── Micron M45PE sibling family ───────────────────────────────────
  { name: "M45PE10", sizeBytes:       128 * 1024, pageSize: 256, jedecId: [0x20, 0x40, 0x11], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7] },
  { name: "M45PE20", sizeBytes:       256 * 1024, pageSize: 256, jedecId: [0x20, 0x40, 0x12], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7] },
  { name: "M45PE40", sizeBytes:       512 * 1024, pageSize: 256, jedecId: [0x20, 0x40, 0x13], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xd8] },
  { name: "M45PE80", sizeBytes: 1 * 1024 * 1024, pageSize: 256, jedecId: [0x20, 0x40, 0x14], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xdb] },
  { name: "M45PE16", sizeBytes: 2 * 1024 * 1024, pageSize: 256, jedecId: [0x20, 0x40, 0x15], cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x0a, 0xc7] },
  // ─── Sanyo LE25FW (different protocol byte = 0x0F) ─────────────────
  { name: "LE25FW203", sizeBytes:       256 * 1024, pageSize: 256, jedecId: [0x62, 0x16, 0x00], cmdTable: [0x0f, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0x03, 0x05, 0x06, 0x00, 0x0a, 0xd8] },
  { name: "LE25FW206", sizeBytes:       256 * 1024, pageSize: 256, jedecId: [0x62, 0x42, 0x00], cmdTable: [0x0f, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0x03, 0x05, 0x06, 0x00, 0x0a, 0xd8] },
  { name: "LE25FW403", sizeBytes:       512 * 1024, pageSize: 256, jedecId: [0x62, 0x11, 0x00], cmdTable: [0x0f, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0x03, 0x05, 0x06, 0x00, 0x0a, 0xd8] },
  { name: "LE25FW806", sizeBytes: 1 * 1024 * 1024, pageSize: 256, jedecId: [0x62, 0x26, 0x00], cmdTable: [0x0f, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0x03, 0x05, 0x06, 0x00, 0x0a, 0xd8] },
  // ─── M95 EEPROMs (no JEDEC; wrap-probe required) ───────────────────
  { name: "M95040", sizeBytes: 512,         pageSize: 16,  cmdTable: [0x01, 0x01, 0x0f, 0x00, 0xff, 0xff, 0x00, 0x06, 0x0b, 0x05, 0x06, 0x01, 0x02, 0xc7] },
  { name: "M95080", sizeBytes: 1024,        pageSize: 32,  cmdTable: [0x01, 0x02, 0x1f, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7] },
  { name: "M95128", sizeBytes: 16 * 1024,   pageSize: 64,  cmdTable: [0x01, 0x02, 0x3f, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7] },
  { name: "M95256", sizeBytes: 32 * 1024,   pageSize: 64,  cmdTable: [0x01, 0x02, 0x3f, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7] },
  { name: "M95512", sizeBytes: 64 * 1024,   pageSize: 128, cmdTable: [0x01, 0x02, 0x7f, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7] },
  { name: "M95M01", sizeBytes: 128 * 1024,  pageSize: 256, cmdTable: [0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7] },
];

/**
 * Result of identifying a save chip from a JEDEC probe response.
 *
 * `source` records how we arrived at the identification:
 *   - "exact" — JEDEC bytes matched a specific chip in our database
 *     verbatim. Highest confidence; both read and write should work.
 *   - "family" — JEDEC manufacturer + device-type matched a known SPI
 *     family template, capacity decoded from byte 2. Reads should work
 *     via the family's read opcode (0x03 for all supported families).
 *   - "eeprom-family" — chip didn't answer JEDEC RDID (M95-family
 *     EEPROMs don't), but the SMS4 firmware classified it via its
 *     family-code byte (0x01 = small EEPROM, 0x02 = medium EEPROM).
 *     `sizeBytes` is 0 at this point; the driver runs a wrap-probe
 *     after `identifyByJedec` returns to refine size, promoting
 *     `source` to `wrap-probed` on success.
 *   - "wrap-probed" — size determined by reading at candidate sz-1
 *     offsets and observing address-bus aliasing back to offset 0.
 *   - "unknown" — neither JEDEC nor family code matched anything.
 */
export interface ChipIdentification {
  source: "exact" | "family" | "eeprom-family" | "wrap-probed" | "unknown";
  jedec: readonly [number, number, number];
  /** SMS4 firmware's family classification byte (probe response byte 8). */
  familyCode: number;
  /** Memory kind for the UI. EEPROM = M95-family (familyCode 0x01 / 0x02);
   *  FLASH = SPI flash with JEDEC RDID (M25P / M25PE / M45PE / LE25FW). */
  kind: "EEPROM" | "FLASH";
  /** Display name — specific chip if "exact"; family if "family"; "M95
   *  EEPROM" for eeprom-family / wrap-probed. */
  name: string;
  /** Chip capacity in bytes. 0 if size couldn't be determined from the
   *  probe alone (eeprom-family case requires wrap-probe). */
  sizeBytes: number;
  pageSize: number;
  cmdTable: readonly number[];
  /** Flag bit to patch into byte 0 of the command-table region. */
  flag: 0x07 | 0x0f;
}

/**
 * Identify a save chip from the parsed JEDEC + family-code probe result.
 *
 * Resolution order (most-specific to least):
 *   1. Exact match against a chip's specific JEDEC ID
 *   2. SPI family inference (manufacturer + device-type)
 *   3. M95 EEPROM family from firmware's family-code byte (JEDEC will
 *      be 0xFF 0xFF 0xFF since M95s ignore SPI 0x9F)
 *   4. Unknown
 *
 * For the `eeprom-family` path we return `sizeBytes: 0` — the caller
 * (the driver) runs a wrap-probe to refine size by observing address-
 * bus aliasing at standard candidate offsets.
 */
export function identifyByJedec(
  jedec: readonly [number, number, number],
  familyCode: number,
): ChipIdentification {
  const jedecLooksReal =
    jedec[0] !== 0xff && jedec[0] !== 0x00 && jedec[0] !== undefined;

  // Pass 1: exact JEDEC match.
  if (jedecLooksReal) {
    for (const c of SAVE_CHIPS) {
      if (!c.jedecId) continue;
      if (
        c.jedecId[0] === jedec[0] &&
        c.jedecId[1] === jedec[1] &&
        c.jedecId[2] === jedec[2]
      ) {
        return {
          source: "exact",
          jedec,
          familyCode,
          kind: c.name.startsWith("M95") ? "EEPROM" : "FLASH",
          name: c.name,
          sizeBytes: c.sizeBytes,
          pageSize: c.pageSize,
          cmdTable: c.cmdTable,
          flag: c.cmdTable[0] === 0x0f ? 0x0f : 0x07,
        };
      }
    }
  }

  // Pass 2: SPI family inference from JEDEC.
  if (jedecLooksReal) {
    for (const f of SAVE_CHIP_FAMILIES) {
      if (f.manufacturer !== jedec[0]) continue;
      if (!f.matchesDeviceType(jedec[1])) continue;
      const sizeBytes = decodeSpiCapacityByte(jedec[2]);
      if (sizeBytes === 0) continue;
      return {
        source: "family",
        jedec,
        familyCode,
        kind: "FLASH",
        name: f.name,
        sizeBytes,
        pageSize: 256,
        cmdTable: f.cmdTable,
        flag: f.defaultFlag,
      };
    }
  }

  // Pass 3: M95 EEPROM family from firmware's family-code byte. Used
  // when JEDEC is all-FF (chip doesn't respond to 0x9F) but the SMS4
  // firmware probed something else and classified it.
  if (familyCode === 0x01) {
    // Tiny EEPROMs (M95040 + sub-sizes). Use the M95040 cmd table as a
    // safe default; the wrap-probe later would refine the exact size.
    const tiny = SAVE_CHIPS.find((c) => c.name.startsWith("M95040"));
    return {
      source: "eeprom-family",
      jedec,
      familyCode,
      kind: "EEPROM",
      name: "M95 EEPROM",
      sizeBytes: 0,
      pageSize: tiny?.pageSize ?? 16,
      cmdTable:
        tiny?.cmdTable ??
        [0x01, 0x01, 0x0f, 0x00, 0xff, 0xff, 0x00, 0x06, 0x0b, 0x05, 0x06, 0x01, 0x02, 0xc7],
      flag: 0x07,
    };
  }
  if (familyCode === 0x02) {
    // Medium EEPROMs: M95080 / M95128 / M95256 / M95512 / M95M01. Pick
    // M95512 (64 KB) as the default — it's the most common medium-size
    // DS save chip. The driver's wrap-probe refines size after this call.
    const medium = SAVE_CHIPS.find((c) => c.name.startsWith("M95512"));
    return {
      source: "eeprom-family",
      jedec,
      familyCode,
      kind: "EEPROM",
      name: "M95 EEPROM",
      sizeBytes: 0,
      pageSize: medium?.pageSize ?? 128,
      cmdTable:
        medium?.cmdTable ??
        [0x01, 0x02, 0x7f, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01, 0x02, 0xc7],
      flag: 0x07,
    };
  }

  // No identification at all. Default to FLASH for the read path since
  // the SPI READ DATA opcode (0x03) works on FLASH. Size stays at 0;
  // readSave will throw rather than dump garbage.
  return {
    source: "unknown",
    jedec,
    familyCode,
    kind: "FLASH",
    name: "Unknown chip",
    sizeBytes: 0,
    pageSize: 256,
    cmdTable: SAVE_CHIP_FAMILIES[0]!.cmdTable,
    flag: 0x07,
  };
}

/**
 * Parse a raw 9-byte `60 A0` probe response into structured fields.
 *
 * Layout (confirmed empirically with a Numonyx 0x20/0x50 capacity-0x12
 * test cart returning `20 50 12 00 00 20 50 12 03`):
 *   bytes 0..2 — JEDEC ID (manufacturer + device-type + capacity)
 *   bytes 3..4 — padding / extended-ID space (typically 00 00)
 *   bytes 5..7 — JEDEC ID repeated (firmware-internal verification)
 *   byte 8     — family code (0x01 / 0x02 / 0x03 / other)
 */
export interface ParsedProbeResponse {
  jedec: readonly [number, number, number];
  /** Family code byte. 0x03 = SPI flash with JEDEC (most retail carts). */
  familyCode: number;
  /** True if bytes 0..2 match bytes 5..7 — sanity check that the
   *  firmware's two reads agree on the chip ID. */
  jedecConsistent: boolean;
}

/** Minimum bytes needed to make the `jedecConsistent` check meaningful
 *  (covers raw[0..7]; familyCode at raw[8] is allowed to be missing —
 *  defaults to 0 below). Matches PROBE_JEDEC_RESPONSE_LEN on full reads. */
const PROBE_CONSISTENT_MIN_LEN = 8;

export function parseProbeResponse(raw: Uint8Array): ParsedProbeResponse {
  return {
    jedec: [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0],
    familyCode: raw[8] ?? 0,
    jedecConsistent:
      raw.length >= PROBE_CONSISTENT_MIN_LEN &&
      raw[0] === raw[5] &&
      raw[1] === raw[6] &&
      raw[2] === raw[7],
  };
}
