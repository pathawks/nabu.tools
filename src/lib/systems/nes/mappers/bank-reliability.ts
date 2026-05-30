/**
 * Bank-read reliability for bank-switched NES mappers.
 *
 * Modern reproduction carts that present as a standard mapper but
 * implement it in a CPLD / clone ASIC (rather than a harvested
 * first-party mapper part) intermittently **fail to latch a bank-select
 * write**. The affected 8 KiB bank then reads back as a verbatim copy of
 * bank 0 — the power-on default mapping — instead of its real content.
 * Which banks drop varies run to run; a bank that does latch is
 * byte-stable. (Original first-party mapper silicon latches
 * deterministically and never trips this.)
 *
 * `readBankWithRetry` is the reactive countermeasure: read a bank, and if
 * it came back identical to bank 0 (a dropout), re-run the bank-select and
 * re-read, up to `maxAttempts`. A clean read returns on the first attempt
 * and costs nothing, so this is safe to leave engaged on every device. It
 * supersedes the older "blindly issue the bank-select sequence twice"
 * double-latch, which only *reduced* the drop rate — verify-and-retry
 * detects the failure and actually recovers from it, and generalises to
 * any bank-switched mapper instead of being baked into one.
 *
 * The dropout predicate is deliberately "== bank 0", NOT "all 0x00 / all
 * 0xFF": a uniform bank 0 is a blank/dead read (open bus), a separate
 * signal we must not confuse with a latch dropout — so a uniform-fill
 * reference disables the check (see `isUniformFill`). The same predicate
 * backs the post-hoc `analyzeDump` "N banks identical to bank 0" report, so
 * detection is defined exactly once.
 *
 * This module is intentionally dependency-free: it inspects only the
 * returned bytes and re-invokes a caller-supplied select+read thunk, so the
 * mapper keeps ownership of *how* to select a bank while this owns *how to
 * cope* when a select doesn't take.
 */

/** Byte-for-byte equality of two arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * True when every byte of `bank` is identical (e.g. all-0xFF open bus or
 * all-0x00) — a blank read, not real bank content. An empty array is not
 * uniform-fill (there's nothing to read).
 */
export function isUniformFill(bank: Uint8Array): boolean {
  return bank.length > 0 && bank.every((b) => b === bank[0]);
}

/**
 * True when `bank` looks like a dropped bank-select: byte-identical to the
 * reference (bank 0) AND the reference isn't a uniform blank read. A
 * legitimately-duplicated bank also matches, so callers must cap retries
 * and accept the value rather than treat a match as fatal.
 */
export function isBankDropout(
  bank: Uint8Array,
  reference: Uint8Array,
): boolean {
  return !isUniformFill(reference) && bytesEqual(bank, reference);
}

export interface BankRetryOptions {
  /**
   * Select the target bank and read its window, as one unit. Re-invoked on
   * each attempt so a marginal clone latch is re-presented before the
   * re-read — re-reading without re-selecting would just return the same
   * stale bank.
   */
  attempt: () => Promise<Uint8Array>;
  /**
   * Bank 0 — the dropout reference. Pass `null` for bank 0 itself (the
   * first bank), where there's nothing to compare against.
   */
  reference?: Uint8Array | null;
  /** Diagnostic label for logs, e.g. `"MMC3 PRG bank 5"`. */
  label: string;
  /** Total attempts before giving up and accepting the last read. Default 3. */
  maxAttempts?: number;
  /** Where retry notices go. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/**
 * Read one bank, retrying the select+read when it comes back as a bank-0
 * dropout. Returns the first clean read; if every attempt dropped, returns
 * the last attempt (after logging) and leaves recovery to a re-dump or the
 * multi-pass merge — the post-hoc `analyzeDump` note will flag it too.
 */
export async function readBankWithRetry(
  opts: BankRetryOptions,
): Promise<Uint8Array> {
  const {
    attempt,
    reference,
    label,
    maxAttempts = 3,
    log = (message: string) => console.warn(message),
  } = opts;

  // `isBankDropout` returns false for a null/uniform-fill reference (the
  // reference bank itself, or an open-bus bank 0), so those read once and
  // are taken at face value.
  let result = await attempt();
  let attempts = 1;
  while (
    reference != null &&
    isBankDropout(result, reference) &&
    attempts < maxAttempts
  ) {
    log(
      `[nes] ${label} read back as bank 0 — re-selecting and re-reading ` +
        `(attempt ${attempts + 1}/${maxAttempts})`,
    );
    result = await attempt();
    attempts++;
  }

  if (reference != null && isBankDropout(result, reference)) {
    log(
      `[nes] ${label} still identical to bank 0 after ${maxAttempts} attempts — ` +
        `accepting as-is; a re-dump or multi-pass merge may recover it`,
    );
  }

  return result;
}
