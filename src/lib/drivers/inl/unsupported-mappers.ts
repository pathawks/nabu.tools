/**
 * Catalog mappers gated on an INL firmware feature: M2 idling HIGH.
 *
 * The SMD172-family CPLD reissue boards (mapper 268 CoolBoy / Mindkids,
 * mapper 470 INX_007T_V01) require the M2/phi2 clock to idle high between
 * bus operations. Sustained M2-low reads as console-off/reset: register
 * writes are ignored or reverted, while reads are unaffected. Stock INL
 * firmware drives M2 low after NES init and leaves it low between USB
 * transactions, so every bank-select write is silently undone and a dump
 * would return a plausible-length file that is really the boot bank
 * mirrored across every slot.
 *
 * The fix is firmware, not host protocol: a build that parks M2 high at
 * init and at the exit of every bus primitive (the feature/m2-idle-high
 * branch of INL-retro-progdump) dumps these boards. Hardware-verified
 * 2026-06-10: a 2 MiB mapper-268 multicart dumped byte-perfect against the
 * reference on that firmware, and a conventional MMC3 cart (256 KiB PRG +
 * 128 KiB CHR) dumped byte-perfect on the same build — the new idle level
 * does not disturb ordinary mappers. Mapper 470 is the same board family
 * but has not yet been separately verified on it.
 *
 * The driver feature-detects which firmware is connected: after IO_RESET +
 * NES_INIT it reads the M2 pin level once (PINPORT CTL_RD, operand M2 —
 * present in stock firmware too, so the probe itself is universal). Low →
 * stock: these mappers stay pre-flight-rejected and greyed out via
 * `capability.unsupportedMappers`. High → m2-idle-high build: both fully
 * enabled. A probe error counts as low (stock-equivalent). This map is the
 * single source of which mapper ids are M2-idle-gated;
 * `unsupportedMappersFor` applies the probe result. The mappers stay in the
 * shared catalog regardless — they are implemented, spec-tested, and
 * dumpable on devices whose bus the CPLD accepts.
 *
 * Historical note: a 2026-06-07 hardware classification of mapper 268 on
 * stock firmware measured 0/1024 register writes landing (with reads
 * flawless) and concluded the CPLD needs *sustained M2 clocking* that this
 * AVR could never provide alongside V-USB. The measurements were real but
 * mis-attributed: a write that latches and is then reverted when M2 idles
 * low afterwards is indistinguishable, at probe time, from a write that
 * never latched. The actual requirement — M2 parked high between
 * operations — is a few-line firmware change, not an architectural wall.
 *
 * (Don't probe these boards via MMC3_PRG_FLASH_WR — its tail polls the
 * written address until two consecutive reads agree, and $5xxx reads flicker
 * on the mapper-268 board, spinning the firmware until a physical replug.)
 *
 * ── Mapper 413 (BATMAP) — a different gate, never lifted by M2 idle ──
 *
 * Not M2-idle-gated: the INL drives this mapper's registers fine and dumps
 * its PRG/CHR correctly, so an M2-idle-high firmware does NOT enable it.
 * The block is the 8 MiB serial sample flash, which the CPLD clocks from
 * M2 — reading it needs the firmware's NESCPU_SPI413 memtype to pace eight
 * cart-ROM clock reads per byte (see InlNesBus.readSpiDataPort). That memtype
 * is not in a released INL firmware yet, so the flash reads as solid 0xFF and
 * the cart cannot be fully dumped. The read path is implemented and left
 * dormant behind ALWAYS_UNSUPPORTED_MAPPERS below — delete the 413 entry
 * there to re-enable it once the upstream firmware lands:
 *   https://gitlab.com/InfiniteNesLives/INL-retro-progdump/-/merge_requests/45
 */

/** M2-idle-gated mapper id → reason shown in the stock-firmware pre-flight error. */
export const M2_IDLE_GATED_MAPPERS: ReadonlyMap<number, string> = new Map([
  [
    268,
    "this firmware idles the M2 clock low between bus cycles, which the " +
      "board's CPLD treats as console-off — register writes are reverted " +
      "and every bank reads back as the boot menu. An M2-idle-high " +
      "firmware build (feature/m2-idle-high branch of INL-retro-progdump) " +
      "enables this mapper",
  ],
  [
    470,
    "this firmware idles the M2 clock low between bus cycles, which this " +
      "CPLD board family (same family as mapper 268) treats as console-off " +
      "— register writes are reverted. An M2-idle-high firmware build " +
      "(feature/m2-idle-high branch of INL-retro-progdump) enables this " +
      "mapper",
  ],
]);

/**
 * Mappers the INL cannot dump on ANY current firmware, for reasons unrelated
 * to the M2 idle level — so the M2 probe never lifts them. Mapper 413 (BATMAP)
 * needs the unreleased NESCPU_SPI413 memtype to read its serial sample flash
 * (see the BATMAP note above).
 */
const ALWAYS_UNSUPPORTED_MAPPERS: ReadonlyMap<number, string> = new Map([
  [
    413,
    "its 8 MiB serial sample flash needs the NESCPU_SPI413 firmware memtype " +
      "to pace the read, which is not in a released INL firmware yet (the " +
      "flash reads as 0xFF until then)",
  ],
]);

/**
 * The effective unsupported-mapper map for a session, given the probed
 * firmware M2 idle level. The always-unsupported mappers apply regardless;
 * the M2-idle-gated ones are added only on stock (M2-low) firmware and lifted
 * by an M2-idle-high build.
 */
export function unsupportedMappersFor(
  m2IdleHigh: boolean,
): ReadonlyMap<number, string> {
  return new Map([
    ...ALWAYS_UNSUPPORTED_MAPPERS,
    ...(m2IdleHigh ? [] : M2_IDLE_GATED_MAPPERS),
  ]);
}
