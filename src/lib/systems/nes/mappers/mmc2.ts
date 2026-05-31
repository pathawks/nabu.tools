/**
 * MMC2 (iNES mapper 9) — device-agnostic dumper.
 *
 * PRG-ROM: 128 KiB. An 8 KiB switchable bank at $8000-$9FFF (register
 * $A000, low 4 bits) plus three banks fixed to the last three 8 KiB banks
 * at $A000-$FFFF. Every bank is reachable through the switchable window,
 * so we read all 16 banks the same way.
 *
 * CHR-ROM: 128 KiB of 4 KiB banks governed by MMC2's signature latch. The
 * PPU $0000 window draws from register $B000 while latch 0 holds $FD and
 * from $C000 while it holds $FE; the latch flips automatically when the
 * PPU fetches tile $FD ($0FD8) or tile $FE ($0FE8). A sequential 4 KiB
 * read crosses both trigger addresses, so the bank would swap mid-read.
 * We sidestep the latch entirely by programming both the $FD and $FE
 * registers to the same bank: the window then maps the same 4 KiB no
 * matter which way the latch flips or what state it started in. Every bank
 * is reachable through the $0000 window, so the $1000 window registers
 * ($D000/$E000) are never needed for dumping.
 *
 * Reference: https://www.nesdev.org/wiki/MMC2
 */

import type { NesBus, BusProgressCb } from "../bus";
import type { NesMapper } from "./types";
import { walkBanks } from "./bank-walk";

// MMC2 registers (write-only, mirrored across their $x000-$xFFF page).
const PRG_BANK = 0xa000; // 8 KiB bank → CPU $8000-$9FFF (4 bits)
const CHR0_FD_BANK = 0xb000; // 4 KiB bank → PPU $0000 when latch 0 = $FD
const CHR0_FE_BANK = 0xc000; // 4 KiB bank → PPU $0000 when latch 0 = $FE

const PRG_BANK_KB = 8;
const CHR_BANK_KB = 4;

export const mmc2: NesMapper = {
  id: 9,
  name: "MMC2",

  async dumpPrgRom(
    bus: NesBus,
    sizeKB: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    await bus.setup();
    const bankBytes = PRG_BANK_KB * 1024;
    // Each 8 KiB bank — including the three normally fixed at $A000-$FFFF —
    // is reachable through the switchable $8000 window, so read them all the
    // same way.
    return walkBanks(
      {
        label: "MMC2 PRG",
        bankBytes,
        numBanks: sizeKB / PRG_BANK_KB,
        readBank: async (bank) => {
          await bus.writeCpu(PRG_BANK, bank & 0x0f);
          return bus.readCpu(0x8000, bankBytes);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(
    bus: NesBus,
    sizeKB: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    if (!bus.readPpu) {
      throw new Error(
        "MMC2 (mapper 9) CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific `dumpChrRom` override for mapper 9.",
      );
    }

    const readPpu = bus.readPpu.bind(bus);

    await bus.setup();
    const bankBytes = CHR_BANK_KB * 1024;
    return walkBanks(
      {
        label: "MMC2 CHR",
        bankBytes,
        numBanks: sizeKB / CHR_BANK_KB,
        // Pin both latch banks to the same 4 KiB bank so the latch flip at
        // $0FD8/$0FE8 partway through the read is a no-op. No bank-0 dropout
        // retry: with both registers equal the window is latch-immune, and
        // CHR banks aren't bank-0-default the way a dropped PRG select is.
        retry: false,
        readBank: async (bank) => {
          await bus.writeCpu(CHR0_FD_BANK, bank & 0x1f);
          await bus.writeCpu(CHR0_FE_BANK, bank & 0x1f);
          return readPpu(0x0000, bankBytes);
        },
      },
      onProgress,
    );
  },
};
