/**
 * The NES mapper catalog: a device-agnostic map of iNES mapper ID to its
 * shared, bus-driven implementation. Mappers consume a `NesBus`, not a
 * specific device, so this registry is reused across every driver — a
 * device "supports" a mapper when it can drive the catalog entry through
 * its bus (the driver owns that decision; see e.g. the INL driver).
 *
 * MMC1's serial shift register is the one detail a plain CPU-write bus
 * can't drive (per-write USB timing drops bits); `mmc1` picks up an
 * `InlNesBus.writeSerialRegister`-style capability automatically via the
 * optional bus interface, so no per-device variant is needed here.
 *
 * Add entries here (and a matching metadata row in NES_MAPPER_DB) as new
 * mappers are validated on hardware.
 */

import { nrom } from "./nrom";
import { mmc1 } from "./mmc1";
import { uxrom } from "./uxrom";
import { cxrom } from "./cxrom";
import { mmc2 } from "./mmc2";
import { mmc3 } from "./mmc3";
import { rambo1 } from "./rambo1";
import { axrom } from "./axrom";
import { colorDreams } from "./color-dreams";
import { gxrom } from "./gxrom";
import { fme7 } from "./fme7";
import { bf909x } from "./bf909x";
import { dxrom } from "./dxrom";
import { quattro } from "./quattro";
import { mapper268Mindkids } from "./coolboy";
import { mapper470 } from "./inx007t";
import type { NesMapper } from "./types";

export const NES_MAPPERS: Record<number, NesMapper> = {
  0: nrom,
  1: mmc1,
  2: uxrom,
  3: cxrom,
  4: mmc3,
  7: axrom,
  9: mmc2,
  11: colorDreams,
  64: rambo1,
  66: gxrom,
  69: fme7,
  71: bf909x,
  206: dxrom,
  232: quattro,
  // Submapper 1 (Mindkids, outer registers at $5000) — the variant we've
  // hardware-verified. Submapper 0 (CoolBoy, registers at $6000) shares
  // the implementation via createMapper268(0) but needs its own catalog
  // mechanism (submapper isn't part of the config UI) when a cart shows up.
  // The INL driver pre-flight-rejects this id — the board's CPLD refuses
  // that device's synthesized writes; see UNSUPPORTED_MAPPERS in
  // drivers/inl/unsupported-mappers for the hardware-classified account.
  268: mapper268Mindkids,
  // Vendor-recipe implementation, not yet hardware-validated on a nabu
  // driver (see the cadence lesson in inx007t.ts); INL pre-flight-
  // rejects this id too — same CPLD-refusal family as 268.
  470: mapper470,
};

export function getNesMapper(id: number): NesMapper | undefined {
  return NES_MAPPERS[id];
}
