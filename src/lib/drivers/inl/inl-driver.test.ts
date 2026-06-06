import { describe, it, expect } from "vitest";
import type { InlTransport } from "./inl-transport";
import { INLDriver } from "./inl-driver";
import { BUFFER, IO, OPER, STATUS } from "./inl-opcodes";

/**
 * Driver-level coverage of the readROM/readSave exit invariant: every exit —
 * clean or mid-dump fault — must leave the dump-operation engine reset
 * (SET_OPERATION RESET + RAW_BUFFER_RESET, from dumpRegion's finally) and
 * then reset the I/O layer (IO_RESET, from the driver's finally), so the
 * next dump can't inherit engine or bus state.
 */

interface Call {
  m: "io" | "nes" | "operation" | "buffer" | "payloadIn";
  op?: number;
  operand?: number;
}

class FakeInlDevice {
  calls: Call[] = [];
  private payloadCalls = 0;
  private readonly failOnPayloadCall?: number;

  constructor(failOnPayloadCall?: number) {
    this.failOnPayloadCall = failOnPayloadCall;
  }

  async io(op: number, operand = 0): Promise<null> {
    this.calls.push({ m: "io", op, operand });
    return null;
  }
  async nes(op: number, operand = 0): Promise<number> {
    this.calls.push({ m: "nes", op, operand });
    return 0;
  }
  async operation(op: number, operand = 0): Promise<number> {
    this.calls.push({ m: "operation", op, operand });
    return 0;
  }
  async buffer(op: number, operand = 0): Promise<number> {
    this.calls.push({ m: "buffer", op, operand });
    return op === BUFFER.GET_CUR_BUFF_STATUS ? STATUS.DUMPED : 0;
  }
  async payloadIn(len = 128): Promise<Uint8Array> {
    this.calls.push({ m: "payloadIn" });
    this.payloadCalls += 1;
    if (this.failOnPayloadCall === this.payloadCalls) {
      throw new Error("simulated device fault mid-dump");
    }
    return new Uint8Array(len);
  }
}

function makeDriver(fake: FakeInlDevice): INLDriver {
  return new INLDriver({ device: fake } as unknown as InlTransport);
}

/** The exit invariant: engine reset pair, then I/O reset, last. */
function expectTeardownTail(calls: Call[]): void {
  const tail = calls.slice(-3);
  expect(tail.map((c) => [c.m, c.op, c.operand])).toEqual([
    ["operation", OPER.SET_OPERATION, STATUS.RESET],
    ["buffer", BUFFER.RAW_BUFFER_RESET, 0],
    ["io", IO.IO_RESET, 0],
  ]);
}

const ROM_CONFIG = {
  systemId: "nes",
  params: { mapper: 0, prgSizeBytes: 32768, chrSizeBytes: 8192 },
};

const SAVE_CONFIG = {
  systemId: "nes",
  params: { mapper: 0, prgRamSizeBytes: 8192 },
};

describe("INLDriver teardown", () => {
  it("readROM ends with the engine reset and I/O reset on a clean dump", async () => {
    const fake = new FakeInlDevice();
    const driver = makeDriver(fake);

    const data = await driver.readROM(ROM_CONFIG);

    expect(data.length).toBe(40960); // 32K PRG + 8K CHR
    expectTeardownTail(fake.calls);
  });

  it("readROM still tears down when the dump faults mid-region", async () => {
    const fake = new FakeInlDevice(10); // mid-PRG
    const driver = makeDriver(fake);

    await expect(driver.readROM(ROM_CONFIG)).rejects.toThrow(
      "simulated device fault",
    );
    expectTeardownTail(fake.calls);
  });

  it("readSave (default path) ends with the engine reset and I/O reset", async () => {
    const fake = new FakeInlDevice();
    const driver = makeDriver(fake);

    const data = await driver.readSave(SAVE_CONFIG);

    expect(data.length).toBe(8192);
    expectTeardownTail(fake.calls);
  });

  it("readSave still tears down when the dump faults mid-region", async () => {
    const fake = new FakeInlDevice(3);
    const driver = makeDriver(fake);

    await expect(driver.readSave(SAVE_CONFIG)).rejects.toThrow(
      "simulated device fault",
    );
    expectTeardownTail(fake.calls);
  });
});
