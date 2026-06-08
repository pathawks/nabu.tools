/**
 * iNES 2.0 Mapper 268 — CoolBoy / Mindkids MMC3-clone multicart.
 *
 * Two submappers, identical except for the address of their outer
 * bank-select registers:
 *   - Submapper 0 (CoolBoy):  registers at $6000-$6FFF
 *   - Submapper 1 (Mindkids): registers at $5000-$5FFF
 *
 * Outer-register bit layout (per nesdev wiki, identical across the two
 * submappers):
 *
 *   $xxx0  A B CC D EEE   A = CHR A17 mask (1 = mask, 0 = offset)
 *                         B = PRG A17 mask
 *                         CC = PRG A23/A24 offset
 *                         D  = CHR A17 offset
 *                         EEE = PRG A17/A18/A19 offset
 *   $xxx1  G H I J KK L S G = PRG A18 mask
 *                         H = PRG A19 mask
 *                         I = PRG A20 mask
 *                         J = PRG A20 offset
 *                         KK = PRG A22/A21 offsets
 *                         L = GNROM bank size (0 = 16 KiB, 1 = 32 KiB)
 *                         S = SC0
 *   $xxx2                 GNROM CHR config (CHR-RAM carts: keep 0)
 *   $xxx3  N _ _ _ P QQ S N = Lockout (write-once)
 *                         P = GNROM enable (bit 4)
 *                         QQ = low PRG bank bits (bits 3..1)
 *                         S = sound/scroll (keep 0)
 *
 * Dump strategy: GNROM mode, 16 KiB banks, one register-write set per
 * bank. Mirrors ClusterM's famicom-dumper-client reference
 * implementation (AA6023Sub0.cs / AA6023Sub1.cs). MMC3-mode walks
 * (the obvious first instinct, since fceux models this as an MMC3
 * clone) don't work on real hardware: the cart's A17/A18 *mask* bits
 * default to "follow MMC3," so the outer register's offset bits never
 * reach the PRG address lines unless the masks are explicitly cleared
 * — which the GNROM-mode walk does inherently. An MMC3 walk also
 * runs into the cart's 6-bit R6/R7 limit (only 512 KiB reachable per
 * outer-register setting) and into bank-decoder quirks at R6 ≥ 48.
 *
 * Per-bank register writes (bank index N, 16 KiB units):
 *
 *   r0 = ((N >> 3) & 7) | (((N >> 9) & 3) << 4) | (1 << 6)
 *        bit 6: clear A17 mask (A17 follows offset, not MMC3)
 *        bits 0..2: PRG offset A17..A19 = N[3..5]
 *        bits 4..5: PRG offset A23/A24 = N[9..10]
 *   r1 = (((N >> 7) & 3) << 2) | (((N >> 6) & 1) << 4) | (1 << 7)
 *        bit 7: clear A18 mask (A18 follows offset, not MMC3)
 *        bit 4: PRG offset A20 = N[6]
 *        bits 2..3: PRG offset A22/A21 = N[7..8]
 *   r2 = 0
 *   r3 = (1 << 4) | ((N & 7) << 1)
 *        bit 4: GNROM enable
 *        bits 1..3: low PRG bank bits = N[0..2]
 *
 * Then a 16 KiB read at $8000 returns bank N.
 *
 * Cart-side CHR is RAM only on submappers 0/1 — `dumpChrRom` returns
 * an empty array.
 *
 * Hardware caveat: SMD172-family carts have an on-board reset detector
 * that some forum reports claim re-locks the mapper mid-dump on generic
 * dumpers (CopyNES and Tengu are reported as clean). A dumper driving
 * dense back-to-back bus cycles latches these registers with occasional
 * stochastic dropouts — the consensus read below exists for exactly
 * that. The INL Retro, which idles M2 low and emits one M2 pulse per
 * write, never latches a single register write at all; its driver
 * pre-flight-rejects this mapper — see UNSUPPORTED_MAPPERS in
 * drivers/inl/unsupported-mappers for the full hardware account.
 *
 * References:
 *   - ClusterM Sub1 (Mindkids, $5000): github.com/ClusterM/famicom-dumper-client
 *     /blob/master/FamicomDumper/mappers/AA6023Sub1.cs
 *   - ClusterM Sub0 (CoolBoy, $6000): same repo, AA6023Sub0.cs
 *   - nesdev wiki: nesdev.org/wiki/NES_2.0_Mapper_268
 */

import type { NesMapper } from "./types";
import { readBankWithConsensus } from "./bank-reliability";

export type Mapper268Submapper = 0 | 1;

const COOLBOY_BASE = 0x6000;
const MINDKIDS_BASE = 0x5000;
const BANK_SIZE = 16 * 1024;

/**
 * Build a Mapper 268 implementation for the given submapper variant.
 * The only difference between 0 and 1 is the address of the outer
 * register block.
 */
export function createMapper268(submapper: Mapper268Submapper): NesMapper {
  const base = submapper === 1 ? MINDKIDS_BASE : COOLBOY_BASE;

  return {
    id: 268,
    // The family name, matching NES_MAPPER_DB — the two submappers differ
    // only by register base, not by anything the UI/error surfaces, so a
    // single name keeps the catalog and DB labels from diverging.
    name: "Mindkids / CoolBoy",

    async dumpPrgRom(bus, sizeKB, onProgress) {
      await bus.setup();

      // The SMD172-family CPLD intermittently substitutes a *different*
      // bank for the one selected (~5-10% of reads on a dumper whose
      // writes it accepts at all). Three defenses:
      //   (C) `SETTLE_MS` after each register write — lets the CPLD latch
      //       before the read.
      //   (B) Menu-mimicking two-phase register write: the cart firmware
      //       launches each game by writing the outer registers TWICE,
      //       first in an MMC3-mode transitional state ($xxx1=$90,
      //       $xxx3=$00), then in the committed GNROM state. Mirroring
      //       that gives the CPLD a clean mode transition into GNROM.
      //   (A) Consensus read: read each bank until two reads agree, so a
      //       transient substitution is caught at the source rather than
      //       needing a second full dump.
      const SETTLE_MS = 5;
      const MAX_READ_ATTEMPTS = 5;
      // Menu phase 1 values (matches captured launch sequence on
      // production-released Mindkids multicarts).
      const PHASE1_R1 = 0x90;
      const PHASE1_R3 = 0x00;

      const totalBytes = sizeKB * 1024;
      const numBanks = Math.ceil(totalBytes / BANK_SIZE);
      const out = new Uint8Array(totalBytes);

      const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

      const writeRegs = async (r0: number, r1: number, r3: number) => {
        // Phase 1: MMC3-mode transitional state. Same offset bits in
        // $xxx0 as the final state so any masking change in $xxx1
        // doesn't snap us to a stale offset, but $xxx1/$xxx3 carry the
        // menu's pre-launch values.
        await bus.writeCpu(base + 0, r0);
        await settle();
        await bus.writeCpu(base + 1, PHASE1_R1);
        await settle();
        await bus.writeCpu(base + 2, 0);
        await settle();
        await bus.writeCpu(base + 3, PHASE1_R3);
        await settle();

        // Phase 2: commit our GNROM-mode walk state.
        await bus.writeCpu(base + 0, r0);
        await settle();
        await bus.writeCpu(base + 1, r1);
        await settle();
        await bus.writeCpu(base + 2, 0);
        await settle();
        await bus.writeCpu(base + 3, r3);
        await settle();
      };

      const selectBank = (bank: number) => {
        const r0 = ((bank >> 3) & 7) | (((bank >> 9) & 3) << 4) | (1 << 6);
        const r1 =
          (((bank >> 7) & 3) << 2) | (((bank >> 6) & 1) << 4) | (1 << 7);
        const r3 = (1 << 4) | ((bank & 7) << 1);
        return writeRegs(r0, r1, r3);
      };

      for (let bank = 0; bank < numBanks; bank++) {
        await selectBank(bank);

        const offset = bank * BANK_SIZE;
        const len = Math.min(BANK_SIZE, totalBytes - offset);

        // Consensus (not a bank-0 comparison) is the right check for this
        // clone: its glitch substitutes a *different* bank, with no
        // known-bad value to test against, and the re-reads target
        // transient read-path noise — so we re-read the same selection
        // rather than re-issuing registers.
        const { data } = await readBankWithConsensus({
          read: () => bus.readCpu(0x8000, len),
          label: `Mapper 268 bank ${bank}`,
          maxAttempts: MAX_READ_ATTEMPTS,
        });

        out.set(data, offset);
        onProgress?.(offset + len, totalBytes);
      }

      return out;
    },

    async dumpChrRom() {
      // Submappers 0/1 are CHR-RAM-only. No CHR-ROM to read.
      return new Uint8Array(0);
    },
  };
}

export const mapper268Coolboy = createMapper268(0);
export const mapper268Mindkids = createMapper268(1);
