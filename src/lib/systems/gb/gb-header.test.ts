import { describe, it, expect } from "vitest";
import { parseGBHeader } from "./gb-header";

/** Build a 0x150-byte GB header with a valid checksum, plus any overrides. */
function buildGBHeader(
  overrides: {
    title?: string;
    cartType?: number;
    romSizeCode?: number;
    ramSizeCode?: number;
  } = {},
): Uint8Array {
  const buf = new Uint8Array(0x150);
  const title = overrides.title ?? "TESTGAME";
  for (let i = 0; i < title.length && i < 16; i++) {
    buf[0x134 + i] = title.charCodeAt(i);
  }
  buf[0x147] = overrides.cartType ?? 0x1b; // MBC5+RAM+BATTERY
  buf[0x148] = overrides.romSizeCode ?? 0x00; // 32 KB
  buf[0x149] = overrides.ramSizeCode ?? 0x03; // 32 KB
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - buf[i] - 1) & 0xff;
  buf[0x14d] = checksum;
  return buf;
}

describe("parseGBHeader", () => {
  it("returns null for a buffer shorter than the header", () => {
    expect(parseGBHeader(new Uint8Array(0x14f))).toBeNull();
  });

  it("validates the checksum of a well-formed header", () => {
    const header = parseGBHeader(buildGBHeader());
    expect(header).not.toBeNull();
    expect(header!.headerChecksumValid).toBe(true);
  });

  it("flags an invalid checksum when a covered byte changes", () => {
    const buf = buildGBHeader();
    buf[0x147] ^= 0xff; // mutate cart type without recomputing the checksum
    expect(parseGBHeader(buf)!.headerChecksumValid).toBe(false);
  });

  it("decodes the title, stopping at the null terminator", () => {
    expect(parseGBHeader(buildGBHeader({ title: "TESTGAME" }))!.title).toBe(
      "TESTGAME",
    );
  });

  it("strips non-printable bytes from the title", () => {
    const buf = buildGBHeader();
    [0x54, 0x45, 0x01, 0x53, 0x54].forEach((b, i) => (buf[0x134 + i] = b));
    buf[0x139] = 0; // null-terminate after the five title bytes
    expect(parseGBHeader(buf)!.title).toBe("TEST");
  });

  it("forces 512 bytes of RAM for MBC2 regardless of the RAM-size byte", () => {
    const header = parseGBHeader(
      buildGBHeader({ cartType: 0x06, ramSizeCode: 0x00 }), // MBC2+BATTERY
    )!;
    expect(header.mbc).toBe("MBC2");
    expect(header.ramSize).toBe(512);
  });

  it("decodes ROM and RAM sizes from their header codes", () => {
    const header = parseGBHeader(
      buildGBHeader({ romSizeCode: 0x01, ramSizeCode: 0x02 }),
    )!;
    expect(header.romSize).toBe(64 * 1024);
    expect(header.ramSize).toBe(8 * 1024);
  });
});
