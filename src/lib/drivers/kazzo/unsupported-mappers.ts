/**
 * Catalog mappers gated on a Kazzo firmware feature: M2 idling HIGH.
 *
 * The SMD172-family CPLD reissue boards (mapper 268 CoolBoy / Mindkids,
 * mapper 470 INX_007T_V01) require the M2/phi2 clock to idle high between
 * bus operations. Sustained M2-low reads as console-off/reset: register
 * writes are silently reverted while reads still work, so a dump on the
 * wrong firmware returns a plausible-length file that is really the boot
 * bank mirrored across every slot — no error, just wrong bytes.
 *
 * Which Kazzo firmware qualifies is an era split (audited from the firmware
 * history): builds from 2009-11-01 through 2010-01-24 idle M2 HIGH (version
 * strings "kazzo16 0.1.0"–"0.1.2"); the polarity flipped LOW on 2010-01-25
 * and was never restored, so released 0.1.3 and everything later idles LOW.
 * Both mappers were hardware-validated on a pre-flip build (268: a 2 MB
 * cart dumped byte-perfect 2026-06-08; 470: a 1 MB cart byte-perfect
 * 2026-06-09, after one false alarm that turned out to be D7 floating high
 * on a dirty edge connector, not a mapper limit). The historical
 * INL-distributed copy of that firmware had its version section clipped
 * off (FIRMWARE_VERSION reads 32 bytes of erased flash) — capable in
 * practice, but a blank version section is no identity, so it deliberately
 * classifies as unidentified and gates. The recognized capable builds are
 * the ones that say what they are: pre-flip version strings, and the
 * maintained m2-idle-high firmware branch, which reports
 * "kazzo16 0.1.3+m2" (same pre-flip bus behavior, self-identifying; not
 * yet separately hardware-run as of 2026-06-10).
 *
 * The driver classifies the connected firmware once per connection from the
 * FIRMWARE_VERSION fingerprint (see ./firmware-m2) and applies the result
 * via `unsupportedMappersFor`: capable era → gate lifted; 0.1.3+/garbage/
 * short read/transfer error → gated (fail-safe). The map feeds
 * `capability.unsupportedMappers` (greys the config UI) and
 * `KazzoDriver.resolveMapper` (pre-flight reject). The mappers stay in the
 * shared catalog regardless, for devices whose bus drives the CPLD.
 */

/** M2-idle-gated mapper id → reason shown in the idle-low pre-flight error. */
export const M2_IDLE_GATED_MAPPERS: ReadonlyMap<number, string> = new Map([
  [
    268,
    "this firmware build idles the M2 clock low between bus cycles, which " +
      "the board's CPLD treats as console-off — register writes are " +
      "reverted and every bank reads back as the boot menu. A Kazzo build " +
      "that idles M2 high (kazzo16 0.1.0–0.1.2, or the self-identifying " +
      "kazzo16 0.1.3+m2 branch) enables this mapper",
  ],
  [
    470,
    "this firmware build idles the M2 clock low between bus cycles, which " +
      "this CPLD board family (same family as mapper 268) treats as " +
      "console-off — register writes are reverted. A Kazzo build that idles " +
      "M2 high (kazzo16 0.1.0–0.1.2, or the self-identifying " +
      "kazzo16 0.1.3+m2 branch) enables this mapper",
  ],
]);

const NONE: ReadonlyMap<number, string> = new Map();

/**
 * The effective unsupported-mapper map for a session, given the classified
 * firmware M2 idle level: idle-low (or unknown) gates the map above; an
 * idle-high era build lifts the gate entirely.
 */
export function unsupportedMappersFor(
  m2IdleHigh: boolean,
): ReadonlyMap<number, string> {
  return m2IdleHigh ? NONE : M2_IDLE_GATED_MAPPERS;
}
