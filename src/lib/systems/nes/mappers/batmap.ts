/**
 * NES 2.0 Mapper 413 — BATMAP board (a single-title board with an
 * 8 MiB speech ROM).
 *
 * Geometry (the board exists in exactly one configuration):
 *   256 KiB PRG flash  — 8 KiB banks, all reachable through one window.
 *   256 KiB CHR flash  — 4 KiB banks, all reachable through one window.
 *   8 MiB serial flash — speech samples, dumped as the NES 2.0
 *       miscellaneous-ROM file section (header byte 14 = 1).
 *
 * Banking registers (write-only; a CPLD implements the whole mapper):
 *   $8000-$BFFF  scanline-IRQ block — never touched by the dump.
 *   $E000-$FFFF  bank port: reg[D7-D6] = D5-D0. reg1 = 8 KiB PRG at
 *                $8000, reg3 = 4 KiB CHR at PPU $0000 (reg0/reg2 map
 *                more PRG windows the dump doesn't need).
 *   PRG fixed banks (#1 at $5000, #7 at $D000, #4 at $E000) and CHR
 *   fixed bank $3D at $1000 are reachable through the switchable
 *   windows, so the walks below cover every byte. Power-on state:
 *   all regs 0 (never relied on — every access selects state first).
 *
 * ── The serial-flash port: a bit-banged SPI bridge ──
 *
 * Hardware-validated 2026-06-13 by replaying the protocol extracted
 * from the game's own driver code (in our canonical-verified PRG dump).
 * The emulator model — a 23-bit auto-increment pointer register — is a
 * behavioral approximation; the CPLD actually bridges the CPU bus
 * straight to the flash's SPI interface:
 *
 *   $D000 bit 0    SPI /CS framing. An ARM PULSE (write $01 then $00)
 *                  must precede every frame — modeled by NO emulator;
 *                  without it the port never leaves 0xFF.
 *   $C000 writes   shift one command bit each (D7), self-clocked by
 *                  the write cycle. A frame is the flash's raw 32-bit
 *                  READ command: 0x03 + 24-bit byte address, MSB first.
 *   $D000 = $02    data phase: the CPLD shifts one SPI bit per
 *                  cart-addressed READ cycle (any /ROMSEL read — on a
 *                  console, instruction fetches supply these for free),
 *                  halting at 8 bits; a $C000 read latches the
 *                  assembled byte and re-arms the bit counter. The
 *                  first $C000 read after a frame arms the engine and
 *                  returns pipeline garbage — issue and discard it.
 *                  Sequential addresses come from the flash's own
 *                  streaming read; there is no mapper-side pointer.
 *
 * The $4800-$4FFF mirror in FCEUX/MiSTer/puNES does NOT exist on
 * hardware (reads there are open bus); the emulators' 4-6 cycle
 * "increment cooldown" is their approximation of the 8-clocks-per-byte
 * reality. Dumping needs a device-paced read path (8 cart-ROM reads
 * then a port read, per byte) — the optional `bus.readSpiDataPort`
 * capability; a generic block `readCpu` cannot express it. Frames are
 * re-opened per 1 MiB block, so a glitch can corrupt at most one block
 * and every block is independently retryable.
 *
 * The pre-flight probe reads the first KiB twice (the stream must be
 * deterministic) and from address 4 once (the streams must overlap
 * shifted by 4) — catching a dead port, frame/clock misalignment, and
 * non-landing register writes in seconds instead of after the full
 * dump. Uniform data satisfies the overlap by construction, so erased
 * fill can't false-positive; post-dump hash verification and the
 * uniform-misc advisory in the system handler backstop that blind spot.
 *
 * PRG/CHR walks were verified byte-exact against the canonical
 * per-section hashes on INL hardware (2026-06-13); the serial-flash
 * recipe was validated over 96-byte windows at both ends of the flash,
 * with the full-dump hash check pending. The board wires the PRG
 * flash's /WE straight to CPU R/W: stick to the documented register
 * writes above, nothing else.
 */

import type { NesBus } from "../bus";
import type { NesMapper } from "./types";
import { walkBanks } from "./bank-walk";
import { bytesEqual } from "./bank-reliability";

const DATA_PORT = 0xc000; // reads: latch SPI byte; writes: shift command bit
const CONTROL_REG = 0xd000;
const CS_ASSERT = 0x01; // control bit 0 — the arm pulse
const CS_RELEASE = 0x00;
const DATA_PHASE = 0x02; // control bit 1
const SPI_READ_CMD = 0x03; // the flash's READ opcode, first byte of a frame

const PRG_WINDOW = 0x8000;
const PRG_BANK = 8 * 1024;
const REG1_SELECT = 0x40; // bank-port value D7-D6 = 01 → reg1 (PRG $8000)
const CHR_BANK = 4 * 1024;
const REG3_SELECT = 0xc0; // bank-port value D7-D6 = 11 → reg3 (CHR $0000)

/** Re-open the SPI frame per block: bounded blast radius, retryable. */
const MISC_BLOCK = 1024 * 1024;
const PROBE_BYTES = 1024;

const EXPECTED_PRG_KB = 256;
const EXPECTED_CHR_KB = 256;
const EXPECTED_MISC_KB = 8192;

type SpiBus = NesBus &
  Required<Pick<NesBus, "readSpiDataPort" | "readCpuByte">>;

/**
 * Open an SPI READ frame at `address`: arm pulse, 32 command bits,
 * data phase, and the arming read (discarded — pipeline garbage).
 */
async function openFrame(bus: SpiBus, address: number): Promise<void> {
  await bus.writeCpu(CONTROL_REG, CS_ASSERT);
  await bus.writeCpu(CONTROL_REG, CS_RELEASE);
  // 0x03 + 24-bit address, MSB first, one bit per write in D7.
  const frame = (SPI_READ_CMD << 24) | (address & 0xffffff);
  for (let bit = 31; bit >= 0; bit--) {
    await bus.writeCpu(DATA_PORT, ((frame >>> bit) & 1) << 7);
  }
  await bus.writeCpu(CONTROL_REG, DATA_PHASE);
  await bus.readCpuByte(DATA_PORT);
}

async function readMiscBlock(
  bus: SpiBus,
  address: number,
  length: number,
  onProgress?: (bytesRead: number) => void,
): Promise<Uint8Array> {
  await openFrame(bus, address);
  return bus.readSpiDataPort(length, onProgress);
}

export const mapper413: NesMapper = {
  id: 413,
  name: "BATMAP",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    if (sizeKB !== EXPECTED_PRG_KB) {
      throw new Error(
        `Mapper 413 boards carry exactly ${EXPECTED_PRG_KB} KiB PRG; got ${sizeKB} KiB`,
      );
    }
    await bus.setup();
    return walkBanks(
      {
        label: "BATMAP PRG",
        bankBytes: PRG_BANK,
        numBanks: (sizeKB * 1024) / PRG_BANK,
        readBank: async (bank) => {
          await bus.writeCpu(0xe000, REG1_SELECT | bank);
          return bus.readCpu(PRG_WINDOW, PRG_BANK);
        },
      },
      onProgress,
    );
  },

  async dumpChrRom(bus, sizeKB, onProgress) {
    if (sizeKB !== EXPECTED_CHR_KB) {
      throw new Error(
        `Mapper 413 boards carry exactly ${EXPECTED_CHR_KB} KiB CHR; got ${sizeKB} KiB`,
      );
    }
    if (!bus.readPpu) {
      throw new Error(
        "BATMAP CHR-ROM dump requires a PPU-bus read primitive, which this driver does not expose. Provide a driver-specific `dumpChrRom` override for mapper 413.",
      );
    }
    const readPpu = bus.readPpu.bind(bus);

    await bus.setup();
    return walkBanks(
      {
        label: "BATMAP CHR",
        bankBytes: CHR_BANK,
        numBanks: (sizeKB * 1024) / CHR_BANK,
        readBank: async (bank) => {
          await bus.writeCpu(0xe000, REG3_SELECT | bank);
          return readPpu(0x0000, CHR_BANK);
        },
      },
      onProgress,
    );
  },

  async dumpMiscRom(bus, sizeKB, onProgress) {
    if (sizeKB !== EXPECTED_MISC_KB) {
      throw new Error(
        `Mapper 413 boards carry exactly ${EXPECTED_MISC_KB} KiB of miscellaneous ROM; got ${sizeKB} KiB`,
      );
    }
    if (!bus.readSpiDataPort || !bus.readCpuByte) {
      throw new Error(
        "BATMAP's serial sample flash needs a device-paced SPI read path (8 cart-ROM clock reads per byte), which this driver does not expose. The miscellaneous ROM cannot be dumped on this device.",
      );
    }
    const spiBus = bus as SpiBus;

    await bus.setup();

    // Pre-flight probe (see header): the stream must repeat exactly on
    // a re-opened frame, and a frame at address 4 must overlap the
    // address-0 stream shifted by 4.
    const first = await readMiscBlock(spiBus, 0, PROBE_BYTES);
    const again = await readMiscBlock(spiBus, 0, PROBE_BYTES);
    if (!bytesEqual(first, again)) {
      throw new Error(
        "Mapper 413 serial-flash probe failed: two reads of the same address " +
          "differ, so the SPI stream is not deterministic on this device. " +
          "Aborting before the full dump.",
      );
    }
    const shifted = await readMiscBlock(spiBus, 4, PROBE_BYTES);
    if (!bytesEqual(shifted.subarray(0, PROBE_BYTES - 4), first.subarray(4))) {
      throw new Error(
        "Mapper 413 serial-flash probe failed: streams from address 0 and " +
          "address 4 do not overlap, so frame addressing or per-byte clocking " +
          "is misaligned on this device. Aborting before the full dump.",
      );
    }

    const totalBytes = sizeKB * 1024;
    const out = new Uint8Array(totalBytes);
    for (let off = 0; off < totalBytes; off += MISC_BLOCK) {
      const block = await readMiscBlock(spiBus, off, MISC_BLOCK, (bytesRead) =>
        onProgress?.(off + bytesRead, totalBytes),
      );
      out.set(block, off);
    }
    return out;
  },
};
