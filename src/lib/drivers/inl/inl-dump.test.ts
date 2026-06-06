import { describe, it, expect } from "vitest";
import type { INLDevice } from "./inl-device";
import { dumpRegion } from "./inl-dump";
import { BUFFER, MEM, OPER, STATUS, MAPVAR } from "./inl-opcodes";

/**
 * Records every operation/buffer call against a stand-in INLDevice so a test
 * can assert that the dump-operation engine is reset on both the normal and
 * the abnormal (throwing) exit paths — the byte-shift recovery the fix adds.
 *
 * `failOnPayloadCall` (1-based) makes the Nth payloadIn throw, simulating a
 * device fault landing mid-region. The `onPayloadCall`/`onStatusPoll` hooks
 * let a test abort a signal at a precise point in the protocol.
 */
interface FakeOpts {
  failOnPayloadCall?: number;
  /** Called at the start of every payloadIn with the 1-based call number. */
  onPayloadCall?: (n: number) => void;
  /**
   * When set, GET_CUR_BUFF_STATUS never reports DUMPED (a stalled device);
   * called with the 1-based poll number so a test can abort mid-poll.
   */
  onStatusPoll?: (n: number) => void;
}

interface OpCall {
  kind: "operation" | "buffer";
  opcode: number;
  operand: number;
  misc: number;
}

function makeFakeDevice(opts: FakeOpts = {}) {
  const calls: OpCall[] = [];
  let payloadCalls = 0;
  let statusPolls = 0;

  const device = {
    async operation(opcode: number, operand = 0): Promise<number> {
      calls.push({ kind: "operation", opcode, operand, misc: 0 });
      return 0;
    },
    async buffer(opcode: number, operand = 0, misc = 0): Promise<number> {
      calls.push({ kind: "buffer", opcode, operand, misc });
      // The dump loop polls GET_CUR_BUFF_STATUS and expects DUMPED.
      if (opcode === BUFFER.GET_CUR_BUFF_STATUS) {
        if (opts.onStatusPoll) {
          opts.onStatusPoll(++statusPolls);
          return 0; // stalled device: never DUMPED
        }
        return STATUS.DUMPED;
      }
      return 0;
    },
    async payloadIn(length = 128): Promise<Uint8Array> {
      payloadCalls += 1;
      opts.onPayloadCall?.(payloadCalls);
      if (opts.failOnPayloadCall === payloadCalls) {
        throw new Error("simulated device fault mid-region");
      }
      return new Uint8Array(length);
    },
  } as unknown as INLDevice;

  return { device, calls };
}

/** Count how many times the operation engine was reset (SET_OPERATION RESET). */
function countEngineResets(calls: OpCall[]): number {
  return calls.filter(
    (c) =>
      c.kind === "operation" &&
      c.opcode === OPER.SET_OPERATION &&
      c.operand === STATUS.RESET,
  ).length;
}

/** Count RAW_BUFFER_RESET buffer commands. */
function countBufferResets(calls: OpCall[]): number {
  return calls.filter(
    (c) => c.kind === "buffer" && c.opcode === BUFFER.RAW_BUFFER_RESET,
  ).length;
}

const REGION = {
  sizeKB: 1, // 1 KiB = 8 x 128-byte chunks
  memType: MEM.NESCPU_4KB,
  mapper: 0x08,
  mapVar: MAPVAR.NOVAR,
};

describe("dumpRegion operation-engine reset", () => {
  it("resets the engine at both start and end on a clean dump", async () => {
    const { device, calls } = makeFakeDevice();

    const data = await dumpRegion(device, REGION);

    expect(data.length).toBe(1024);
    // Leading reset + trailing finally reset.
    expect(countEngineResets(calls)).toBe(2);
    expect(countBufferResets(calls)).toBe(2);
    // STARTDUMP must come AFTER the first reset and BEFORE the last.
    const startIdx = calls.findIndex(
      (c) =>
        c.kind === "operation" &&
        c.opcode === OPER.SET_OPERATION &&
        c.operand === STATUS.STARTDUMP,
    );
    const lastResetIdx = calls.reduce(
      (acc, c, i) =>
        c.kind === "operation" &&
        c.opcode === OPER.SET_OPERATION &&
        c.operand === STATUS.RESET
          ? i
          : acc,
      -1,
    );
    expect(startIdx).toBeGreaterThan(0);
    expect(lastResetIdx).toBeGreaterThan(startIdx);
  });

  it("still resets the engine when a payload read throws mid-region", async () => {
    // Fail on the 3rd of 8 payload reads — squarely mid-loop.
    const { device, calls } = makeFakeDevice({ failOnPayloadCall: 3 });

    await expect(dumpRegion(device, REGION)).rejects.toThrow(
      "simulated device fault",
    );

    // Leading reset always runs; the finally reset must also run despite the
    // throw, so the firmware isn't left mid-region for the NEXT dump.
    expect(countEngineResets(calls)).toBe(2);
    expect(countBufferResets(calls)).toBe(2);
    // The very last engine touch is a RESET, not a dangling STARTDUMP.
    const lastOp = calls
      .filter(
        (c) => c.kind === "operation" && c.opcode === OPER.SET_OPERATION,
      )
      .at(-1);
    expect(lastOp?.operand).toBe(STATUS.RESET);
  });

  it("resets the engine when the very first payload read throws", async () => {
    // The short-read desync guard lives in the real INLDevice.payloadIn
    // (covered by inl-device.test.ts); dumpRegion sees its symptom — a
    // throw — which here lands before any chunk was assembled.
    const { device, calls } = makeFakeDevice({ failOnPayloadCall: 1 });

    await expect(dumpRegion(device, REGION)).rejects.toThrow();
    expect(countEngineResets(calls)).toBe(2);
  });

  it("an abort interrupts a stalled DUMPED poll before the timeout", async () => {
    const controller = new AbortController();
    const { device, calls } = makeFakeDevice({
      // Device never reports DUMPED; abort on the 3rd status poll. The
      // in-poll signal check must surface AbortError well before the 5s
      // stall timeout (which would reject with the stall Error instead).
      onStatusPoll: (n) => {
        if (n === 3) controller.abort();
      },
    });

    await expect(
      dumpRegion(device, { ...REGION, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(countEngineResets(calls)).toBe(2);
    expect(countBufferResets(calls)).toBe(2);
  });

  it("an abort signal interrupts within a chunk and still resets the engine", async () => {
    const controller = new AbortController();
    const { device, calls } = makeFakeDevice({
      // Abort while the 3rd of 8 chunks is in flight; the per-chunk
      // throwIfAborted must stop the loop before chunk 4 is requested.
      onPayloadCall: (n) => {
        if (n === 3) controller.abort();
      },
    });

    await expect(
      dumpRegion(device, { ...REGION, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // No further payload pulls after the abort landed...
    const payloadPulls = calls.filter(
      (c) => c.kind === "buffer" && c.opcode === BUFFER.GET_CUR_BUFF_STATUS,
    ).length;
    expect(payloadPulls).toBeLessThanOrEqual(4);
    // ...and the engine still returns to idle on the way out.
    expect(countEngineResets(calls)).toBe(2);
    expect(countBufferResets(calls)).toBe(2);
  });
});
