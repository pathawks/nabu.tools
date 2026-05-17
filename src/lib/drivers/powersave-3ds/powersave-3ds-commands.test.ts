import { describe, it, expect } from "vitest";
import {
  flashSizeFromJedec,
  isIrModuleJedecSignature,
} from "./powersave-3ds-commands";

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

describe("isIrModuleJedecSignature", () => {
  it("matches both observed IR-module responses (00 7F 00 and 00 7F FF)", () => {
    expect(isIrModuleJedecSignature(new Uint8Array([0x00, 0x7f, 0x00]))).toBe(
      true,
    );
    expect(isIrModuleJedecSignature(new Uint8Array([0x00, 0x7f, 0xff]))).toBe(
      true,
    );
  });

  it("matches any third byte — third position is whatever the IR buffer held", () => {
    expect(isIrModuleJedecSignature(new Uint8Array([0x00, 0x7f, 0x42]))).toBe(
      true,
    );
  });

  it("rejects an all-zero response (real EEPROM has no JEDEC support)", () => {
    expect(isIrModuleJedecSignature(new Uint8Array([0x00, 0x00, 0x00]))).toBe(
      false,
    );
  });

  it("rejects a real SPI-FLASH JEDEC ID (manufacturer codes start at 0x01)", () => {
    // ST Microelectronics M25P40: c2 20 13
    expect(isIrModuleJedecSignature(new Uint8Array([0xc2, 0x20, 0x13]))).toBe(
      false,
    );
  });

  it("rejects responses shorter than 2 bytes", () => {
    expect(isIrModuleJedecSignature(new Uint8Array([0x00]))).toBe(false);
    expect(isIrModuleJedecSignature(new Uint8Array(0))).toBe(false);
  });
});
