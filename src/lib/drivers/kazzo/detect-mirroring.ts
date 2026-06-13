/**
 * Nametable-mirroring detection for the Kazzo dumper.
 *
 * Kazzo exposes a single hardware probe (VRAM_CONNECTION) that reports how
 * the cartridge wires PPU A10/A11 to CIRAM A10. Like the reference host
 * (anago), we only resolve vertical vs horizontal from it — single-screen
 * mirroring is mapper-controlled and not visible to the probe.
 */

import type { KazzoDevice } from "./kazzo-device";
import { VRAM_VERTICAL } from "./kazzo-opcodes";

export async function detectKazzoMirroring(
  device: KazzoDevice,
): Promise<string> {
  const pattern = await device.vramConnection();
  return pattern === VRAM_VERTICAL ? "vertical" : "horizontal";
}
