import { describe, it, expect } from "vitest";
import { parseGBAHeader } from "./gba-header";

/** Build a 0xC0-byte GBA header with a valid checksum, plus any overrides. */
function buildGBAHeader(
  overrides: { title?: string; gameCode?: string; makerCode?: string } = {},
): Uint8Array {
  const buf = new Uint8Array(0xc0);
  const write = (offset: number, s: string, max: number) => {
    for (let i = 0; i < s.length && i < max; i++) {
      buf[offset + i] = s.charCodeAt(i);
    }
  };
  write(0xa0, overrides.title ?? "TESTGAME", 12);
  write(0xac, overrides.gameCode ?? "TEST", 4);
  write(0xb0, overrides.makerCode ?? "ZZ", 2);
  let checksum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) checksum = (checksum + buf[i]) & 0xff;
  buf[0xbd] = (-(checksum + 0x19)) & 0xff;
  return buf;
}

describe("parseGBAHeader", () => {
  it("returns null for a buffer shorter than 0xC0", () => {
    expect(parseGBAHeader(new Uint8Array(0xbf))).toBeNull();
  });

  it("validates the checksum of a well-formed header", () => {
    expect(parseGBAHeader(buildGBAHeader())!.headerChecksumValid).toBe(true);
  });

  it("flags an invalid checksum when a covered byte changes", () => {
    const buf = buildGBAHeader();
    buf[0xa0] ^= 0xff; // mutate the title without recomputing the checksum
    expect(parseGBAHeader(buf)!.headerChecksumValid).toBe(false);
  });

  it("decodes title, game code, and maker code", () => {
    const header = parseGBAHeader(
      buildGBAHeader({ title: "TESTROM", gameCode: "ZZZZ", makerCode: "00" }),
    )!;
    expect(header.title).toBe("TESTROM");
    expect(header.gameCode).toBe("ZZZZ");
    expect(header.makerCode).toBe("00");
  });
});
