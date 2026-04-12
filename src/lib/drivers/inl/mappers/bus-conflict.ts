/**
 * Bus conflict resolution — shared bank table search for discrete NES mappers.
 *
 * Discrete mappers (UxROM, CNROM, BxROM, AxROM) have bus conflicts when
 * writing to the mapper register. The CPU data bus must agree with the ROM
 * data bus, so we need to find a "bank table" in ROM: a sequence of bytes
 * [0, 1, 2, ..., N-1] at a known address. Writing bank number B through
 * address (base + B) ensures the ROM outputs B on the data bus too.
 */

import type { INLDevice } from "../inl-device";
import { dumpRegion } from "../inl-dump";
import { MEM, MAPVAR } from "../inl-opcodes";

/**
 * Address page values — these tell the firmware which address range to read.
 * $8000 -> 0x08, $C000 -> 0x0C, $0000 -> 0x00.
 */
const ADDR_PAGE = {
  CPU_8000: 0x08,
  CPU_C000: 0x0c,
} as const;

/**
 * Dump a region of CPU address space and search for a bank table.
 *
 * A bank table is a contiguous sequence [0, 1, 2, ..., numBanks-1] in ROM.
 * Returns the CPU address of byte 0 in the table, or null if not found.
 *
 * @param device    INL device handle
 * @param cpuBase   CPU address to start searching (e.g. 0xC000 or 0x8000)
 * @param sizeKB    Size of the region to search in KB (e.g. 16 or 32)
 * @param numBanks  Number of sequential bytes to look for
 */
export async function findBankTable(
  device: INLDevice,
  cpuBase: number,
  sizeKB: number,
  numBanks: number,
): Promise<number | null> {
  const addrPage = cpuBase === 0xc000 ? ADDR_PAGE.CPU_C000 : ADDR_PAGE.CPU_8000;

  const data = await dumpRegion(device, {
    sizeKB,
    memType: MEM.NESCPU_4KB,
    mapper: addrPage,
    mapVar: MAPVAR.NOVAR,
  });

  // Build the target sequence [0, 1, 2, ..., numBanks-1]
  const needle = new Uint8Array(numBanks);
  for (let i = 0; i < numBanks; i++) needle[i] = i;

  // Linear search for the sequence in the dump
  const limit = data.length - numBanks;
  outer: for (let offset = 0; offset <= limit; offset++) {
    for (let j = 0; j < numBanks; j++) {
      if (data[offset + j] !== needle[j]) continue outer;
    }
    return cpuBase + offset;
  }

  return null;
}
