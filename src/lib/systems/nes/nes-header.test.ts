import { describe, it, expect } from "vitest";
import { buildNes2Header } from "./nes-header";

/** Every NES 2.0 header carries the magic and the 2.0 indicator (byte 7 bits 2-3 = 10). */
function expectNes2Magic(h: Uint8Array) {
  expect(Array.from(h.subarray(0, 4))).toEqual([0x4e, 0x45, 0x53, 0x1a]);
  expect(h[7] & 0x0c).toBe(0x08);
  expect(h).toHaveLength(16);
}

describe("buildNes2Header", () => {
  it("encodes NROM (mapper 0), 32 KiB PRG / 8 KiB CHR, horizontal", () => {
    const h = buildNes2Header({
      prgBytes: 32768,
      chrBytes: 8192,
      mapper: 0,
      mirroring: "horizontal",
      battery: false,
    });
    expectNes2Magic(h);
    expect(h[4]).toBe(2); // PRG in 16 KiB units
    expect(h[5]).toBe(1); // CHR in 8 KiB units
    expect(h[6]).toBe(0x00); // mapper 0, horizontal, no battery
    expect(h[7]).toBe(0x08);
    expect(h[8]).toBe(0x00);
    expect(h[12]).toBe(0x00); // NTSC
  });

  it("encodes MMC3 (mapper 4) with battery PRG-NVRAM", () => {
    const h = buildNes2Header({
      prgBytes: 262144, // 256 KiB
      chrBytes: 131072, // 128 KiB
      mapper: 4,
      mirroring: "mapper_controlled",
      battery: true,
      prgNvramKB: 8,
    });
    expectNes2Magic(h);
    expect(h[4]).toBe(16);
    expect(h[5]).toBe(16);
    expect(h[6]).toBe(0x42); // mapper 4 low nibble in high nibble + battery bit
    expect(h[7]).toBe(0x08);
    // 8 KiB NVRAM = 64 << 7 → shift 7 in the high nibble of byte 10.
    expect(h[10]).toBe(0x70);
  });

  it("encodes GxROM (mapper 66), vertical, splitting the mapper nibbles", () => {
    const h = buildNes2Header({
      prgBytes: 131072, // 128 KiB
      chrBytes: 32768, // 32 KiB
      mapper: 66,
      mirroring: "vertical",
      battery: false,
    });
    expectNes2Magic(h);
    expect(h[4]).toBe(8);
    expect(h[5]).toBe(4);
    expect(h[6]).toBe(0x21); // (66 & 0x0f) << 4 = 0x20, plus vertical bit 0x01
    expect(h[7]).toBe(0x48); // (66 & 0xf0) | 0x08
  });

  it("sets the four-screen flag", () => {
    const h = buildNes2Header({
      prgBytes: 32768,
      chrBytes: 8192,
      mapper: 0,
      mirroring: "four_screen",
      battery: false,
    });
    expect(h[6] & 0x08).toBe(0x08);
  });

  it("records CHR-RAM size for a CHR-RAM cart", () => {
    const h = buildNes2Header({
      prgBytes: 32768,
      chrBytes: 0,
      mapper: 0,
      mirroring: "horizontal",
      battery: false,
      chrRamKB: 8,
    });
    expect(h[5]).toBe(0); // no CHR-ROM
    expect(h[11]).toBe(0x07); // 8 KiB = 64 << 7 → shift 7 in the low nibble
  });

  it("rejects a RAM size that isn't 64 << n", () => {
    expect(() =>
      buildNes2Header({
        prgBytes: 32768,
        chrBytes: 8192,
        mapper: 0,
        mirroring: "horizontal",
        battery: false,
        prgRamKB: 3, // 3072 bytes — not a valid shift size
      }),
    ).toThrow();
  });

  it("encodes a mapper-268 multicart: mapper MSBs, volatile work RAM, big CHR-RAM", () => {
    const h = buildNes2Header({
      prgBytes: 2048 * 1024,
      chrBytes: 0,
      mapper: 268,
      mirroring: "mapper_controlled",
      battery: false,
      chrRamKB: 256,
      prgRamKB: 8, // unbatteried trampoline RAM — byte 10 LOW nibble
    });
    expectNes2Magic(h);
    expect(h[4]).toBe(128); // 2 MiB = 128 x 16 KiB
    expect(h[6] >> 4).toBe(268 & 0x0f);
    expect(h[7] & 0xf0).toBe(268 & 0xf0);
    expect(h[8] & 0x0f).toBe(268 >> 8);
    expect(h[10]).toBe(0x07); // volatile 8 KiB, no NVRAM
    expect(h[11]).toBe(0x0c); // 256 KiB CHR-RAM = 64 << 12
  });

  it("spills PRG/CHR sizes >= 4 MiB into the byte-9 MSB nibbles", () => {
    const h = buildNes2Header({
      prgBytes: 32768 * 1024, // 32 MiB = 0x800 x 16 KiB units
      chrBytes: 4096 * 1024, // 4 MiB = 0x200 x 8 KiB units
      mapper: 268,
      mirroring: "mapper_controlled",
      battery: false,
    });
    expect(h[4]).toBe(0x00);
    expect(h[5]).toBe(0x00);
    expect(h[9]).toBe(0x28); // CHR MSB nibble 2 (high), PRG MSB nibble 8 (low)
  });

  it("rejects sizes past the plain-form ceiling instead of wrapping", () => {
    expect(() =>
      buildNes2Header({
        prgBytes: 0xf00 * 16384, // first unit count that needs exponent form
        chrBytes: 0,
        mapper: 268,
        mirroring: "mapper_controlled",
        battery: false,
      }),
    ).toThrow(/too large/);
  });
});

describe("buildNes2Header miscellaneous-ROM count (mapper 413)", () => {
  it("encodes the mapper-413 board: split mapper nibbles and byte-14 misc count", () => {
    const h = buildNes2Header({
      prgBytes: 262144, // 256 KiB
      chrBytes: 262144, // 256 KiB
      mapper: 413,
      mirroring: "vertical",
      battery: false,
      miscRoms: 1,
    });
    expectNes2Magic(h);
    expect(h[4]).toBe(16); // 256 KiB PRG in 16 KiB units
    expect(h[5]).toBe(32); // 256 KiB CHR in 8 KiB units
    expect(h[6]).toBe(0xd1); // mapper low nibble 0xD, vertical mirroring
    expect(h[7]).toBe(0x98); // mapper mid nibble 9, NES 2.0 indicator
    expect(h[8]).toBe(0x01); // mapper high bits 1, submapper 0
    expect(h[14]).toBe(0x01); // one miscellaneous ROM follows CHR
  });

  it("defaults the misc-ROM count to zero", () => {
    const h = buildNes2Header({
      prgBytes: 32768,
      chrBytes: 8192,
      mapper: 0,
      mirroring: "horizontal",
      battery: false,
    });
    expect(h[14]).toBe(0x00);
  });
});
