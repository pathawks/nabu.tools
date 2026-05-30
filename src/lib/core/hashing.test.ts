import { describe, it, expect } from "vitest";
import { crc32, deriveContentCrc } from "./hashing";

describe("crc32", () => {
  it("returns 0 for an empty buffer", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("matches the standard CRC-32 vector for ASCII '123456789'", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("returns an unsigned 32-bit value when the high bit is set", () => {
    const crc = crc32(new Uint8Array([0xff]));
    expect(crc).toBe(crc >>> 0);
    expect(crc).toBeGreaterThanOrEqual(0);
  });

  it("differs when a single byte changes", () => {
    const a = new TextEncoder().encode("123456789");
    const b = new TextEncoder().encode("123456780");
    expect(crc32(a)).not.toBe(crc32(b));
  });
});

describe("deriveContentCrc", () => {
  it("recovers the content CRC from the full-file CRC and header bytes", () => {
    const header = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const content = new TextEncoder().encode("the actual ROM body goes here");
    const full = new Uint8Array(header.length + content.length);
    full.set(header, 0);
    full.set(content, header.length);

    const derived = deriveContentCrc(crc32(full), header, content.length);
    expect(derived).toBe(crc32(content));
  });

  it("stays unsigned when the derived CRC has the high bit set", () => {
    const header = new Uint8Array([1, 2, 3, 4]);
    const content = new Uint8Array([0xff, 0x00, 0xff, 0x80]);
    const full = new Uint8Array([...header, ...content]);

    const derived = deriveContentCrc(crc32(full), header, content.length);
    expect(derived).toBe(derived >>> 0);
    expect(derived).toBe(crc32(content));
  });
});
