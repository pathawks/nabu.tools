import { describe, it, expect } from "vitest";
import {
  decodeStatus,
  diffStatus,
  slotToIdx,
  SlotState,
  type StatusReport,
} from "./portal-commands";

function mkStatus(states: Record<number, SlotState>): StatusReport {
  const slots: SlotState[] = new Array(16).fill(SlotState.EMPTY);
  for (const [k, v] of Object.entries(states)) slots[Number(k)] = v;
  return { slots, counter: 0, activated: true };
}

describe("slotToIdx", () => {
  it("ORs the slot into the high-nibble-1 wire form", () => {
    expect(slotToIdx(0)).toBe(0x10);
    expect(slotToIdx(5)).toBe(0x15);
    expect(slotToIdx(15)).toBe(0x1f);
  });
});

describe("decodeStatus", () => {
  it("unpacks the 2-bits-per-slot bitmap, counter, and activated flag", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0x53;
    bytes[1] = 0b0000_0111; // slot 0 = ADDED (11), slot 1 = PRESENT (01)
    bytes[5] = 5;
    bytes[6] = 1;
    const status = decodeStatus(bytes);
    expect(status.slots).toHaveLength(16);
    expect(status.slots[0]).toBe(SlotState.ADDED);
    expect(status.slots[1]).toBe(SlotState.PRESENT);
    expect(status.slots[2]).toBe(SlotState.EMPTY);
    expect(status.counter).toBe(5);
    expect(status.activated).toBe(true);
  });

  it("reads slot 15 from the top two bits without sign-extension corruption", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0x53;
    bytes[4] = 0b1100_0000; // slot 15 occupies bits 30..31 of the u32
    const status = decodeStatus(bytes);
    expect(status.slots[15]).toBe(SlotState.ADDED);
    expect(status.activated).toBe(false);
  });
});

describe("diffStatus", () => {
  it("treats a null prior as 'every occupied slot was just added'", () => {
    const next = mkStatus({ 0: SlotState.PRESENT, 3: SlotState.ADDED });
    expect(diffStatus(null, next)).toEqual([
      { slot: 0, kind: "added" },
      { slot: 3, kind: "added" },
    ]);
  });

  it("emits a removal when an occupied slot empties", () => {
    const prev = mkStatus({ 2: SlotState.PRESENT });
    const next = mkStatus({});
    expect(diffStatus(prev, next)).toEqual([{ slot: 2, kind: "removed" }]);
  });

  it("treats PRESENT and ADDED as the same occupied state — no spurious event", () => {
    const prev = mkStatus({ 1: SlotState.ADDED });
    const next = mkStatus({ 1: SlotState.PRESENT });
    expect(diffStatus(prev, next)).toEqual([]);
  });
});
