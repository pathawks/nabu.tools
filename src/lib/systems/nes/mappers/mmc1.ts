/**
 * MMC1 / SxROM (iNES mapper 1) — serial-shift-register mapper.
 *
 * PRG-ROM: up to 512 KiB, switched in 32 KiB banks at CPU $8000-$FFFF
 *          (this implementation forces 32 KiB PRG mode for dumping).
 * CHR-ROM: up to 128 KiB, switched in 4 KiB banks at PPU $0000 / $1000
 *          (this implementation uses 4 KiB CHR mode).
 *
 * The mapper has four internal registers selected by address:
 *   $8000-$9FFF — Control (mirror/PRG mode/CHR mode)
 *   $A000-$BFFF — CHR bank 0 (4 KiB window at PPU $0000)
 *   $C000-$DFFF — CHR bank 1 (4 KiB window at PPU $1000)
 *   $E000-$FFFF — PRG bank   (bit 4 also gates PRG-RAM /CE on SNROM)
 *
 * Each register is loaded via a five-write serial protocol: each write
 * to $8000-$FFFF shifts bit 0 of the value into a 5-bit internal
 * register; on the fifth write the register is latched into the slot
 * picked by bits 13-14 of the destination address, and the shift
 * register is cleared. A write with bit 7 set clears the shift register
 * immediately — and, crucially, also forces PRG mode back to 3 (16 KiB,
 * last bank fixed at $C000; `Control |= $0C`). Every register write begins
 * with such a reset, so `dumpPrgRom` re-asserts the control register last,
 * right before each read, to hold the cart in 32 KiB mode.
 *
 * The five-write sequence is the one piece that varies by device: the
 * generic path clocks it with individual `writeCpu`s, but some drivers
 * can't reliably clock the shift register that way over the wire. Those
 * drivers expose an atomic `writeSerialRegister` on their `NesBus`; this mapper
 * feature-detects it and falls back to per-bit writes when it's absent —
 * the same optional-capability shape as `readPpu`. So MMC1 stays a single
 * shared mapper with no device knowledge, and a driver "hooks in" simply
 * by implementing `writeSerialRegister` on its bus.
 *
 * CHR-RAM carts surface as CHR size 0; their `dumpChrRom` returns an
 * empty array and the standard CHR override doesn't apply.
 *
 * Reference: nesdev wiki, iNES mapper 001.
 */

import type { NesBus } from "../bus";
import type { NesMapper } from "./types";
import { walkBanks } from "./bank-walk";

const CTRL_REG = 0x8000;
const CHR0_REG = 0xa000;
const CHR1_REG = 0xc000;
const PRG_REG = 0xe000;

/** Control byte: one-screen mirroring + 32 KiB PRG mode + 4 KiB CHR mode. */
const CTRL_DUMP_MODE = 0x10;

const PRG_BANK_KB = 32;
const CHR_BANK_KB = 8;
const PRG_BANK_BYTES = PRG_BANK_KB * 1024;
const CHR_BANK_BYTES = CHR_BANK_KB * 1024;

/**
 * Generic fallback load: clock the five bits one at a time via single CPU
 * writes. Works on buses where each `writeCpu` reaches the mapper as its
 * own write cycle; used whenever the bus has no atomic `writeSerialRegister`.
 */
async function perBitLoad(
  bus: NesBus,
  addr: number,
  value: number,
): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await bus.writeCpu(addr, (value >> i) & 0x01);
  }
}

/**
 * Reset the shift register (any $8000-$FFFF write with bit 7 set), then
 * load `value` into the register at `addr`. Prefers the bus's atomic
 * `writeSerialRegister` capability when present; otherwise clocks the five bits via
 * individual CPU writes.
 */
async function writeReg(
  bus: NesBus,
  addr: number,
  value: number,
): Promise<void> {
  await bus.writeCpu(0x8000, 0x80);
  if (bus.writeSerialRegister) await bus.writeSerialRegister(addr, value);
  else await perBitLoad(bus, addr, value);
}

/** Drive MMC1 into a known dumping configuration. */
async function init(bus: NesBus): Promise<void> {
  await writeReg(bus, CTRL_REG, CTRL_DUMP_MODE);
  // PRG bank 0, WRAM /CE deasserted (bit 4 = 1 disables WRAM).
  await writeReg(bus, PRG_REG, 0x10);
  // CHR bank 0 at PPU $0000, CHR bank 1 at PPU $1000.
  await writeReg(bus, CHR0_REG, 0x00);
  await writeReg(bus, CHR1_REG, 0x01);
}

export const mmc1: NesMapper = {
  id: 1,
  name: "MMC1",
  defaultPrgSizes: [512, 256, 128, 64, 32],
  defaultChrSizes: [128, 64, 32, 16, 8, 0],

  async enableSram(bus) {
    await bus.setup();
    await init(bus);
    // PRG bank register: bit 4 = 0 enables WRAM /CE on SNROM/SxROM.
    await writeReg(bus, PRG_REG, 0x00);
    // On SNROM the CHR-bank register's bit 4 also routes to WRAM /CE;
    // pick CHR values that leave that bit clear in both windows.
    await writeReg(bus, CHR0_REG, 0x02);
    await writeReg(bus, CHR1_REG, 0x05);
  },

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();
    await init(bus);
    return walkBanks(
      {
        label: "MMC1 PRG",
        bankBytes: PRG_BANK_BYTES,
        numBanks: (sizeKB * 1024) / PRG_BANK_BYTES,
        readBank: async (bank) => {
          // Select the 32 KiB bank — in 32 KiB PRG mode the bank
          // register's LSB is ignored, so shift the index up by one.
          await writeReg(bus, PRG_REG, bank << 1);
          // The select's leading reset forces PRG mode back to 3, so
          // re-assert the control register last; otherwise the read lands
          // in 16 KiB mode and $C000-$FFFF returns the fixed last bank,
          // losing every odd 16 KiB bank.
          await writeReg(bus, CTRL_REG, CTRL_DUMP_MODE);
          return bus.readCpu(0x8000, PRG_BANK_BYTES);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0);
    if (!bus.readPpu) {
      throw new Error(
        "MMC1 CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific `dumpChrRom` override for mapper 1.",
      );
    }

    const readPpu = bus.readPpu.bind(bus);

    await bus.setup();
    await init(bus);

    return walkBanks(
      {
        label: "MMC1 CHR",
        bankBytes: CHR_BANK_BYTES,
        numBanks: (sizeKB * 1024) / CHR_BANK_BYTES,
        readBank: async (bank) => {
          // 4 KiB CHR mode: load each window independently.
          await writeReg(bus, CHR0_REG, bank * 2);
          await writeReg(bus, CHR1_REG, bank * 2 + 1);
          return readPpu(0x0000, CHR_BANK_BYTES);
        },
      },
      onProgress,
    );
  },
};
