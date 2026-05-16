import { describe, it, expect } from "vitest";
import { eepromWrapsAt } from "./powersave-3ds-driver";

describe("eepromWrapsAt", () => {
  const base = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  ]);

  it("matches when wrapRead[1..15] equals base[0..14]", () => {
    // wrapRead[0] is the byte at the wrap address; it can be anything.
    const wrap = new Uint8Array([99, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(eepromWrapsAt(base, wrap)).toBe(true);
  });

  it("ignores wrapRead[0] entirely", () => {
    const a = new Uint8Array([0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const b = new Uint8Array([0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(eepromWrapsAt(base, a)).toBe(true);
    expect(eepromWrapsAt(base, b)).toBe(true);
  });

  it("rejects when the last wrapped byte diverges", () => {
    const wrap = new Uint8Array([99, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 99]);
    expect(eepromWrapsAt(base, wrap)).toBe(false);
  });

  it("rejects when the first wrapped byte diverges", () => {
    const wrap = new Uint8Array([99, 99, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(eepromWrapsAt(base, wrap)).toBe(false);
  });

  it("rejects when the buffer wraps to garbage (no relation to base)", () => {
    const wrap = new Uint8Array([0x00, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55]);
    expect(eepromWrapsAt(base, wrap)).toBe(false);
  });

  it("treats short reads as non-wrapping (defensive)", () => {
    const wrap = new Uint8Array([99, 1, 2, 3]);
    expect(eepromWrapsAt(base, wrap)).toBe(false);
  });
});
