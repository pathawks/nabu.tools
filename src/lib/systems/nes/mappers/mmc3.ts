/**
 * MMC3 / TxROM (iNES mapper 4) — bank-switching mapper with IRQ counter.
 *
 * PRG-ROM: up to 512 KiB, switched in 8 KiB banks via R6/R7 at $8000-$BFFF.
 * CHR-ROM: up to 256 KiB, switched in 2 KiB banks via R0/R1 at PPU $0000-$0FFF
 *          (mode 0 — mode 1 swaps the windows; we always use mode 0).
 *
 * Bank-select register $8000 picks which R# (0–7) the next $8001 write
 * targets. $A001 controls PRG-RAM access; $A000 sets nametable mirroring.
 *
 * This mapper requires `bus.readPpu` for CHR-ROM dumps. A driver
 * without a generic PPU-bus primitive provides a driver-specific
 * `dumpChrRom` override instead.
 *
 * The PRG/CHR dump core is shared with RAMBO-1 (mapper 64), an MMC3
 * superset that, in the mode we configure for dumping, banks identically —
 * see `./rambo1` — and with DxROM (mapper 206), the MMC3 ancestor
 * whose only registers are this same $8000/$8001 pair — see `./dxrom`.
 * Only the register init differs between the three, so each variant
 * supplies its own `init`.
 */

import type { NesBus } from "../bus";
import type { NesMapper, ProgressCb } from "./types";
import { walkBanks } from "./bank-walk";

const BANK_SELECT = 0x8000;
const BANK_DATA = 0x8001;
const MIRRORING = 0xa000;
const PRG_RAM_CTRL = 0xa001;

/**
 * An MMC3-style mapper for the shared dump core: a display name, its iNES
 * id (used only in the no-PPU error), and the register init to run after
 * `setup()`. MMC3 and RAMBO-1 differ only in `init`.
 */
export interface Mmc3StyleVariant {
  name: string;
  id: number;
  init(bus: NesBus): Promise<void>;
}

/**
 * Program R0/R1 (CHR) and R6/R7 (PRG) to a known state through the
 * $8000/$8001 select/data pair alone. CHR mode 0, PRG mode 0 ($8000
 * bit 7 = 0, bit 6 = 0). This is the whole init for DxROM (mapper
 * 206, MMC3's ancestor), which has no registers outside $8000/$8001 —
 * see `./dxrom`.
 */
export async function programBanks(bus: NesBus): Promise<void> {
  // R0 -> 2 KiB CHR at PPU $0000
  await bus.writeCpu(BANK_SELECT, 0x00);
  await bus.writeCpu(BANK_DATA, 0x00);
  // R1 -> 2 KiB CHR at PPU $0800
  await bus.writeCpu(BANK_SELECT, 0x01);
  await bus.writeCpu(BANK_DATA, 0x02);
  // R6 -> 8 KiB PRG at $8000 = bank 0
  await bus.writeCpu(BANK_SELECT, 0x06);
  await bus.writeCpu(BANK_DATA, 0x00);
  // R7 -> 8 KiB PRG at $A000 = bank 1
  await bus.writeCpu(BANK_SELECT, 0x07);
  await bus.writeCpu(BANK_DATA, 0x01);
}

/**
 * `programBanks` plus a deterministic mirroring write — the bank setup
 * common to MMC3 and RAMBO-1, which both have a $A000 mirroring register.
 */
export async function setupBanks(bus: NesBus): Promise<void> {
  // Vertical mirroring — irrelevant for dumping content but a deterministic start
  await bus.writeCpu(MIRRORING, 0x00);
  await programBanks(bus);
}

/** Set up MMC3 registers to a known state before dumping. */
async function initMmc3(bus: NesBus): Promise<void> {
  // PRG-RAM: disable writes, allow reads (so writes to $6000-$7FFF are ignored)
  await bus.writeCpu(PRG_RAM_CTRL, 0x40);
  await setupBanks(bus);
}

/**
 * Map the 8 KiB PRG bank `bank` to $8000 via R6, issued once. This is the
 * pure MMC3 protocol — no clone-cart workaround lives here. Recovery from a
 * dropped bank-select latch (the failure mode on CPLD/clone repro carts) is
 * handled reactively by `readBankWithRetry` in the dump loop, which
 * re-invokes this select and re-reads when a bank comes back as bank 0.
 */
async function selectPrgBank(bus: NesBus, bank: number): Promise<void> {
  await bus.writeCpu(BANK_SELECT, 0x06);
  await bus.writeCpu(BANK_DATA, bank);
}

/**
 * Dump PRG-ROM for an MMC3-style variant: walk one 8 KiB bank at a time via
 * R6 — MMC3's PRG bank granularity, and the granularity at which clone carts
 * drop a bank-select latch.
 */
export async function dumpMmc3StylePrgRom(
  bus: NesBus,
  sizeKB: number,
  variant: Mmc3StyleVariant,
  onProgress?: ProgressCb,
): Promise<Uint8Array> {
  await bus.setup();
  await variant.init(bus);

  const BANK_KB = 8;
  const BANK = BANK_KB * 1024;
  return walkBanks(
    {
      label: `${variant.name} PRG`,
      bankBytes: BANK,
      numBanks: sizeKB / BANK_KB,
      // Map bank N to $8000 via R6.
      readBank: async (bank) => {
        await selectPrgBank(bus, bank);
        return bus.readCpu(0x8000, BANK);
      },
    },
    onProgress,
  );
}

/**
 * Dump CHR-ROM for an MMC3-style variant: walk in 4 KiB outer iterations,
 * R0=bank*2, R1=bank*2+1 (the bank-data register stores 2 KiB units, so
 * shift left by 1).
 */
export async function dumpMmc3StyleChrRom(
  bus: NesBus,
  sizeKB: number,
  variant: Mmc3StyleVariant,
  onProgress?: ProgressCb,
): Promise<Uint8Array> {
  if (sizeKB === 0) return new Uint8Array(0);
  if (!bus.readPpu) {
    throw new Error(
      `${variant.name} CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific \`dumpChrRom\` override for mapper ${variant.id}.`,
    );
  }

  const readPpu = bus.readPpu.bind(bus);

  await bus.setup();
  await variant.init(bus);

  const OUTER_KB = 4;
  const OUTER = OUTER_KB * 1024;
  return walkBanks(
    {
      label: `${variant.name} CHR`,
      bankBytes: OUTER,
      numBanks: sizeKB / OUTER_KB,
      readBank: async (i) => {
        await bus.writeCpu(BANK_SELECT, 0x00);
        await bus.writeCpu(BANK_DATA, (i * 2) << 1);
        await bus.writeCpu(BANK_SELECT, 0x01);
        await bus.writeCpu(BANK_DATA, (i * 2 + 1) << 1);
        return readPpu(0x0000, OUTER);
      },
    },
    onProgress,
  );
}

const MMC3: Mmc3StyleVariant = { name: "MMC3", id: 4, init: initMmc3 };

export const mmc3: NesMapper = {
  id: 4,
  name: "MMC3",

  dumpPrgRom: (bus, sizeKB, onProgress) =>
    dumpMmc3StylePrgRom(bus, sizeKB, MMC3, onProgress),

  dumpChrRom: (bus, sizeKB, onProgress) =>
    dumpMmc3StyleChrRom(bus, sizeKB, MMC3, onProgress),
};
