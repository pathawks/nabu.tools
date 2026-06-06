/**
 * Quattro (iNES mapper 232, BF9096) — a 4-in-1 multicart: 256 KiB PRG as four
 * 64 KiB outer blocks (one game each), 8 KiB CHR-RAM.
 *
 * Two registers, both in PRG-ROM space:
 *   $8000-$BFFF  PRG block (outer) select — bits 4-3 pick the 64 KiB block.
 *   $C000-$FFFF  PRG page (inner) select  — bits 1-0 pick the 16 KiB page.
 * The 16 KiB window at $8000-$BFFF maps `block*4 + page`; the window at
 * $C000-$FFFF is fixed to `block*4 + 3` (the block's last page). So every
 * 16 KiB bank is reachable at $8000 by setting block then page.
 *
 * Both registers live in PRG-ROM space, so writes go through the same bus
 * conflict the discrete mappers handle (`./bus-conflict`): re-home with a
 * conflict-immune 0x00 write, then write the value through a byte that
 * survives the AND. The gate is correct whether or not the chip actually
 * conflicts — a clean latch passes the value too. 0x00 homes the block
 * register to block 0 and the page register to page 0.
 *
 * CHR is CHR-RAM, so there is no CHR-ROM to dump.
 *
 * The standalone carts are NES 2.0 mapper 232 SUBMAPPER 1: the two outer
 * block-select bits are wired swapped — D4 = block bit 0, D3 = block bit 1 —
 * so block selection goes through `blockSelectValue`, not a naive `block << 3`,
 * which lands the four 64 KiB blocks in catalog order. Hardware-verified; some
 * docs instead describe the chip's bank bits as 4 & 5, but these boards wire
 * D3/D4 — don't "correct" it.
 *
 * DUMPING / SAFETY — the cart's A/B switch toggles a CIC lockout-defeat
 * circuit: position A = OFF, position B = ON. A bare cart reader has no CIC
 * (like a top-loader), so dump with the switch in POSITION A. Leaving it in B
 * on such a reader makes the cart's charge pump draw heavy current and can
 * damage the cart if left on.
 *
 * Reference: nesdev wiki "INES Mapper 232".
 */

import type { NesBus } from "../bus";
import type { NesMapper } from "./types";
import { selectBank, findWriteGate } from "./bus-conflict";
import { readBankWithRetry } from "./bank-reliability";

const BLOCK_REG = 0x8000; // $8000-$BFFF: outer block select, bits 4-3
const PAGE_REG = 0xc000; // $C000-$FFFF: inner page select, bits 1-0
const PRG_BANK_KB = 16;
const PRG_BANK_BYTES = PRG_BANK_KB * 1024;
const PAGES_PER_BLOCK = 4; // 64 KiB block / 16 KiB page

/**
 * Register value that selects outer block `block` (0-3). Submapper 1 (the
 * standalone carts) wires the two block bits swapped — D4 = block bit 0,
 * D3 = block bit 1 — so blocks 1 and 2 trade register values versus a naive
 * `block << 3`.
 */
function blockSelectValue(block: number): number {
  return ((block & 1) << 4) | ((block >> 1) << 3);
}

/**
 * Select outer block `block` (0-3). The block register is at $8000-$BFFF,
 * so reuse the shared re-home-then-gate select: it homes to block 0 with a
 * conflict-immune 0x00 write, then writes `blockSelectValue(block)` through a
 * bank-0 byte that survives the AND. Page is forced to 0 first so the 0x00
 * re-home lands on bank 0 (the $8000 window is `block*4 + page`), making
 * `bank0` the correct gate source.
 */
async function selectBlock(
  bus: NesBus,
  block: number,
  bank0: Uint8Array,
): Promise<void> {
  await bus.writeCpu(PAGE_REG, 0x00); // page 0 first
  await selectBank(bus, blockSelectValue(block), bank0); // writes to $8000
}

/**
 * Select inner page `page` (0-3) within the current block. The page
 * register is at $C000-$FFFF, whose window is fixed to the block's last
 * page (`block*4 + 3`) regardless of `page` — `pageGate` is that bank, read
 * once per block as the gate source. A 0x00 write homes to page 0
 * (conflict-immune); a non-zero page gates through `pageGate`.
 */
async function selectPage(
  bus: NesBus,
  page: number,
  pageGate: Uint8Array,
): Promise<void> {
  await bus.writeCpu(PAGE_REG, 0x00); // page 0 (conflict-immune)
  if (page === 0) return;
  const gate = findWriteGate(pageGate, page);
  await bus.writeCpu(gate >= 0 ? PAGE_REG + gate : PAGE_REG, page);
}

export const quattro: NesMapper = {
  id: 232,
  name: "Quattro",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();

    const numBanks = sizeKB / PRG_BANK_KB;
    const numBlocks = numBanks / PAGES_PER_BLOCK;
    const total = numBanks * PRG_BANK_BYTES;

    // Home to block 0 / page 0 and capture bank 0 — the dropout reference and
    // the bus-conflict gate source for block selects.
    await bus.writeCpu(PAGE_REG, 0x00);
    await bus.writeCpu(BLOCK_REG, 0x00);
    const bank0 = await bus.readCpu(0x8000, PRG_BANK_BYTES);

    const out = new Uint8Array(total);
    out.set(bank0, 0);
    onProgress?.(PRG_BANK_BYTES, total);

    for (let block = 0; block < numBlocks; block++) {
      // Bring this block in, then snapshot its fixed last page (the $C000
      // window) as the gate source for the block's page selects.
      await selectBlock(bus, block, bank0);
      const pageGate = await bus.readCpu(0xc000, PRG_BANK_BYTES);

      for (let page = 0; page < PAGES_PER_BLOCK; page++) {
        const index = block * PAGES_PER_BLOCK + page;
        if (index === 0) continue; // bank 0 already captured above
        const chunk = await readBankWithRetry({
          label: `Quattro PRG bank ${index}`,
          reference: bank0,
          // Re-establish the full (block, page) selection each attempt so a
          // dropped latch recovers from a known home. A drop that lands back
          // on bank 0 is the recoverable signature; a partial two-register
          // drop within a non-zero block isn't expressible by a single
          // reference, but genuine BF9096 ASICs latch deterministically.
          attempt: async () => {
            await selectBlock(bus, block, bank0);
            await selectPage(bus, page, pageGate);
            return bus.readCpu(0x8000, PRG_BANK_BYTES);
          },
        });
        out.set(chunk, index * PRG_BANK_BYTES);
        onProgress?.((index + 1) * PRG_BANK_BYTES, total);
      }
    }

    return out;
  },

  async dumpChrRom(_bus, sizeKB) {
    // Quattro carts use CHR-RAM, so there is no CHR-ROM to read. The DB
    // lists only the 0 KiB CHR size; anything else is a caller error.
    if (sizeKB === 0) return new Uint8Array(0);
    throw new Error(
      `Quattro (mapper 232) has CHR-RAM, not CHR-ROM; cannot dump ${sizeKB}KB of CHR-ROM.`,
    );
  },
};
