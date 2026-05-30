import { describe, it, expect } from "vitest";
import { findWriteGate } from "./bus-conflict";

const u8 = (...b: number[]) => Uint8Array.from(b);

describe("findWriteGate", () => {
  it("matches any value against a 0xFF byte", () => {
    const bank = u8(0x00, 0x12, 0xff, 0x34);
    expect(findWriteGate(bank, 0x30)).toBe(2);
  });

  it("treats value 0 as passing through any byte", () => {
    expect(findWriteGate(u8(0x00, 0x12), 0x00)).toBe(0);
  });

  it("accepts a byte that is a superset of the value's bits", () => {
    // 0x30 needs bits 4 and 5 set; 0x3a (0b0011_1010) has them.
    expect(findWriteGate(u8(0x10, 0x20, 0x3a), 0x30)).toBe(2);
  });

  it("rejects bytes missing any of the value's bits", () => {
    // No byte has both bit 4 and bit 5 set, so 0x30 can't pass.
    expect(findWriteGate(u8(0x10, 0x20, 0x0f), 0x30)).toBe(-1);
  });

  it("returns -1 on an empty bank", () => {
    expect(findWriteGate(u8(), 0x10)).toBe(-1);
  });
});
