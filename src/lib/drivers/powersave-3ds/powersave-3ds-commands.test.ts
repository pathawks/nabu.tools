import { describe, it, expect } from "vitest";
import { flashSizeFromJedec } from "./powersave-3ds-commands";

describe("flashSizeFromJedec", () => {
  it("decodes the documented common DS save-FLASH capacities", () => {
    expect(flashSizeFromJedec(0x13)).toBe(512 * 1024);
    expect(flashSizeFromJedec(0x14)).toBe(1024 * 1024);
    expect(flashSizeFromJedec(0x15)).toBe(2 * 1024 * 1024);
    expect(flashSizeFromJedec(0x16)).toBe(4 * 1024 * 1024);
  });

  it("returns null below the accepted range so the caller errors instead of guessing", () => {
    expect(flashSizeFromJedec(0x00)).toBeNull();
    expect(flashSizeFromJedec(0x0f)).toBeNull();
  });

  it("returns null above 0x18 — beyond that range 1<<n overflows JS's 32-bit signed shift", () => {
    expect(flashSizeFromJedec(0x18)).toBe(16 * 1024 * 1024);
    expect(flashSizeFromJedec(0x19)).toBeNull();
    expect(flashSizeFromJedec(0x1f)).toBeNull();
  });
});
