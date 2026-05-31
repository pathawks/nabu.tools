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
import { axrom } from "./axrom";
import { colorDreams } from "./color-dreams";
import { gxrom } from "./gxrom";
import { mapper185 } from "./mapper185";
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
  66: gxrom,
  185: mapper185,
};

export function getNesMapper(id: number): NesMapper | undefined {
  return NES_MAPPERS[id];
}
