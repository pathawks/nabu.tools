/**
 * Mappers the INL Retro Programmer cannot drive, even though they exist in
 * the shared, device-agnostic NES catalog.
 *
 * These boards reimplement their mapper in a CPLD that refuses the INL
 * firmware's synthesized bus writes: the firmware idles M2 and emits a
 * single pulse per write, while the CPLD's reset detector wants sustained
 * M2 clocking (a real console runs M2 continuously at 1.79 MHz) before it
 * will latch a register. Reads are unaffected — the firmware's page-read
 * loop issues many back-to-back bus cycles inside one USB transaction — so
 * a dump that ignored this would return a plausible-length file that is
 * really the boot bank mirrored across every slot.
 *
 * `UNSUPPORTED_MAPPERS` maps each such mapper id to the reason shown in
 * the driver's pre-flight rejection, worded to its own evidence basis. The
 * driver rejects these ids before any cart traffic (so no garbage dump is
 * produced) and feeds the key set to `capability.unsupportedMappers`, which
 * greys the options out in the config UI. The mappers stay in the catalog —
 * they are implemented, spec-tested, and (mapper 268) dumpable on devices
 * whose bus drives the CPLD; the INL is simply the wrong tool.
 *
 * ── Mapper 268 (CoolBoy / Mindkids MMC3-clone multicart) ──
 *
 * Classified on hardware 2026-06-07 with the mapper's built-in
 * failure-classification pass (see `coolboy.ts`), verdict
 * `writes-not-landing` with the inner-MMC3 discrimination probe also
 * negative:
 *
 *   - The read path is flawless. All 128 GNROM bank reads returned the
 *     cart's power-on window byte-perfect (it matches flash offset 0 of a
 *     reference dump made on other hardware), 256 times in a row — contacts,
 *     power, and read timing are not in question.
 *   - Zero of 1,024 outer-register writes ($5000-$5003, the
 *     hardware-verified two-phase menu-mimicking sequence with 5 ms settles)
 *     latched.
 *   - The inner MMC3 registers ($8000/$8001) — the very write path real MMC3
 *     ASICs accept from this device — did not latch either.
 *
 * A follow-up experiment (also 2026-06-07) bounded it from the other side:
 * ten back-to-back M2 read+write cycles inside ONE USB transaction
 * (`NES_MMC1_WR`'s burst, microsecond gaps) still did not latch the inner R6
 * register, so no stock-firmware write primitive can cross the threshold.
 * Only a firmware modification that keeps M2 running through the write could,
 * and on this board even that is architecturally hostile: M2 (PC0) has no
 * timer output on the ATmega164A, so continuous M2 must be bit-banged by the
 * same core that has to keep answering V-USB's cycle-critical INT0
 * interrupts mid-operation — gapless M2 and a live USB stack are mutually
 * exclusive here. The vendor's STM32-based boards (hardware USB, real
 * timers) would be the realistic platform. Consistent with all of this, a
 * dumper that drives denser sustained bus activity latches these registers
 * with only occasional stochastic dropouts; discrete logic and real mapper
 * ASICs (everything else in the catalog) latch fine from single M2 pulses.
 *
 * (Don't retry the probe via MMC3_PRG_FLASH_WR: its tail polls the written
 * address until two consecutive reads agree, and $5xxx reads flicker on this
 * cart — the firmware spins until a physical replug.)
 */

/** INL-unsupported mapper id → reason shown in the driver's pre-flight error. */
export const UNSUPPORTED_MAPPERS = new Map<number, string>([
  [
    268,
    "the board's CPLD ignores this device's register writes, so every bank " +
      "reads back as the boot menu (hardware-verified)",
  ],
]);
