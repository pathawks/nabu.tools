import { describe, it, expect } from "vitest";
import { classifyKazzoFirmware } from "./firmware-m2";
import { VERSION_STRING_SIZE } from "./kazzo-opcodes";

/**
 * The firmware-era classifier behind the M2-idle gate. Fail-safe is the
 * invariant under test: only the two known-capable fingerprints — the
 * clipped build's erased version section (32 × 0xFF) and a NUL-terminated
 * pre-flip version string — may open the gate; every other shape, however
 * plausible, classifies as idle-low.
 */

/** A NUL-terminated, zero-padded 32-byte version section. */
function versionBytes(s: string): Uint8Array {
  const out = new Uint8Array(VERSION_STRING_SIZE);
  out.set(new TextEncoder().encode(s));
  return out;
}

describe("classifyKazzoFirmware", () => {
  it("gates 32 bytes of 0xFF (blank version section is not an identity)", () => {
    const r = classifyKazzoFirmware(
      new Uint8Array(VERSION_STRING_SIZE).fill(0xff),
    );
    expect(r.m2IdleHigh).toBe(false);
    expect(r.label).toMatch(/unidentified build.*0\.1\.3\+m2/);
  });

  it.each([
    ["kazzo16 0.1.3+m2 / Jun 10 2026"],
    ["kazzo16 0.1.3+m2"],
  ])("classifies the m2-idle-high fork %j as M2 idle high", (text) => {
    const r = classifyKazzoFirmware(versionBytes(text));
    expect(r.m2IdleHigh).toBe(true);
    expect(r.label).toBe(text);
  });

  it.each([["kazzo16 0.1.3+m2x / x"], ["kazzo16 0.1.3+m22"]])(
    "does not let the fork-lookalike %j open the gate",
    (text) => {
      expect(classifyKazzoFirmware(versionBytes(text)).m2IdleHigh).toBe(false);
    },
  );

  it.each(["kazzo16 0.1.0", "kazzo16 0.1.1", "kazzo16 0.1.2"])(
    "classifies the pre-flip version %j as M2 idle high",
    (v) => {
      expect(classifyKazzoFirmware(versionBytes(v))).toEqual({
        m2IdleHigh: true,
        label: v,
      });
    },
  );

  it.each([
    "kazzo16 0.1.3", // the 2010-01-25 polarity flip's release, and beyond
    "kazzo16 0.2.0",
    "kazzo^8 0.1.2", // different firmware family
    "anago",
  ])("gates the post-flip / unrecognized version %j", (v) => {
    expect(classifyKazzoFirmware(versionBytes(v))).toEqual({
      m2IdleHigh: false,
      label: v,
    });
  });

  it("does not let a hypothetical 0.1.2x version open the gate", () => {
    expect(
      classifyKazzoFirmware(versionBytes("kazzo16 0.1.20")).m2IdleHigh,
    ).toBe(false);
  });

  it("gates non-printable garbage and labels it by hex fingerprint", () => {
    const bytes = new Uint8Array(VERSION_STRING_SIZE).fill(0x01);
    const r = classifyKazzoFirmware(bytes);
    expect(r.m2IdleHigh).toBe(false);
    expect(r.label).toMatch(/^unknown \(0101/);
  });

  it("gates a printable pre-flip string that lacks the NUL terminator", () => {
    // Not the known fingerprint shape: the real version section is
    // NUL-terminated. An untrusted shape never opens the gate.
    const bytes = new Uint8Array(VERSION_STRING_SIZE).fill(0x20);
    bytes.set(new TextEncoder().encode("kazzo16 0.1.2"));
    expect(classifyKazzoFirmware(bytes).m2IdleHigh).toBe(false);
  });

  it("gates a short read, even one that is all 0xFF", () => {
    const r = classifyKazzoFirmware(new Uint8Array(16).fill(0xff));
    expect(r.m2IdleHigh).toBe(false);
    expect(r.label).toMatch(/short version read/);
  });

  it("gates an empty response", () => {
    expect(classifyKazzoFirmware(new Uint8Array(0)).m2IdleHigh).toBe(false);
  });

  it("gates a failed transfer (null)", () => {
    const r = classifyKazzoFirmware(null);
    expect(r.m2IdleHigh).toBe(false);
    expect(r.label).toMatch(/version read failed/);
  });
});
