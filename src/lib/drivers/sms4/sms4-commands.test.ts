import { describe, it, expect } from "vitest";
import {
  buildCartPacket,
  buildSaveReadPacket,
  ntrGetChipId,
  ntrReadHeader,
  NTR_CMD,
  PACKET_LEN,
  PACKET_OPCODE,
  SUBCMD,
} from "./sms4-commands";

describe("buildCartPacket", () => {
  it("produces a 32-byte packet", () => {
    const pkt = buildCartPacket({
      ntrCmd: ntrReadHeader(),
      responseLen: 0x200,
    });
    expect(pkt.length).toBe(PACKET_LEN);
    expect(PACKET_LEN).toBe(32);
  });

  it("leads with opcode 0x60 0xA5", () => {
    const pkt = buildCartPacket({
      ntrCmd: ntrReadHeader(),
      responseLen: 0,
    });
    expect(pkt[0]).toBe(PACKET_OPCODE[0]);
    expect(pkt[1]).toBe(PACKET_OPCODE[1]);
    expect(pkt[0]).toBe(0x60);
    expect(pkt[1]).toBe(0xa5);
  });

  it("encodes responseLen at bytes 6..9 LE", () => {
    const pkt = buildCartPacket({
      ntrCmd: ntrReadHeader(),
      responseLen: 0x12345678,
    });
    expect(pkt[6]).toBe(0x78);
    expect(pkt[7]).toBe(0x56);
    expect(pkt[8]).toBe(0x34);
    expect(pkt[9]).toBe(0x12);
  });

  it("encodes extra (optional offset) at bytes 2..5 LE; defaults to 0", () => {
    const def = buildCartPacket({
      ntrCmd: ntrReadHeader(),
      responseLen: 0,
    });
    expect([def[2], def[3], def[4], def[5]]).toEqual([0, 0, 0, 0]);

    const set = buildCartPacket({
      ntrCmd: ntrReadHeader(),
      responseLen: 0,
      extra: 0xdeadbeef,
    });
    expect(set[2]).toBe(0xef);
    expect(set[3]).toBe(0xbe);
    expect(set[4]).toBe(0xad);
    expect(set[5]).toBe(0xde);
  });

  it("places the NTR command at bytes 11..18 (big-endian on-the-wire)", () => {
    const cmd = new Uint8Array([0x90, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    const pkt = buildCartPacket({ ntrCmd: cmd, responseLen: 0 });
    expect(Array.from(pkt.subarray(11, 19))).toEqual(Array.from(cmd));
  });

  it("places SUBCMD at byte 19 — defaults to NORMAL, accepts RESET", () => {
    const def = buildCartPacket({
      ntrCmd: ntrReadHeader(),
      responseLen: 0,
    });
    expect(def[19]).toBe(SUBCMD.NORMAL);
    expect(def[19]).toBe(0);

    const reset = buildCartPacket({
      ntrCmd: new Uint8Array(8),
      responseLen: 0,
      subcmd: SUBCMD.RESET,
    });
    expect(reset[19]).toBe(SUBCMD.RESET);
    expect(reset[19]).toBe(0xf0);
  });

  it("clears the mode-flag byte at index 10 and zero-pads bytes 20..31", () => {
    const pkt = buildCartPacket({
      ntrCmd: new Uint8Array(8),
      responseLen: 0,
    });
    expect(pkt[10]).toBe(0);
    for (let i = 20; i < PACKET_LEN; i++) {
      expect(pkt[i]).toBe(0);
    }
  });

  it("rejects an ntrCmd that isn't exactly 8 bytes", () => {
    expect(() =>
      buildCartPacket({ ntrCmd: new Uint8Array(7), responseLen: 0 }),
    ).toThrow();
    expect(() =>
      buildCartPacket({ ntrCmd: new Uint8Array(9), responseLen: 0 }),
    ).toThrow();
  });
});

describe("ntrReadHeader / ntrGetChipId", () => {
  it("ntrReadHeader returns 8 zero bytes (opcode 0x00 + 7 zeros)", () => {
    const c = ntrReadHeader();
    expect(c.length).toBe(8);
    expect(Array.from(c)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("ntrGetChipId places the chip-id opcode (0x90) at byte 0, rest zero", () => {
    const c = ntrGetChipId();
    expect(c.length).toBe(8);
    expect(c[0]).toBe(NTR_CMD.GET_CHIP_ID);
    expect(c[0]).toBe(0x90);
    expect(Array.from(c.subarray(1))).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("buildSaveReadPacket", () => {
  const cmdTable: readonly number[] = [
    0x01, 0x03, 0xff, 0x00, 0xff, 0xff, 0x00, 0x06, 0x03, 0x05, 0x06, 0x01,
    0x02, 0xc7,
  ];

  it("produces a 32-byte packet leading with 0x60 0xA2", () => {
    const pkt = buildSaveReadPacket({
      cmdTable,
      flag: 0x07,
      address: 0,
      length: 256,
    });
    expect(pkt.length).toBe(PACKET_LEN);
    expect(pkt[0]).toBe(0x60);
    expect(pkt[1]).toBe(0xa2);
  });

  it("encodes address at bytes 2..5 LE", () => {
    const pkt = buildSaveReadPacket({
      cmdTable,
      flag: 0x07,
      address: 0x000123ab,
      length: 16,
    });
    expect(pkt[2]).toBe(0xab);
    expect(pkt[3]).toBe(0x23);
    expect(pkt[4]).toBe(0x01);
    expect(pkt[5]).toBe(0x00);
  });

  it("encodes length at bytes 6..9 LE", () => {
    const pkt = buildSaveReadPacket({
      cmdTable,
      flag: 0x07,
      address: 0,
      length: 0xffff,
    });
    expect(pkt[6]).toBe(0xff);
    expect(pkt[7]).toBe(0xff);
    expect(pkt[8]).toBe(0x00);
    expect(pkt[9]).toBe(0x00);
  });

  it("places the flag byte at index 10", () => {
    const a = buildSaveReadPacket({
      cmdTable,
      flag: 0x07,
      address: 0,
      length: 16,
    });
    expect(a[10]).toBe(0x07);

    const b = buildSaveReadPacket({
      cmdTable,
      flag: 0x0f,
      address: 0,
      length: 16,
    });
    expect(b[10]).toBe(0x0f);
  });

  it("copies cmdTable[1..13] to packet bytes 11..23", () => {
    const pkt = buildSaveReadPacket({
      cmdTable,
      flag: 0x07,
      address: 0,
      length: 16,
    });
    for (let i = 1; i < 14; i++) {
      expect(pkt[10 + i]).toBe(cmdTable[i]);
    }
  });

  it("zero-pads bytes 24..31", () => {
    const pkt = buildSaveReadPacket({
      cmdTable,
      flag: 0x07,
      address: 0,
      length: 16,
    });
    for (let i = 24; i < PACKET_LEN; i++) {
      expect(pkt[i]).toBe(0);
    }
  });

  it("rejects a cmdTable that isn't exactly 14 bytes", () => {
    expect(() =>
      buildSaveReadPacket({
        cmdTable: cmdTable.slice(0, 13),
        flag: 0x07,
        address: 0,
        length: 16,
      }),
    ).toThrow();
    expect(() =>
      buildSaveReadPacket({
        cmdTable: [...cmdTable, 0x00],
        flag: 0x07,
        address: 0,
        length: 16,
      }),
    ).toThrow();
  });
});
