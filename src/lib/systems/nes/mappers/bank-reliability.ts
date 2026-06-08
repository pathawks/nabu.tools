/**
 * Bank-read reliability for bank-switched NES mappers.
 *
 * Modern reproduction carts that present as a standard mapper but
 * implement it in a CPLD / clone ASIC (rather than a harvested
 * first-party mapper part) misbehave in two distinct ways, each with its
 * own countermeasure here:
 *
 *   1. **Bank-0 dropout** — the cart intermittently fails to latch a
 *      bank-select write, so the affected bank reads back as a verbatim
 *      copy of bank 0 (the power-on default mapping). Countered by
 *      `readBankWithRetry`.
 *   2. **Varying misread** — a bank read intermittently returns the wrong
 *      content with no fixed reference to test against (e.g. the Mapper
 *      268 CoolBoy/Mindkids clone substitutes a *different* bank).
 *      Countered by `readBankWithConsensus`.
 *
 * (Original first-party mapper silicon latches deterministically and
 * never trips either.)
 *
 * `readBankWithRetry` is the reactive countermeasure for dropout: read a
 * bank, and if it came back identical to bank 0 (a dropout), re-run the
 * bank-select and re-read, up to `maxAttempts`. A clean read returns on
 * the first attempt and costs nothing, so this is safe to leave engaged on
 * every device. It supersedes the older "blindly issue the bank-select
 * sequence twice" double-latch, which only *reduced* the drop rate —
 * verify-and-retry detects the failure and actually recovers from it, and
 * generalises to any bank-switched mapper instead of being baked into one.
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

export type BankConsensusOutcome = "first" | "retried" | "unresolved";

export interface BankConsensusResult {
  data: Uint8Array;
  /**
   * `first`      — the first two reads agreed.
   * `retried`    — reads disagreed, but a value repeated within `maxAttempts`.
   * `unresolved` — no value ever repeated; `data` is the last read.
   */
  outcome: BankConsensusOutcome;
}

export interface BankConsensusOptions {
  /**
   * Read the bank's window. Invoked repeatedly to filter transient
   * read-path noise. The caller must have already selected the bank, and the
   * selection is NOT re-issued between reads — consensus targets a *varying*
   * misread, not a dropped bank-select (for the latter use `readBankWithRetry`).
   */
  read: () => Promise<Uint8Array>;
  /** Diagnostic label, e.g. `"Mapper 268 bank 5"`. */
  label: string;
  /** Total reads before accepting the last one unverified. Default 5. */
  maxAttempts?: number;
  /** Where the unresolved-bank notice goes. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/**
 * Read a bank repeatedly until two reads agree, returning the agreed value.
 *
 * The counterpart to `readBankWithRetry`, for mappers whose failure is a
 * transient, *varying* misread (e.g. the Mapper 268 CoolBoy/Mindkids clone's
 * bank substitution) rather than a clean revert to bank 0. There's no
 * known-bad reference to test against here, so we instead trust a value that
 * reproduces. A *consistent* (non-varying) misread can't be caught this way
 * and must be prevented upstream — settle delays, a menu-mimicking register
 * write — or caught by a multi-pass merge.
 */
export async function readBankWithConsensus(
  opts: BankConsensusOptions,
): Promise<BankConsensusResult> {
  const {
    read,
    label,
    maxAttempts = 5,
    log = (message: string) => console.warn(message),
  } = opts;

  const first = await read();
  const second = await read();
  if (bytesEqual(first, second)) return { data: first, outcome: "first" };

  // Reads disagree: keep reading until one value reproduces an earlier read.
  const seen: Uint8Array[] = [first, second];
  while (seen.length < maxAttempts) {
    const next = await read();
    if (seen.some((prev) => bytesEqual(prev, next))) {
      return { data: next, outcome: "retried" };
    }
    seen.push(next);
  }

  log(
    `[nes] ${label}: ${maxAttempts} reads never agreed — accepting the last ` +
      `(possible bank substitution; a re-dump or multi-pass merge may differ)`,
  );
  return { data: seen[seen.length - 1], outcome: "unresolved" };
}
