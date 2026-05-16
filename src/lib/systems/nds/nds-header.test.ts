import { describe, it, expect } from "vitest";
import {
  crc16Modbus,
  parseNDSHeader,
  classifyNDSCart,
  BOOT_LOGO_CRC,
} from "./nds-header";

describe("crc16Modbus", () => {
  it("returns 0xFFFF for an empty buffer (init value, no input)", () => {
    expect(crc16Modbus(new Uint8Array(0))).toBe(0xffff);
  });

  it("matches the standard CRC-16/MODBUS vector for ASCII '123456789'", () => {
    const buf = new TextEncoder().encode("123456789");
    expect(crc16Modbus(buf)).toBe(0x4b37);
  });

  it("differs when a single byte changes", () => {
    const a = new TextEncoder().encode("123456789");
    const b = new TextEncoder().encode("123456780");
    expect(crc16Modbus(a)).not.toBe(crc16Modbus(b));
  });
});

describe("parseNDSHeader", () => {
  it("flags all-0xFF input as a 3DS-style header (headerAllFF)", () => {
    const buf = new Uint8Array(0x200).fill(0xff);
    const parsed = parseNDSHeader(buf, {});
    expect(parsed.headerAllFF).toBe(true);
    expect(parsed.validHeader).toBe(false);
    expect(parsed.gameCode).toBe("????");
  });

  it("returns blank for all-zero input without setting headerAllFF", () => {
    const buf = new Uint8Array(0x200);
    const parsed = parseNDSHeader(buf, {});
    expect(parsed.headerAllFF).toBe(false);
    expect(parsed.validHeader).toBe(false);
  });

  it("returns blank when the buffer is shorter than the title block", () => {
    const parsed = parseNDSHeader(new Uint8Array(16), {});
    expect(parsed.validHeader).toBe(false);
    expect(parsed.title).toBe("Unknown");
  });

  it("rejects a structurally valid header whose stored header CRC is wrong", () => {
    const buf = makeHeader();
    buf[0x15e] ^= 0xff; // corrupt header CRC
    const parsed = parseNDSHeader(buf, {});
    expect(parsed.validHeader).toBe(false);
  });

  it("rejects a header whose stored logo CRC differs from BOOT_LOGO_CRC", () => {
    const buf = makeHeader();
    // Overwrite the boot logo with bytes that CRC to something other than
    // BOOT_LOGO_CRC, then recompute the header CRC over the rewritten
    // region so the *header* CRC still validates — the logo CRC is the
    // only signal failing.
    buf.fill(0x42, 0xc0, 0x15c);
    const wrongLogoCrc = crc16Modbus(buf.subarray(0xc0, 0x15c));
    buf[0x15c] = wrongLogoCrc & 0xff;
    buf[0x15d] = (wrongLogoCrc >>> 8) & 0xff;
    const headerCrc = crc16Modbus(buf.subarray(0, 0x15e));
    buf[0x15e] = headerCrc & 0xff;
    buf[0x15f] = (headerCrc >>> 8) & 0xff;

    const parsed = parseNDSHeader(buf, {});
    expect(parsed.validHeader).toBe(false);
    expect(wrongLogoCrc).not.toBe(BOOT_LOGO_CRC);
  });

  it("accepts a header whose logo CRC, logo-CRC field, and header CRC all match", () => {
    const buf = makeHeader();
    const parsed = parseNDSHeader(buf, { "01": "Acme Games" });
    expect(parsed.validHeader).toBe(true);
    expect(parsed.title).toBe("TESTGAME");
    expect(parsed.gameCode).toBe("BTGE");
    expect(parsed.makerCode).toBe("Acme Games");
    expect(parsed.region).toBe("USA");
    expect(parsed.romSizeMiB).toBe(64);
    expect(parsed.romVersion).toBe(0x01);
    expect(parsed.headerAllFF).toBe(false);
  });

  it("exposes the stored header CRC for use as a cart-identity field", () => {
    const buf = makeHeader();
    const parsed = parseNDSHeader(buf, {});
    const expected = buf[0x15e] | (buf[0x15f] << 8);
    expect(parsed.headerCrc).toBe(expected);
  });

  it("leaves headerCrc undefined when the header fails validation", () => {
    const buf = makeHeader();
    buf[0x15e] ^= 0xff; // corrupt header CRC
    const parsed = parseNDSHeader(buf, {});
    expect(parsed.validHeader).toBe(false);
    expect(parsed.headerCrc).toBeUndefined();
  });

  it("reports 1 MiB ROM size for capacity byte 0x03 (formula boundary)", () => {
    const buf = makeHeader();
    buf[0x14] = 0x03;
    const headerCrc = crc16Modbus(buf.subarray(0, 0x15e));
    buf[0x15e] = headerCrc & 0xff;
    buf[0x15f] = (headerCrc >>> 8) & 0xff;
    const parsed = parseNDSHeader(buf, {});
    expect(parsed.validHeader).toBe(true);
    expect(parsed.romSizeMiB).toBe(1);
  });

  it("falls back to the raw maker code when the lookup misses", () => {
    const buf = makeHeader();
    const parsed = parseNDSHeader(buf, {});
    expect(parsed.makerCode).toBe("01");
  });
});

describe("classifyNDSCart", () => {
  it("returns 'DS' by default when nothing is known", () => {
    expect(classifyNDSCart({})).toBe("DS");
  });

  it("returns '3DS' when the slot-1 header read was all-0xFF", () => {
    expect(classifyNDSCart({ headerAllFF: true })).toBe("3DS");
  });

  it("returns 'DSi' when chip-ID byte 3 has the 0x40 bit set", () => {
    // bytes: 00 00 00 4A — byte 3 = 0x4A, bit 0x40 set
    expect(classifyNDSCart({ chipIdHex: "0000004a" })).toBe("DSi");
  });

  it("returns 'DS' when chip-ID byte 3 is 0x80 (no 0x40 bit)", () => {
    expect(classifyNDSCart({ chipIdHex: "00000080" })).toBe("DS");
  });

  it("returns 'DS' when chip-ID hex is too short to read byte 3", () => {
    expect(classifyNDSCart({ chipIdHex: "abc" })).toBe("DS");
  });

  it("prefers '3DS' over chip-ID-derived family when both apply", () => {
    expect(
      classifyNDSCart({ chipIdHex: "0000004a", headerAllFF: true }),
    ).toBe("3DS");
  });
});

// ─── helpers ────────────────────────────────────────────────────────────

/**
 * Build a 0x200-byte NDS-shaped header with valid CRCs. Synthesises
 * 156 placeholder logo bytes whose CRC happens to equal BOOT_LOGO_CRC
 * (brute-force in the last two bytes; finishes in milliseconds).
 */
function makeHeader(): Uint8Array {
  const buf = new Uint8Array(0x200);
  const enc = new TextEncoder();
  buf.set(enc.encode("TESTGAME"), 0); // title
  buf.set(enc.encode("BTGE"), 0x0c); // game code
  buf.set(enc.encode("01"), 0x10); // maker
  buf[0x14] = 0x09; // capacity → 1 << (9-3) = 64 MiB
  buf[0x1e] = 0x01; // ROM version

  // 156-byte logo whose CRC matches BOOT_LOGO_CRC.
  const logo = synthesizeLogoBytes();
  buf.set(logo, 0xc0);

  const logoCrc = crc16Modbus(buf.subarray(0xc0, 0x15c));
  buf[0x15c] = logoCrc & 0xff;
  buf[0x15d] = (logoCrc >>> 8) & 0xff;

  const headerCrc = crc16Modbus(buf.subarray(0, 0x15e));
  buf[0x15e] = headerCrc & 0xff;
  buf[0x15f] = (headerCrc >>> 8) & 0xff;

  return buf;
}

function synthesizeLogoBytes(): Uint8Array {
  const logo = new Uint8Array(156);
  for (let n = 0; n < 0x10000; n++) {
    logo[154] = (n >>> 8) & 0xff;
    logo[155] = n & 0xff;
    if (crc16Modbus(logo) === BOOT_LOGO_CRC) return logo;
  }
  throw new Error("Could not synthesize logo bytes matching BOOT_LOGO_CRC");
}
