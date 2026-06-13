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
import { bytesEqual, readBankWithConsensus } from "./bank-reliability";

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
  // PRG-RAM: bit 7 clear takes the chip off the bus entirely (and bit 6
  // write-protects it on variants that ignore bit 7), so no ROM pass can
  // touch a battery save.
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

  // Same protective bracket as FME-7's hardware-validated dumpSave:
  // expose the SRAM only for the read itself. $A001 bit 7 must be SET
  // before $6000-$7FFF returns SRAM (the power-on/init state leaves the
  // chip off the bus, which dumps as uniform fill); bit 6 stays set so
  // the window is write-protected even while exposed. MMC3-specific —
  // RAMBO-1 shares the dump core but its $A001 is not a PRG-RAM control
  // register.
  async dumpSave(bus, sramKB, onProgress) {
    await bus.setup();
    await bus.writeCpu(PRG_RAM_CTRL, 0xc0);
    const data = await bus.readCpu(0x6000, sramKB * 1024, onProgress);
    // Take the chip back off the bus as soon as the read completes —
    // deasserting its enable shields the battery save from stray bus
    // cycles for the rest of the session, including the unplug
    // power-down, the riskiest window.
    await bus.writeCpu(PRG_RAM_CTRL, 0x40);
    // A real SRAM read is byte-diverse. Open bus is not — it reads as
    // uniform fill OR as a handful of capacitance-echo values (both seen
    // on hardware), so gate on diversity rather than uniformity.
    if (countDistinct(data) >= OPEN_BUS_MAX_DISTINCT) return data;

    // Nothing convincing at $6000. Mapper 4 covers a second board
    // family: MMC6 / HKROM, whose save is 1 KiB inside
    // the MMC6 itself at $7000-$73FF behind a different enable chain —
    // $8000 bit 5 is a master gate (while clear, $A001 is forced to
    // $00), and $A001 holds per-512-byte-half read/write enables (HhLl
    // in bits 7-4). All of these writes are no-ops on a real MMC3
    // ($8000 bits 3-5 unused; $A001 transitions end chip-disabled).
    //
    // Detection fingerprint (hardware-validated on an HKROM cart,
    // 2026-06-13): with the gate up and only ONE half read-enabled, the
    // MMC6 actively DRIVES the other half to zero — a response to the
    // register value that open bus cannot mimic.
    await bus.writeCpu(BANK_SELECT, 0x20);
    await bus.writeCpu(PRG_RAM_CTRL, 0x80); // upper half readable only
    const upperOnly = await bus.readCpu(0x7000, 1024);
    await bus.writeCpu(PRG_RAM_CTRL, 0x20); // lower half readable only
    const lowerOnly = await bus.readCpu(0x7000, 1024);
    const drivesDisabledHalves =
      upperOnly.subarray(0, 512).every((b) => b === 0) &&
      lowerOnly.subarray(512).every((b) => b === 0);
    // False-positive guard: an MMC3 whose battery SRAM zero-fills these
    // exact windows would also pass the zero checks — but then the same
    // window inside the $6000 pass (which had the MMC3 SRAM enabled)
    // would match what the "enabled half" returns now. On an MMC6 the
    // $6000 pass saw open bus there instead.
    const mmc3Lookalike = bytesEqual(
      upperOnly.subarray(512),
      data.subarray(0x1200, 0x1400),
    );

    if (drivesDisabledHalves && !mmc3Lookalike) {
      // Both halves readable, writes denied; consensus-read the 1 KiB —
      // a battery-weak MMC6 array flickers individual cells, which a
      // single read would silently mis-capture.
      await bus.writeCpu(PRG_RAM_CTRL, 0xa0);
      const { data: mmc6 } = await readBankWithConsensus({
        read: () => bus.readCpu(0x7000, 1024, onProgress),
        label: "MMC6 save RAM",
      });
      // Close the MMC6 master gate, then park PRG-RAM control to the same
      // off-bus + write-protected state as init ($40). On a gated MMC6 the
      // $A001 write is a no-op; on an MMC3 false-positive it keeps bit 6
      // set, so a variant that ignores bit 7 still can't be written.
      await bus.writeCpu(BANK_SELECT, 0x00);
      await bus.writeCpu(PRG_RAM_CTRL, 0x40);
      return mmc6;
    }

    // Not an MMC6 — re-park the probe registers to init's safe state
    // (gate closed, then PRG-RAM control off-bus + write-protected) and
    // return the $6000 read; if it was uniform, the dump-job's warning
    // tells the user.
    await bus.writeCpu(BANK_SELECT, 0x00);
    await bus.writeCpu(PRG_RAM_CTRL, 0x40);
    return data;
  },
};

/**
 * Open bus reads as one value or a small set of bus-echo values (6 and
 * 4 distinct observed on hardware across 4 KiB windows); real SRAM —
 * even a freshly-initialized save — is far more diverse. The threshold
 * splits those regimes with wide margins on both sides.
 */
const OPEN_BUS_MAX_DISTINCT = 16;

function countDistinct(data: Uint8Array): number {
  const seen = new Set<number>();
  for (const b of data) {
    seen.add(b);
    if (seen.size >= OPEN_BUS_MAX_DISTINCT) break;
  }
  return seen.size;
}
