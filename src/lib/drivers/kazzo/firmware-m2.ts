/**
 * Kazzo firmware M2-idle classification.
 *
 * The FIRMWARE_VERSION request (a benign control-IN read of the version
 * section at flash 0x3780, present in every firmware era — never to be
 * confused with FIRMWARE_PROGRAM, which nabu refuses outright) returns a
 * 32-byte response that fingerprints the build, and with it the firmware's
 * M2 idle level (see ./unsupported-mappers for why that level matters):
 *
 *  - NUL-terminated ASCII "kazzo16 0.1.0" / "0.1.1" / "0.1.2" — pre-flip
 *    builds (2009-11-01 through 2010-01-24) → M2 idles HIGH.
 *  - NUL-terminated ASCII "kazzo16 0.1.3+m2 …" — the maintained
 *    m2-idle-high firmware branch, which restores the pre-flip idle
 *    polarity and names the capability in its version string → HIGH.
 *  - Anything else → assume M2 idles LOW. Fail-safe: only builds that
 *    positively identify as idle-high open the gate. That includes
 *    32 bytes of 0xFF (a build whose version section is blank — e.g. the
 *    historical clipped distribution of the 2010-01 firmware): it happens
 *    to be capable, but an erased version section is not an identity, so
 *    it gates with a label pointing at the self-identifying build.
 */

import { VERSION_STRING_SIZE } from "./kazzo-opcodes";

export interface KazzoFirmwareClass {
  /** True when this firmware era idles M2 high between bus cycles. */
  m2IdleHigh: boolean;
  /** Human-readable build identity — panel-safe, used as the firmware version. */
  label: string;
}

/** Pre-flip version strings; the boundary stops "0.1.2" matching "0.1.20". */
const IDLE_HIGH_VERSIONS = /^kazzo16 0\.1\.[0-2](?!\d)/;
/** The m2-idle-high firmware branch; boundary keeps "+m2x" lookalikes out. */
const IDLE_HIGH_FORK = /^kazzo16 0\.1\.3\+m2(?=[ /]|$)/;

/** The bytes up to the NUL as printable ASCII, or null if absent/empty/unprintable. */
function printableVersionString(bytes: Uint8Array): string | null {
  const nul = bytes.indexOf(0);
  if (nul <= 0) return null; // no terminator, or empty — not a version string
  const text = bytes.subarray(0, nul);
  if (!text.every((b) => b >= 0x20 && b <= 0x7e)) return null;
  return String.fromCharCode(...text);
}

/**
 * Classify a FIRMWARE_VERSION response. `null` means the transfer itself
 * failed; every unrecognized shape classifies as idle-LOW (gated).
 */
export function classifyKazzoFirmware(
  bytes: Uint8Array | null,
): KazzoFirmwareClass {
  if (bytes === null) {
    return { m2IdleHigh: false, label: "unknown (version read failed)" };
  }
  if (bytes.length !== VERSION_STRING_SIZE) {
    return { m2IdleHigh: false, label: "unknown (short version read)" };
  }
  if (bytes.every((b) => b === 0xff)) {
    // Capable in practice (the historical clipped 2010-01 distribution),
    // but a blank version section is not an identity — gate, and point at
    // the build that says what it is.
    return {
      m2IdleHigh: false,
      label:
        "unidentified build (version section blank) — flash the " +
        "kazzo16 0.1.3+m2 build for CPLD-cart support",
    };
  }

  const text = printableVersionString(bytes);
  if (text === null) {
    const hex = Array.from(bytes.subarray(0, 8), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return { m2IdleHigh: false, label: `unknown (${hex}…)` };
  }
  return {
    m2IdleHigh: IDLE_HIGH_VERSIONS.test(text) || IDLE_HIGH_FORK.test(text),
    label: text,
  };
}
