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
 * on these carts, so this rejection is by family inference: pre-flighting it
 * is the honest default (a dump would return a boot-bank mirror), and an
 * instrumented attempt could overturn it.
 *
 * As with INL, the driver rejects these ids before any cart traffic and
 * feeds the key set to `capability.unsupportedMappers` so the config UI
 * greys them out. The mappers stay in the catalog for devices whose bus
 * drives the CPLD.
 */
export const UNSUPPORTED_MAPPERS: ReadonlyMap<number, string> = new Map([
  [
    268,
    "this board's CPLD ignores AVR/V-USB synthesized writes (hardware-" +
      "classified on the closely-related INL Retro); Kazzo is the same family",
  ],
  [
    470,
    "same CPLD-refusal family as mapper 268 — not separately tested on Kazzo, " +
      "rejected by inference from the INL classification",
  ],
]);
