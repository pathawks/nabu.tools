import type {
  DeviceDriver,
  CartridgeInfo,
  SystemId,
} from "@/lib/types";

/**
 * NDS cart-header parsing — shared between all NDS-capable drivers.
 *
 * Reference: https://problemkaputt.de/gbatek.htm#dscartridgeheader
 *
 * The on-cart header is 0x200 bytes at ROM offset 0. Fields we care
 * about for UI display + integrity validation:
 *
 *   0x000..0x00B   Title (12 bytes, ASCII, null-padded)
 *   0x00C..0x00F   Game code (4 bytes, A-Z/0-9; last char is region)
 *   0x010..0x011   Maker code (2 bytes, A-Z/0-9)
 *   0x014          Capacity (ROM size = 1 << (cap - 3) MiB; typical 4..12)
 *   0x01E          ROM version
 *   0x0C0..0x15B   Boot logo (156 bytes, byte-identical on every real
 *                  NDS cart)
 *   0x15C..0x15D   Logo CRC-16/MODBUS (fixed at 0xCF56 on all real carts)
 *   0x15E..0x15F   Header CRC-16/MODBUS (covers bytes 0x000..0x15D)
 *
 * Validation uses the two CRCs plus the fixed-logo-CRC check to give
 * strong confidence the header was read verbatim — an off-by-one or
 * bus-corrupted read will fail at least one of the three checks.
 *
 * 3DS carts return 0x200 bytes of all-0xFF when asked for the NDS
 * header (they use a different slot-1 header format). `headerAllFF`
 * lets a driver flag that case without misclassifying the cart as
 * "no cartridge."
 */

const NDS_REGIONS: Record<string, string> = {
  J: "Japan",
  E: "USA",
  P: "Europe",
  K: "Korea",
  U: "Australia",
  C: "China",
  D: "Germany",
  F: "France",
  I: "Italy",
  S: "Spain",
  H: "Netherlands",
  R: "Russia",
  W: "International",
};

const VALID_REGION_CHARS = new Set(
  Object.keys(NDS_REGIONS).map((c) => c.charCodeAt(0)),
);

/** Fixed CRC-16 of the 156-byte boot logo at 0x0C0..0x15B on every real NDS cart. */
export const BOOT_LOGO_CRC = 0xcf56;

/** Parsed NDS cart header. */
export interface CardHeader {
  title: string;
  gameCode: string;
  makerCode: string;
  region: string;
  romVersion: number;
  romSizeMiB: number;
  /** All three CRC signals matched and gameCode is alphanumeric. */
  validHeader: boolean;
  /** The input buffer was all 0xFF — the cart is a 3DS cart, not an NDS cart. */
  headerAllFF: boolean;
  raw: Uint8Array;
}

/**
 * CRC-16/MODBUS — polynomial 0xA001 (reflected 0x8005), init 0xFFFF,
 * no final XOR. NDS carts use this variant for both the logo CRC at
 * 0x15C and the header CRC at 0x15E.
 */
export function crc16Modbus(buf: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/**
 * Scan the first 64 bytes of `raw` for an offset where a valid NDS
 * header begins. Most drivers read the header cleanly at offset 0;
 * some (PowerSaves 3DS) get a short firmware-produced preamble before
 * the real header. Returns -1 if no valid position found.
 *
 * Validation signals per candidate offset:
 *   - title bytes (0..11) are printable ASCII or null
 *   - title[0] is alphanumeric (real titles don't start with punctuation)
 *   - title has ≥ 3 alphanumeric characters
 *   - gameCode (0x0C..0x0F) is all alphanumeric
 *   - gameCode[3] is a known NDS region letter
 *   - capacity byte (0x14) is ≤ 0x0F (real carts are 3..12)
 *
 * Together these reject the nondeterministic preamble bytes some
 * firmwares return before the real header.
 */
export function findHeaderStart(raw: Uint8Array): number {
  const isAlnum = (b: number) =>
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a);
  const isTitleByte = (b: number) =>
    b === 0x00 || (b >= 0x20 && b <= 0x7e);

  const limit = Math.min(raw.length - 0x20, 64);
  for (let offset = 0; offset < limit; offset++) {
    let titleOk = true;
    let titleAlnum = 0;
    for (let i = 0; i < 12; i++) {
      const b = raw[offset + i];
      if (!isTitleByte(b)) {
        titleOk = false;
        break;
      }
      if (isAlnum(b)) titleAlnum++;
    }
    if (!titleOk) continue;
    if (!isAlnum(raw[offset])) continue;
    if (titleAlnum < 3) continue;

    let codeOk = true;
    for (let i = 0x0c; i < 0x12; i++) {
      if (!isAlnum(raw[offset + i])) {
        codeOk = false;
        break;
      }
    }
    if (!codeOk) continue;

    if (!VALID_REGION_CHARS.has(raw[offset + 0x0f])) continue;

    const cap = raw[offset + 0x14];
    if (cap > 0x0f) continue;

    return offset;
  }
  return -1;
}

/**
 * Parse and validate an NDS cart header buffer (at least 0x160 bytes;
 * 0x200 is the standard full-header size). Drivers whose reads produce
 * a small preamble before the real header should pass the raw buffer
 * here — findHeaderStart will scan for the correct offset.
 *
 * Resolves makerCode through the caller-supplied lookup (pass a map of
 * 2-char maker codes → publisher names).
 */
export function parseNDSHeader(
  raw: Uint8Array,
  makerCodes: Record<string, string>,
): CardHeader {
  const headerAllFF = raw.length > 0 && raw.every((b) => b === 0xff);
  const blank: CardHeader = {
    title: "Unknown",
    gameCode: "????",
    makerCode: "",
    region: "",
    romVersion: 0,
    romSizeMiB: 0,
    validHeader: false,
    headerAllFF,
    raw,
  };
  if (raw.length < 0x20) return blank;
  if (headerAllFF || raw.every((b) => b === 0x00)) return blank;

  const start = findHeaderStart(raw);
  if (start < 0 || raw.length < start + 0x20) return blank;
  const hdr = raw.subarray(start);

  const decoder = new TextDecoder("ascii");
  const title = decoder.decode(hdr.slice(0, 12)).replace(/\0+$/, "").trim();
  const gameCode = decoder.decode(hdr.slice(0x0c, 0x10));
  const makerRaw = decoder.decode(hdr.slice(0x10, 0x12));
  const makerCode = makerCodes[makerRaw] ?? makerRaw;
  const romVersion = hdr[0x1e];
  const capacity = hdr[0x14];
  const romSizeMiB = capacity > 3 ? 1 << (capacity - 3) : 0;
  const regionChar = gameCode[3] ?? "";
  const region = NDS_REGIONS[regionChar] ?? regionChar;

  let validHeader = false;
  if (hdr.length >= 0x160 && /^[A-Z0-9]{4}$/.test(gameCode)) {
    const storedHeaderCrc = hdr[0x15e] | (hdr[0x15f] << 8);
    const computedHeaderCrc = crc16Modbus(hdr.subarray(0, 0x15e));
    const storedLogoCrc = hdr[0x15c] | (hdr[0x15d] << 8);
    const computedLogoCrc = crc16Modbus(hdr.subarray(0xc0, 0x15c));
    validHeader =
      storedHeaderCrc === computedHeaderCrc &&
      storedLogoCrc === computedLogoCrc &&
      computedLogoCrc === BOOT_LOGO_CRC;
  }

  return {
    title,
    gameCode,
    makerCode,
    region,
    romVersion,
    romSizeMiB,
    validHeader,
    headerAllFF: false,
    raw,
  };
}

/**
 * Family the cart belongs to, classified from the chip-ID byte 3 plus
 * the all-0xFF-header flag:
 *
 *   - "3DS": header read returned all 0xFF (cart isn't speaking NDS slot-1
 *     format at all — almost always a 3DS cart, occasionally a DS cart
 *     with dirty contacts)
 *   - "DSi": chip-ID byte 3 has bit 0x40 (DSi-Enhanced flag) set — the
 *     cart carries the DSi extended header and feature set. Bit 0x80 is
 *     a separate axis (1T-ROM / NAND silicon vs MROM) and is NOT used
 *     for this classification.
 *   - "DS":  everything else
 */
export type NDSCartFamily = "DS" | "DSi" | "3DS";

/**
 * Typed cart metadata returned by NDS drivers. The `Record<string,
 * unknown>` intersection keeps `CartridgeInfo<NDSCartMeta>` assignable
 * to the default `CartridgeInfo<Record<string, unknown>>`, so
 * NDSDeviceDriver can widen-return cleanly into the base DeviceDriver
 * interface.
 */
export type NDSCartMeta = Record<string, unknown> & {
  gameCode?: string;
  makerCode?: string;
  region?: string;
  romVersion?: number;
  romSizeMiB?: number;
  /** NDS cart chip ID (NTR opcode 0x90, 4 bytes) as a hex string. */
  chipId?: string;
  /** Classified cart family (DS / DSi / 3DS). See NDSCartFamily. */
  cartFamily?: NDSCartFamily;
  /**
   * True if the cart returned an all-0xFF slot-1 header. Usually a 3DS
   * cart (slot-1 format mismatch), but can also indicate an NDS cart
   * with dirty contacts — the driver logs a warning in both cases.
   * Retained alongside cartFamily so callers can distinguish "3DS cart"
   * from "DS cart that wouldn't respond" if needed.
   */
  is3DS?: boolean;
};

/**
 * Classify a cart from its 4-byte chip-ID (as a hex string from NDS NTR
 * opcode 0x90) and the all-0xFF-header signal. Both inputs are
 * optional: an empty chipId or missing-header signal yields "DS" by
 * default, which is the right floor when we don't have enough data to
 * say otherwise.
 */
export function classifyNDSCart(opts: {
  chipIdHex?: string;
  headerAllFF?: boolean;
}): NDSCartFamily {
  if (opts.headerAllFF) return "3DS";
  const hex = opts.chipIdHex?.replace(/\s+/g, "");
  if (hex && hex.length >= 8) {
    const byte3 = parseInt(hex.slice(6, 8), 16);
    if ((byte3 & 0x40) !== 0) return "DSi";
  }
  return "DS";
}

export type NDSCartridgeInfo = CartridgeInfo<NDSCartMeta>;

/**
 * Build a fully-populated NDSCartridgeInfo from a parsed header and
 * a few optional bits of state. Every NDS-capable driver builds
 * essentially the same struct after detect; this helper centralizes
 * the mapping so the drivers don't drift.
 *
 * - Fields gated on `validHeader`: title, gameCode, makerCode, region,
 *   romVersion, romSizeMiB. When the header CRC didn't validate we
 *   keep those undefined so the UI can show "Unrecognized cart"
 *   rather than parade ASCII garbage.
 * - cartFamily (DS / DSi / 3DS) is derived from chipIdHex + headerAllFF
 *   via classifyNDSCart.
 */
export function buildNDSCartInfoFromHeader(opts: {
  header: CardHeader | null;
  chipIdHex?: string;
  saveSize?: number;
  saveType?: string;
}): NDSCartridgeInfo {
  const valid = opts.header?.validHeader ?? false;
  const headerAllFF = opts.header?.headerAllFF ?? false;
  const cartFamily = classifyNDSCart({
    chipIdHex: opts.chipIdHex,
    headerAllFF,
  });
  return {
    title: valid ? opts.header?.title : undefined,
    rawHeader: opts.header?.raw,
    saveSize: opts.saveSize,
    saveType: opts.saveType,
    meta: {
      gameCode: valid ? opts.header?.gameCode : undefined,
      makerCode: valid ? opts.header?.makerCode : undefined,
      region: valid ? opts.header?.region : undefined,
      romVersion: valid ? opts.header?.romVersion : undefined,
      romSizeMiB: valid ? opts.header?.romSizeMiB : undefined,
      chipId: opts.chipIdHex || undefined,
      cartFamily,
      is3DS: headerAllFF,
    },
  };
}

/**
 * Specialization of DeviceDriver for NDS-system drivers. Consumers that
 * need the enriched cart info (scanner hook, wizard UI) should accept
 * this narrower type.
 */
export interface NDSDeviceDriver extends DeviceDriver {
  readonly cartInfo: NDSCartridgeInfo | null;
  detectCartridge(systemId: SystemId): Promise<NDSCartridgeInfo | null>;
}
