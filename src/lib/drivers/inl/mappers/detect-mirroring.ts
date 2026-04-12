/**
 * Shared CIRAM A10 mirroring detection for discrete/simple NES mappers.
 *
 * Reads the CIRAM A10 pin at two addresses to determine the nametable
 * mirroring configuration wired on the cartridge PCB.
 */

import type { INLDevice } from "../inl-device";
import { PINPORT } from "../inl-opcodes";

export async function detectCiramMirroring(device: INLDevice): Promise<string> {
  await device.pinport(PINPORT.ADDR_SET, 0x0800);
  const readH = await device.pinport(PINPORT.CTL_RD, PINPORT.CIA10);
  await device.pinport(PINPORT.ADDR_SET, 0x0400);
  const readV = await device.pinport(PINPORT.CTL_RD, PINPORT.CIA10);

  if (readV === 0 && readH === 0) return "one_screen_a";
  if (readV !== 0 && readH !== 0) return "one_screen_b";
  if (readV !== 0 && readH === 0) return "vertical";
  if (readV === 0 && readH !== 0) return "horizontal";
  return "vertical";
}
