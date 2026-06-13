/**
 * Mappers the Kazzo dumper cannot drive, even though they exist in the
 * shared NES catalog.
 *
 * Mappers 268 (CoolBoy / Mindkids) and 470 (INX_007T_V01) reimplement their
 * mapper in a CPLD whose reset detector wants sustained M2 clocking before
 * it will latch a register write. Kazzo is the same AVR + V-USB lineage as
 * the INL Retro — it idles M2 between transfers and emits a single pulse per
 * write — and the INL was *hardware-classified* against both boards as
 * unable to land a single register write (see
 * drivers/inl/unsupported-mappers.ts). Kazzo has NOT been separately tested
 * on these carts, so this rejection is only an inference: a dump would likely
 * return a boot-bank mirror, but an instrumented attempt could overturn it.
 *
 * >>> INFERENCE OVERTURNED ON HARDWARE (2026-06-08) <<<
 * The Kazzo dumped a 2 MB mapper-268 (Mindkids submapper 1) cart BYTE-PERFECT,
 * matching the No-Intro reference (CRC32 E7822236) — so the INL classification
 * does NOT transfer: the Kazzo's write cycle drives that CPLD where the INL's
 * didn't. 268 is supported here. 470 (INX_007T_V01) is now ALSO
 * hardware-validated on the Kazzo (2026-06-09) — a 1 MB cart dumped
 * byte-perfect against the No-Intro reference (CRC32 55AB5439). A first
 * attempt mismatched only because data line D7 floated high on a dirty edge
 * connector (the dump was exactly reference|0x80, low 7 bits pristine); a
 * clean re-seat verified it — a contact fault, not a mapper limit. Re-add an
 * id below only if a cart is actually shown un-dumpable on Kazzo.
 *
 * The map feeds `capability.unsupportedMappers` (greys the config UI) and
 * `KazzoDriver.resolveMapper` (pre-flight reject). Mappers stay in the shared
 * catalog regardless, for devices whose bus drives the CPLD.
 */
export const UNSUPPORTED_MAPPERS: ReadonlyMap<number, string> = new Map([
  // (empty — 268 hardware-validated on Kazzo; 470 enabled pending its own test)
]);
