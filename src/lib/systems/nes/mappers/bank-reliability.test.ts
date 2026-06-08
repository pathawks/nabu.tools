import { describe, it, expect } from "vitest";
import {
  bytesEqual,
  isUniformFill,
  isBankDropout,
  readBankWithRetry,
  readBankWithConsensus,
} from "./bank-reliability";

const u8 = (...bytes: number[]) => Uint8Array.from(bytes);

describe("bytesEqual", () => {
  it("compares contents, not identity", () => {
    expect(bytesEqual(u8(1, 2, 3), u8(1, 2, 3))).toBe(true);
    expect(bytesEqual(u8(1, 2, 3), u8(1, 2, 4))).toBe(false);
    expect(bytesEqual(u8(1, 2), u8(1, 2, 3))).toBe(false);
  });
});

describe("isUniformFill", () => {
  it("is true only for a non-empty all-same-byte array", () => {
    expect(isUniformFill(u8(0xff, 0xff, 0xff))).toBe(true);
    expect(isUniformFill(u8(0, 0, 0))).toBe(true);
    expect(isUniformFill(u8(0, 0, 1))).toBe(false);
    expect(isUniformFill(u8())).toBe(false);
  });
});

describe("isBankDropout", () => {
  it("flags a bank identical to a non-uniform reference", () => {
    expect(isBankDropout(u8(1, 2, 3), u8(1, 2, 3))).toBe(true);
  });
  it("does not flag a bank that differs", () => {
    expect(isBankDropout(u8(1, 2, 4), u8(1, 2, 3))).toBe(false);
  });
  it("never flags against a uniform (open-bus) reference", () => {
    expect(isBankDropout(u8(0xff, 0xff), u8(0xff, 0xff))).toBe(false);
  });
});

describe("readBankWithRetry", () => {
  it("returns the first read when it differs from the reference", async () => {
    let calls = 0;
    const out = await readBankWithRetry({
      label: "bank 1",
      reference: u8(0, 0, 0, 1),
      attempt: async () => {
        calls++;
        return u8(9, 9, 9, 9);
      },
    });
    expect(calls).toBe(1);
    expect(Array.from(out)).toEqual([9, 9, 9, 9]);
  });

  it("re-selects and re-reads when a bank drops back to bank 0", async () => {
    const reference = u8(1, 1, 1, 2);
    const reads = [u8(1, 1, 1, 2), u8(5, 6, 7, 8)]; // dropout, then clean
    let calls = 0;
    const out = await readBankWithRetry({
      label: "bank 5",
      reference,
      attempt: async () => reads[calls++],
      log: () => {},
    });
    expect(calls).toBe(2);
    expect(Array.from(out)).toEqual([5, 6, 7, 8]);
  });

  it("gives up after maxAttempts and returns the last read", async () => {
    const reference = u8(1, 1, 1, 2);
    let calls = 0;
    const logs: string[] = [];
    const out = await readBankWithRetry({
      label: "bank 7",
      reference,
      maxAttempts: 3,
      attempt: async () => {
        calls++;
        return u8(1, 1, 1, 2); // always a dropout
      },
      log: (m) => logs.push(m),
    });
    expect(calls).toBe(3);
    expect(Array.from(out)).toEqual([1, 1, 1, 2]);
    expect(logs.some((m) => m.includes("after 3 attempts"))).toBe(true);
  });

  it("takes bank 0 (null reference) at face value without retrying", async () => {
    let calls = 0;
    const out = await readBankWithRetry({
      label: "bank 0",
      reference: null,
      attempt: async () => {
        calls++;
        return u8(0, 0, 0, 0);
      },
    });
    expect(calls).toBe(1);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe("readBankWithConsensus", () => {
  /** A read thunk that serves the scripted values in order. */
  const scripted = (...values: Uint8Array[]) => {
    let i = 0;
    return {
      read: async () => values[i++],
      calls: () => i,
    };
  };

  it("accepts two agreeing reads at face value (outcome 'first')", async () => {
    const reads = scripted(u8(1, 2, 3), u8(1, 2, 3));
    const { data, outcome } = await readBankWithConsensus({
      read: reads.read,
      label: "bank 1",
    });
    expect(outcome).toBe("first");
    expect(Array.from(data)).toEqual([1, 2, 3]);
    expect(reads.calls()).toBe(2);
  });

  it("keeps reading until a value reproduces (outcome 'retried')", async () => {
    // First two disagree; the third reproduces the FIRST read — consensus
    // is on any earlier value, not just the immediately preceding one.
    const reads = scripted(u8(1, 2, 3), u8(9, 9, 9), u8(1, 2, 3));
    const { data, outcome } = await readBankWithConsensus({
      read: reads.read,
      label: "bank 2",
      log: () => {},
    });
    expect(outcome).toBe("retried");
    expect(Array.from(data)).toEqual([1, 2, 3]);
    expect(reads.calls()).toBe(3);
  });

  it("gives up after maxAttempts and accepts the last read ('unresolved')", async () => {
    const reads = scripted(u8(1), u8(2), u8(3), u8(4));
    const logs: string[] = [];
    const { data, outcome } = await readBankWithConsensus({
      read: reads.read,
      label: "bank 3",
      maxAttempts: 4,
      log: (m) => logs.push(m),
    });
    expect(outcome).toBe("unresolved");
    expect(Array.from(data)).toEqual([4]);
    expect(reads.calls()).toBe(4);
    expect(logs.some((m) => m.includes("never agreed"))).toBe(true);
  });
});
