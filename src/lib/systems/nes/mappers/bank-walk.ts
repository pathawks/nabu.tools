/**
 * Shared bank-walking dump engine.
 *
 * Every bank-switched NES mapper dumps a region the same way: read bank 0
 * as the reference, then for each later bank select it and read its window,
 * recovering a dropped bank-select latch — which reads back as a copy of
 * bank 0 — by re-issuing the read. Only *how a bank is selected and read*
 * differs between mappers, so that is all a mapper supplies (`readBank`);
 * this engine owns the loop, the bank-0 dropout retry, assembly, and
 * progress.
 */

import type { ProgressCb } from "./types";
import { readBankWithRetry } from "./bank-reliability";

export interface BankWalk {
  /** Label for dropout log lines, e.g. "GxROM PRG". */
  label: string;
  /** Bytes per bank. */
  bankBytes: number;
  /** Number of banks to read. */
  numBanks: number;
  /**
   * Select and read bank `index`. `reference` is bank 0 (read first by the
   * engine); bus-conflict mappers use it as the gate source, others ignore
   * it. The engine wraps this in the bank-0 dropout retry.
   */
  readBank(index: number, reference: Uint8Array): Promise<Uint8Array>;
  /**
   * Whether a dropped select reads back as bank 0 (the recoverable dropout
   * signature). Defaults to true. Mappers whose window is select-independent
   * once programmed — e.g. MMC2's latch-pinned CHR — set this false.
   */
  retry?: boolean;
}

export async function walkBanks(
  walk: BankWalk,
  onProgress?: ProgressCb,
): Promise<Uint8Array> {
  const { bankBytes, numBanks } = walk;
  const totalBytes = bankBytes * numBanks;
  const out = new Uint8Array(totalBytes);

  // Bank 0 — the dropout reference and, for bus-conflict mappers, the gate
  // source. Read through `readBank` so its own "home to bank 0" select runs.
  const bank0 = await walk.readBank(0, new Uint8Array(0));
  out.set(bank0, 0);
  onProgress?.(bankBytes, totalBytes);

  for (let i = 1; i < numBanks; i++) {
    const chunk =
      walk.retry === false
        ? await walk.readBank(i, bank0)
        : await readBankWithRetry({
            label: `${walk.label} bank ${i}`,
            reference: bank0,
            attempt: () => walk.readBank(i, bank0),
          });
    out.set(chunk, i * bankBytes);
    onProgress?.((i + 1) * bankBytes, totalBytes);
  }

  return out;
}
