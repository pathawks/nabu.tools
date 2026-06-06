/**
 * FME-7 / 5A / 5B (iNES mapper 69) — a command/parameter ASIC mapper,
 * mostly seen on Famicom boards (the 5B adds expansion audio; all three
 * variants are register-identical for dumping).
 *
 * Every register is reached through a two-write protocol:
 *   $8000-$9FFF  command select (low 4 bits)
 *   $A000-$BFFF  parameter — this write invokes the selected command
 * The chip is an ASIC, so neither write suffers a bus conflict.
 *
 * Commands $0-$7 are eight independent 1 KiB CHR windows covering PPU
 * $0000-$1FFF (8-bit bank numbers, up to 256 KiB CHR-ROM). Commands $9/$A/$B
 * switch 8 KiB PRG-ROM banks at $8000/$A000/$C000; $E000-$FFFF is hardwired
 * to the last bank. Walking command $9 alone covers all of PRG (the FME-7
 * decodes 6 bank bits, the 5A/5B 5 — both beyond any released cart).
 *
 * Command $8 controls the $6000-$7FFF window: `ERbBBBBB`, where bit 6
 * selects RAM over ROM and bit 7 is the RAM chip-enable (6264 +CE). Only
 * $C0|bank exposes the battery WRAM; $40-$7F reads open bus (RAM selected
 * but disabled), and any value with bit 6 clear ($00-$3F, $80-$BF) maps a
 * PRG-ROM bank there instead — so dumping leaves it at $00 (RAM
 * disconnected) and `dumpSave` brackets the save read with $C0 / $00.
 *
 * Two write-hazards shape the protocol, both avoided by construction:
 * commands $D-$F are the IRQ control/counter (never selected), and on the
 * 5B all CPU writes to $C000-$FFFF land on the expansion-audio PSG ports
 * (reads there still return PRG-ROM) — every register access above stays
 * within $8000-$BFFF.
 *
 * Reference: nesdev wiki, iNES mapper 069.
 */

import type { NesBus } from "../bus";
import type { NesMapper } from "./types";
import { walkBanks } from "./bank-walk";

const COMMAND_REG = 0x8000; // $8000-$9FFF: command select
const PARAMETER_REG = 0xa000; // $A000-$BFFF: parameter, invokes the command

// Commands $0-$7: 1 KiB CHR window N at PPU $0000 + N*$400.
const CMD_PRG_6000 = 0x8; // $6000-$7FFF window: ERbBBBBB (see header)
const CMD_PRG_8000 = 0x9; // 8 KiB PRG-ROM bank at $8000-$9FFF
// $A/$B (the $A000/$C000 windows) are unneeded — command $9 reaches every
// bank — and $C (mirroring) doesn't affect dumped content. $D-$F are IRQ.

const PRG_BANK_KB = 8;
const PRG_BANK_BYTES = PRG_BANK_KB * 1024;
const CHR_WINDOWS = 8; // eight 1 KiB windows = one 8 KiB stride per read
const CHR_STRIDE_KB = 8;
const CHR_STRIDE_BYTES = CHR_STRIDE_KB * 1024;

/** Two-write register protocol: select `command`, then write its parameter. */
async function writeReg(
  bus: NesBus,
  command: number,
  value: number,
): Promise<void> {
  await bus.writeCpu(COMMAND_REG, command);
  await bus.writeCpu(PARAMETER_REG, value);
}

/**
 * Park the $6000-$7FFF window in a known, RAM-safe state: ROM bank 0,
 * WRAM deselected and chip-disabled — so nothing during a ROM pass can
 * touch a battery save (the same protective intent as MMC3's PRG-RAM
 * write-protect init).
 */
async function init(bus: NesBus): Promise<void> {
  await writeReg(bus, CMD_PRG_6000, 0x00);
}

export const fme7: NesMapper = {
  id: 69,
  name: "FME-7",

  async dumpSave(bus, sramKB, onProgress) {
    await bus.setup();
    // $C0 = RAM selected (bit 6) + chip enabled (bit 7), WRAM bank 0 —
    // the only command-$8 state that exposes the save SRAM at $6000.
    await writeReg(bus, CMD_PRG_6000, 0xc0);
    const data = await bus.readCpu(0x6000, sramKB * 1024, onProgress);
    // Re-park the window ROM-side as soon as the read completes (the
    // reference dumper does the same): deasserting the 6264's chip-enable
    // shields a battery save from stray bus cycles for the rest of the
    // session — including the unplug power-down, the riskiest window.
    await writeReg(bus, CMD_PRG_6000, 0x00);
    return data;
  },

  async dumpPrgRom(bus, sizeKB, onProgress) {
    await bus.setup();
    await init(bus);
    return walkBanks(
      {
        label: "FME-7 PRG",
        bankBytes: PRG_BANK_BYTES,
        numBanks: sizeKB / PRG_BANK_KB,
        readBank: async (bank) => {
          await writeReg(bus, CMD_PRG_8000, bank);
          return bus.readCpu(0x8000, PRG_BANK_BYTES);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB === 0) return new Uint8Array(0); // CHR-RAM cart
    if (!bus.readPpu) {
      throw new Error(
        "FME-7 CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific `dumpChrRom` override for mapper 69.",
      );
    }

    const readPpu = bus.readPpu.bind(bus);

    await bus.setup();
    await init(bus);

    return walkBanks(
      {
        label: "FME-7 CHR",
        bankBytes: CHR_STRIDE_BYTES,
        numBanks: sizeKB / CHR_STRIDE_KB,
        // Program all eight 1 KiB windows to consecutive banks, then read
        // the whole PPU $0000-$1FFF span in one stride.
        readBank: async (stride) => {
          for (let w = 0; w < CHR_WINDOWS; w++) {
            await writeReg(bus, w, stride * CHR_WINDOWS + w);
          }
          return readPpu(0x0000, CHR_STRIDE_BYTES);
        },
      },
      onProgress,
    );
  },
};
