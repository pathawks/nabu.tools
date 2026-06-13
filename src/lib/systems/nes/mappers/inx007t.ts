/**
 * iNES 2.0 Mapper 470 — INX_007T_V01 board (the 2022 licensed
 * re-release of a 1993 two-franchise crossover title).
 *
 * Geometry: 1 MiB PRG flash as 4 outer x 8 inner x 32 KiB banks.
 *   $5000  outer bank (2 bits, PRG A18-A19) — holds across bus idle.
 *   $8000  inner bank (PRG A15-A17); the vendor's reference recipe
 *          writes the GLOBAL 32 KiB bank index 0-31 here (the board
 *          decodes the low 3 bits) — we match that stream bit-for-bit.
 * CHR is 8 KiB CHR-RAM — nothing to dump.
 *
 * ── The latch lesson (why this walk prefers a fused write+read) ──
 *
 * The board's INNER latch does not survive bus idle. An earlier
 * implementation that latched $8000 in its own transaction and then
 * streamed each 32 KiB bank produced a structurally dead dump: against
 * the canonical No-Intro entry, 26 of 32 banks read back as WHOLE
 * copies of the power-on bank — meaning the latch was already gone
 * before each read transaction began, not merely decaying partway
 * through one. The vendor's hardware-validated routine never exposes
 * the latch to an idle gap: its firmware op performs the $8000 bank
 * write and a 2 KiB read back-to-back inside ONE transaction, re-issued
 * for every chunk (established by reverse-engineering the vendor host
 * app's dump routine against a bus-level trace of the device firmware).
 *
 * So this walk prefers the optional `bus.readCpuBankLatched` capability
 * — a fused latch+read matching the vendor op one-to-one, requested at
 * the vendor's 2 KiB cadence — and only falls back to split
 * writeCpu/readCpu sub-reads when the bus lacks it. The fallback
 * re-latches before every 4 KiB sub-read (readCpu requires 4 KiB-aligned
 * start addresses, so within one 32 KiB bank that is the finest spacing
 * at which a fresh read can begin), but every latch write still crosses
 * a transaction gap before its read: on hardware whose inner latch
 * decays across any idle, the fallback will reproduce the dead-dump
 * signature. It exists so the mapper still functions on a bus whose
 * latch happens to hold; drivers for this board family should supply
 * the fused capability.
 *
 * Hardware-validated on the Kazzo driver (1 MiB cart byte-perfect vs the
 * reference, via the split write/read path — so the inner latch survives
 * inter-transaction idle on a bus whose M2 idles high). On the INL Retro
 * this board family needs M2 idling high; the driver feature-detects the
 * firmware's M2 idle level and pre-flight-rejects this id on stock
 * (M2-low) builds — see M2_IDLE_GATED_MAPPERS in
 * drivers/inl/unsupported-mappers.
 *
 * References:
 *   - nesdev wiki: nesdev.org/wiki/NES_2.0_Mapper_470
 */

import type { NesMapper } from "./types";

const OUTER_BANK_REG = 0x5000;
const INNER_BANK_REG = 0x8000;
const OUTER_BANKS = 4;
const INNER_BANKS = 8;
const BANK_SIZE = 32 * 1024;
/** The vendor routine's fused latch+read chunk size. */
const FUSED_CHUNK = 2 * 1024;
/** Fallback sub-read size: readCpu starts must be 4 KiB-aligned. */
const SPLIT_CHUNK = 4 * 1024;
const EXPECTED_PRG_KB = (OUTER_BANKS * INNER_BANKS * BANK_SIZE) / 1024; // 1024

export const mapper470: NesMapper = {
  id: 470,
  name: "INX_007T_V01",

  async dumpPrgRom(bus, sizeKB, onProgress) {
    if (sizeKB !== EXPECTED_PRG_KB) {
      throw new Error(
        `Mapper 470 boards carry exactly ${EXPECTED_PRG_KB} KiB PRG; got ${sizeKB} KiB`,
      );
    }
    await bus.setup();

    const fused = bus.readCpuBankLatched?.bind(bus);
    const totalBytes = sizeKB * 1024;
    const out = new Uint8Array(totalBytes);
    let bytesRead = 0;

    for (let outer = 0; outer < OUTER_BANKS; outer++) {
      await bus.writeCpu(OUTER_BANK_REG, outer);
      for (let inner = 0; inner < INNER_BANKS; inner++) {
        // The vendor recipe writes the global 32 KiB bank index (0-31).
        const globalBank = outer * INNER_BANKS + inner;
        const chunkSize = fused ? FUSED_CHUNK : SPLIT_CHUNK;
        for (let off = 0; off < BANK_SIZE; off += chunkSize) {
          // Latch + read with no idle between them when the bus can
          // fuse the two; otherwise re-latch as close to the read as
          // the split primitives allow — see the latch lesson above.
          const chunk = fused
            ? await fused(INNER_BANK_REG, globalBank, 0x8000 + off, chunkSize)
            : await (async () => {
                await bus.writeCpu(INNER_BANK_REG, globalBank);
                return bus.readCpu(0x8000 + off, chunkSize);
              })();
          out.set(chunk, bytesRead);
          bytesRead += chunkSize;
          onProgress?.(bytesRead, totalBytes);
        }
      }
    }
    return out;
  },

  async dumpChrRom() {
    // CHR-RAM board — nothing to dump.
    return new Uint8Array(0);
  },
};
