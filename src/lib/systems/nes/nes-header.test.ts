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
});
