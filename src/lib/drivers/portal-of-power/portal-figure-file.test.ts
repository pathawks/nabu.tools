import { describe, it, expect } from "vitest";
import {
  figureFilename,
  isFullDump,
  parseFigureIdentity,
} from "./portal-figure-file";

/** A 1024-byte dump with known plaintext block 0 / block 1 fields. */
function mkDump(): Uint8Array {
  const data = new Uint8Array(1024);
  data.set([0x1a, 0x2b, 0x3c, 0x4d], 0); // NUID, block 0
  data[16 + 0x00] = 0x34; // figure_id LE low
  data[16 + 0x01] = 0x12; // figure_id LE high  -> 0x1234
  data[16 + 0x0c] = 0x05; // variant_id LE low
  data[16 + 0x0d] = 0x00; // variant_id LE high -> 0x0005
  return data;
}

describe("parseFigureIdentity", () => {
  it("extracts the NUID and the LE figure/variant ids", () => {
    const id = parseFigureIdentity(mkDump());
    expect(Array.from(id.nuid)).toEqual([0x1a, 0x2b, 0x3c, 0x4d]);
    expect(id.nuidHex).toBe("1A2B3C4D");
    expect(id.figureId).toBe(0x1234);
    expect(id.variantId).toBe(0x0005);
  });

  it("rejects a dump too short to hold blocks 0 and 1", () => {
    expect(() => parseFigureIdentity(new Uint8Array(16))).toThrow();
  });
});

describe("isFullDump", () => {
  it("is true only for a full 1024-byte MIFARE 1K dump", () => {
    expect(isFullDump(new Uint8Array(1024))).toBe(true);
    expect(isFullDump(new Uint8Array(1023))).toBe(false);
  });
});

describe("figureFilename", () => {
  it("names the file by NUID with a .bin extension", () => {
    const name = figureFilename(parseFigureIdentity(mkDump()));
    expect(name.startsWith("Skylanders - 1A2B3C4D - ")).toBe(true);
    expect(name.endsWith(".bin")).toBe(true);
  });
});
