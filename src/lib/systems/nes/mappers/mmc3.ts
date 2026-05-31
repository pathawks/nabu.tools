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
 */

import type { NesMapper } from "./types";
import { walkBanks } from "./bank-walk";

const BANK_SELECT = 0x8000;
const BANK_DATA = 0x8001;
const MIRRORING = 0xa000;
const PRG_RAM_CTRL = 0xa001;

/** Set up MMC3 registers to a known state before dumping. */
async function initMmc3(bus: Parameters<NesMapper["dumpPrgRom"]>[0]): Promise<void> {
  // PRG-RAM: disable writes, allow reads (so writes to $6000-$7FFF are ignored)
  await bus.writeCpu(PRG_RAM_CTRL, 0x40);
  // Vertical mirroring — irrelevant for dumping content but a deterministic start
  await bus.writeCpu(MIRRORING, 0x00);
  // CHR mode 0, PRG mode 0 (8000 bit 7 = 0, bit 6 = 0)
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
 * Map the 8 KiB PRG bank `bank` to $8000 via R6, issued once. This is the
 * pure MMC3 protocol — no clone-cart workaround lives here. Recovery from a
 * dropped bank-select latch (the failure mode on CPLD/clone repro carts) is
 * handled reactively by `readBankWithRetry` in the dump loop, which
 * re-invokes this select and re-reads when a bank comes back as bank 0.
 */
async function selectPrgBank(
  bus: Parameters<NesMapper["dumpPrgRom"]>[0],
  bank: number,
): Promise<void> {
  await bus.writeCpu(BANK_SELECT, 0x06);
  await bus.writeCpu(BANK_DATA, bank);
}

export const mmc3: NesMapper = {
  id: 4,
  name: "MMC3",
  defaultPrgSizes: [512, 256, 128, 64, 32],
  defaultChrSizes: [256, 128, 64, 32, 16, 8, 0],

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();
    await initMmc3(bus);

    // Walk PRG one 8 KiB bank at a time — MMC3's PRG bank granularity, and
    // the granularity at which clone carts drop a bank-select latch.
    const BANK = 8 * 1024;
    return walkBanks(
      {
        label: "MMC3 PRG",
        bankBytes: BANK,
        numBanks: (sizeKB * 1024) / BANK,
        // Map bank N to $8000 via R6.
        readBank: async (bank) => {
          await selectPrgBank(bus, bank);
          return bus.readCpu(0x8000, BANK);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);
    if (!bus.readPpu) {
      throw new Error(
        "MMC3 CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific `dumpChrRom` override for mapper 4.",
      );
    }

    const readPpu = bus.readPpu.bind(bus);

    await bus.setup();
    await initMmc3(bus);

    // Walk CHR in 4 KiB outer iterations: R0=bank*2, R1=bank*2+1
    // (the bank-data register stores 2 KiB units, so shift left by 1).
    const OUTER = 4 * 1024;
    return walkBanks(
      {
        label: "MMC3 CHR",
        bankBytes: OUTER,
        numBanks: (sizeKB * 1024) / OUTER,
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
  },
};
