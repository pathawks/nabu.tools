import { describe, it, expect } from "vitest";
import type { InlTransport } from "./inl-transport";
import { INLDriver } from "./inl-driver";
import { BUFFER, IO, OPER, PINPORT, STATUS } from "./inl-opcodes";
import {
  M2_IDLE_GATED_MAPPERS,
  unsupportedMappersFor,
} from "./unsupported-mappers";

/**
 * Driver-level coverage of:
 *  - the readROM/readSave exit invariant: every exit — clean or mid-dump
 *    fault — must leave the dump-operation engine reset (SET_OPERATION
 *    RESET + RAW_BUFFER_RESET, from dumpRegion's finally) and then reset
 *    the I/O layer (IO_RESET, from the driver's finally), so the next dump
 *    can't inherit engine or bus state;
 *  - the M2-idle-high firmware feature gate: initialize() probes the M2
 *    pin level once after NES init and gates the SMD172-family CPLD
 *    mappers (see ./unsupported-mappers) on the result.
 */

interface Call {
  m: "io" | "nes" | "operation" | "buffer" | "payloadIn" | "pinport";
  op?: number;
  operand?: number;
}

class FakeInlDevice {
  calls: Call[] = [];
  /** M2 pin level the CTL_RD probe reads back; "error" makes it throw. */
  m2Level: number | "error" = 0;
  private payloadCalls = 0;
  private readonly failOnPayloadCall?: number;

  constructor(failOnPayloadCall?: number) {
    this.failOnPayloadCall = failOnPayloadCall;
  }

  async io(op: number, operand = 0): Promise<null> {
    this.calls.push({ m: "io", op, operand });
    return null;
  }
  async pinport(op: number, operand = 0): Promise<number> {
    this.calls.push({ m: "pinport", op, operand });
    if (op === PINPORT.CTL_RD && operand === PINPORT.M2) {
      if (this.m2Level === "error") throw new Error("Device error 0xff");
      return this.m2Level;
    }
    return 0;
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

  it.each([
    [268, 2048], // CPLD needs M2 idling high; stock firmware idles it low
    [470, 1024], // same board family (see M2_IDLE_GATED_MAPPERS)
  ])(
    "pre-flight-rejects mapper %i on stock (M2-low) firmware without touching the cart",
    async (mapper, prgKB) => {
      // The driver must reject before any cart traffic rather than
      // produce a boot-bank-mirrored garbage dump.
      const fake = new FakeInlDevice(); // m2Level = 0 → stock firmware
      const driver = makeDriver(fake);
      await driver.initialize();
      fake.calls = [];

      await expect(
        driver.readROM({
          systemId: "nes",
          params: { mapper, prgSizeBytes: prgKB * 1024, chrSizeBytes: 0 },
        }),
      ).rejects.toThrow(/INL Retro/);
      expect(fake.calls).toHaveLength(0);
    },
  );

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

/**
 * The M2-idle-high firmware feature gate. initialize() probes the M2 pin
 * level once, right after NES init (PINPORT CTL_RD, operand M2): low =
 * stock firmware → the SMD172-family CPLD mappers stay gated; high =
 * m2-idle-high firmware → fully enabled; probe error = treated as stock.
 */
describe("INLDriver M2-idle-high feature gate", () => {
  const gatedIds = [...M2_IDLE_GATED_MAPPERS.keys()];
  // Effective unsupported list = the always-unsupported mappers (e.g. 413,
  // gated on a firmware feature the M2 probe never lifts) plus the M2-gated
  // ones on stock firmware only.
  const stockUnsupported = [...unsupportedMappersFor(false).keys()];
  const highUnsupported = [...unsupportedMappersFor(true).keys()];

  it("probes the M2 pin exactly once, after NES init", async () => {
    const fake = new FakeInlDevice();
    const driver = makeDriver(fake);

    await driver.initialize();

    expect(fake.calls).toEqual([
      { m: "io", op: IO.IO_RESET, operand: 0 },
      { m: "io", op: IO.NES_INIT, operand: 0 },
      { m: "pinport", op: PINPORT.CTL_RD, operand: PINPORT.M2 },
    ]);
  });

  it("keeps the gated mappers unsupported when M2 reads low (stock firmware)", async () => {
    const fake = new FakeInlDevice();
    fake.m2Level = 0;
    const driver = makeDriver(fake);

    await driver.initialize();

    expect(driver.m2IdleHigh).toBe(false);
    expect(driver.capabilities[0].unsupportedMappers).toEqual(stockUnsupported);
  });

  it("enables the gated mappers when M2 reads high (m2-idle-high firmware)", async () => {
    const fake = new FakeInlDevice();
    fake.m2Level = 1;
    const driver = makeDriver(fake);

    await driver.initialize();

    expect(driver.m2IdleHigh).toBe(true);
    // The M2-gated mappers are lifted; only the always-unsupported ones (413)
    // remain — an M2-idle-high firmware does not address its missing memtype.
    expect(driver.capabilities[0].unsupportedMappers).toEqual(highUnsupported);
    for (const id of gatedIds) {
      expect(driver.capabilities[0].unsupportedMappers).not.toContain(id);
    }

    // A formerly-gated mapper now dumps end to end (one 16 KiB outer bank).
    const data = await driver.readROM({
      systemId: "nes",
      params: { mapper: 268, prgSizeBytes: 16384, chrSizeBytes: 0 },
    });
    expect(data.length).toBe(16384);
  });

  it("treats a probe error as stock firmware (gate stays closed)", async () => {
    const fake = new FakeInlDevice();
    fake.m2Level = "error";
    const driver = makeDriver(fake);

    await driver.initialize(); // must not throw

    expect(driver.m2IdleHigh).toBe(false);
    expect(driver.capabilities[0].unsupportedMappers).toEqual(stockUnsupported);
  });

  it("gates the mappers before initialize() has probed (stock-equivalent default)", async () => {
    const fake = new FakeInlDevice();
    const driver = makeDriver(fake);

    expect(driver.m2IdleHigh).toBe(false);
    expect(driver.capabilities[0].unsupportedMappers).toEqual(stockUnsupported);
    await expect(
      driver.readROM({
        systemId: "nes",
        params: { mapper: 268, prgSizeBytes: 16384, chrSizeBytes: 0 },
      }),
    ).rejects.toThrow(/INL Retro/);
    expect(fake.calls).toHaveLength(0);
  });
});
