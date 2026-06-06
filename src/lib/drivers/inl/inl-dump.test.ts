import { describe, it, expect } from "vitest";
import type { INLDevice } from "./inl-device";
import { dumpRegion } from "./inl-dump";
import { BUFFER, MEM, OPER, PART, STATUS, MAPVAR } from "./inl-opcodes";

/**
 * Records every control-transfer the dump engine issues so a test can assert
 * the exact wire sequence (the off-by-one firewall for the buffer layout), and
 * serves payload bytes + buffer-status replies the way the firmware would.
 *
 * Fault knobs: `failOnPayloadCall` (1-based) makes the Nth payloadIn throw,
 * simulating a device fault landing mid-region. The `onPayloadCall` /
 * `onStatusPoll` hooks let a test abort a signal at a precise point in the
 * protocol; setting `onStatusPoll` also makes GET_CUR_BUFF_STATUS never
 * report DUMPED (a stalled device).
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

interface Call {
  m: "io" | "nes" | "operation" | "buffer" | "payloadIn";
  op?: number;
  operand?: number;
  misc?: number;
  len?: number;
}

class FakeInlDevice {
  calls: Call[] = [];
  /** Number of DUMPING replies before each DUMPED (poll-spin simulation). */
  dumpingBeforeReady = 0;
  private dumpingLeft = 0;
  private rx: number[] = [];
  private payloadCalls = 0;
  private statusPolls = 0;
  private readonly opts: FakeOpts;

  constructor(opts: FakeOpts = {}) {
    this.opts = opts;
  }

  /** Queue bytes the firmware would stream back through BUFF_PAYLOAD. */
  queue(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.rx.push(bytes[i]);
  }

  setDumpingBeforeReady(n: number): void {
    this.dumpingBeforeReady = n;
    this.dumpingLeft = n;
  }

  async io(op: number, operand = 0): Promise<null> {
    this.calls.push({ m: "io", op, operand });
    return null;
  }

  async nes(op: number, operand = 0, misc = 0): Promise<number> {
    this.calls.push({ m: "nes", op, operand, misc });
    return 0;
  }

  async operation(op: number, operand = 0): Promise<number> {
    this.calls.push({ m: "operation", op, operand });
    return 0;
  }

  async buffer(op: number, operand = 0, misc = 0): Promise<number> {
    this.calls.push({ m: "buffer", op, operand, misc });
    if (op === BUFFER.GET_CUR_BUFF_STATUS) {
      if (this.opts.onStatusPoll) {
        this.opts.onStatusPoll(++this.statusPolls);
        return 0; // stalled device: never DUMPED
      }
      if (this.dumpingLeft > 0) {
        this.dumpingLeft--;
        return STATUS.DUMPING;
      }
      this.dumpingLeft = this.dumpingBeforeReady;
      return STATUS.DUMPED;
    }
    return 0;
  }

  async payloadIn(len = 128): Promise<Uint8Array> {
    this.calls.push({ m: "payloadIn", len });
    this.payloadCalls += 1;
    this.opts.onPayloadCall?.(this.payloadCalls);
    if (this.opts.failOnPayloadCall === this.payloadCalls) {
      throw new Error("simulated device fault mid-region");
    }
    if (this.rx.length < len) return new Uint8Array(len); // sequence-only tests
    return new Uint8Array(this.rx.splice(0, len));
  }

  // ─── assertion helpers ───────────────────────────────────────────────────
  buffers(op: number): Call[] {
    return this.calls.filter((c) => c.m === "buffer" && c.op === op);
  }
  ops(operand: number): Call[] {
    return this.calls.filter(
      (c) =>
        c.m === "operation" &&
        c.op === OPER.SET_OPERATION &&
        c.operand === operand,
    );
  }
  /** The ordered control-transfer sequence, dropping payload reads. */
  wire(): Call[] {
    return this.calls.filter((c) => c.m === "operation" || c.m === "buffer");
  }
  statusPollCount(): number {
    return this.buffers(BUFFER.GET_CUR_BUFF_STATUS).length;
  }
}

function asDevice(fake: FakeInlDevice): INLDevice {
  return fake as unknown as INLDevice;
}

/** Deterministic, well-mixed image so every byte position is distinct. */
function makeImage(bytes: number): Uint8Array {
  const a = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++)
    a[i] = (Math.imul(i, 2654435761) >>> 24) & 0xff;
  return a;
}

const REGION = {
  sizeKB: 1, // 1 KiB = 8 x 128-byte chunks
  memType: MEM.NESCPU_4KB,
  mapper: 0x08,
  mapVar: MAPVAR.NOVAR,
};

describe("dumpRegion wire protocol", () => {
  it("emits the exact 2x128B reset/allocate/config/STARTDUMP sequence", async () => {
    const fake = new FakeInlDevice();

    await dumpRegion(asDevice(fake), REGION);

    const memPart = (MEM.NESCPU_4KB << 8) | PART.MASKROM;
    const mapVar = (0x08 << 8) | MAPVAR.NOVAR;
    expect(fake.wire().slice(0, 11)).toEqual([
      { m: "operation", op: OPER.SET_OPERATION, operand: STATUS.RESET },
      { m: "buffer", op: BUFFER.RAW_BUFFER_RESET, operand: 0, misc: 0 },
      // allocate: operand = (id<<8)|basebank, misc = num_banks (128/32 = 4)
      { m: "buffer", op: BUFFER.ALLOCATE_BUFFER0, operand: 0x0000, misc: 4 },
      { m: "buffer", op: BUFFER.ALLOCATE_BUFFER1, operand: 0x8004, misc: 4 },
      // 0x90/0x91 SET_RELOAD_PAGENUM: operand = firstpage, misc = reload
      { m: "buffer", op: 0x90, operand: 0, misc: 1 },
      { m: "buffer", op: 0x91, operand: 0, misc: 1 },
      // per-buffer mem/part then map/mapvar, selected by misc = buffer index
      { m: "buffer", op: BUFFER.SET_MEM_N_PART, operand: memPart, misc: 0 },
      { m: "buffer", op: BUFFER.SET_MEM_N_PART, operand: memPart, misc: 1 },
      { m: "buffer", op: BUFFER.SET_MAP_N_MAPVAR, operand: mapVar, misc: 0 },
      { m: "buffer", op: BUFFER.SET_MAP_N_MAPVAR, operand: mapVar, misc: 1 },
      { m: "operation", op: OPER.SET_OPERATION, operand: STATUS.STARTDUMP },
    ]);
    // ...and ends by tearing the allocation down.
    expect(fake.wire().slice(-2)).toEqual([
      { m: "operation", op: OPER.SET_OPERATION, operand: STATUS.RESET },
      { m: "buffer", op: BUFFER.RAW_BUFFER_RESET, operand: 0, misc: 0 },
    ]);
  });

  it("drives SRAM regions through the SRAM part", async () => {
    const fake = new FakeInlDevice();
    await dumpRegion(asDevice(fake), {
      sizeKB: 8,
      memType: MEM.PRGRAM,
      mapper: 0,
      mapVar: MAPVAR.NOVAR,
    });
    const memPart = (MEM.PRGRAM << 8) | PART.SRAM;
    expect(fake.buffers(BUFFER.SET_MEM_N_PART).map((c) => c.operand)).toEqual([
      memPart,
      memPart,
    ]);
  });

  it("reassembles the region byte-exact, one 128B payload per chunk", async () => {
    const fake = new FakeInlDevice();
    const image = makeImage(8 * 1024);
    fake.queue(image);

    const out = await dumpRegion(asDevice(fake), { ...REGION, sizeKB: 8 });

    expect(out).toEqual(image);
    const payloads = fake.calls.filter((c) => c.m === "payloadIn");
    expect(payloads).toHaveLength((8 * 1024) / 128); // 64 chunks
    expect(payloads.every((c) => c.len === 128)).toBe(true);
  });

  it("tolerates DUMPING replies before DUMPED without losing bytes", async () => {
    const fake = new FakeInlDevice();
    fake.setDumpingBeforeReady(2);
    const image = makeImage(1024);
    fake.queue(image);

    const out = await dumpRegion(asDevice(fake), REGION);

    expect(out).toEqual(image);
    const chunks = 1024 / 128; // 8
    // each chunk: 2 DUMPING + 1 DUMPED status polls
    expect(fake.statusPollCount()).toBe(chunks * 3);
  });
});

describe("dumpRegion operation-engine reset", () => {
  it("resets the engine at both start and end on a clean dump", async () => {
    const fake = new FakeInlDevice();

    const data = await dumpRegion(asDevice(fake), REGION);

    expect(data.length).toBe(1024);
    // Leading reset + trailing finally reset.
    expect(fake.ops(STATUS.RESET)).toHaveLength(2);
    expect(fake.buffers(BUFFER.RAW_BUFFER_RESET)).toHaveLength(2);
    // STARTDUMP must come AFTER the first reset and BEFORE the last.
    const wire = fake.wire();
    const startIdx = wire.findIndex(
      (c) =>
        c.m === "operation" &&
        c.op === OPER.SET_OPERATION &&
        c.operand === STATUS.STARTDUMP,
    );
    const lastResetIdx = wire.reduce(
      (acc, c, i) =>
        c.m === "operation" &&
        c.op === OPER.SET_OPERATION &&
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
    const fake = new FakeInlDevice({ failOnPayloadCall: 3 });

    await expect(dumpRegion(asDevice(fake), REGION)).rejects.toThrow(
      "simulated device fault",
    );

    // Leading reset always runs; the finally reset must also run despite the
    // throw, so the firmware isn't left mid-region for the NEXT dump.
    expect(fake.ops(STATUS.RESET)).toHaveLength(2);
    expect(fake.buffers(BUFFER.RAW_BUFFER_RESET)).toHaveLength(2);
    // The very last engine touch is a RESET, not a dangling STARTDUMP.
    const lastOp = fake.calls
      .filter((c) => c.m === "operation" && c.op === OPER.SET_OPERATION)
      .at(-1);
    expect(lastOp?.operand).toBe(STATUS.RESET);
  });

  it("resets the engine when the very first payload read throws", async () => {
    // The short-read desync guard lives in the real INLDevice.payloadIn
    // (covered by inl-device.test.ts); dumpRegion sees its symptom — a
    // throw — which here lands before any chunk was assembled.
    const fake = new FakeInlDevice({ failOnPayloadCall: 1 });

    await expect(dumpRegion(asDevice(fake), REGION)).rejects.toThrow();
    expect(fake.ops(STATUS.RESET)).toHaveLength(2);
  });

  it("an abort interrupts a stalled DUMPED poll before the timeout", async () => {
    const controller = new AbortController();
    const fake = new FakeInlDevice({
      // Device never reports DUMPED; abort on the 3rd status poll. The
      // in-poll signal check must surface AbortError well before the 5s
      // stall timeout (which would reject with the stall Error instead).
      onStatusPoll: (n) => {
        if (n === 3) controller.abort();
      },
    });

    await expect(
      dumpRegion(asDevice(fake), { ...REGION, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.ops(STATUS.RESET)).toHaveLength(2);
    expect(fake.buffers(BUFFER.RAW_BUFFER_RESET)).toHaveLength(2);
  });

  it("an abort signal interrupts within a chunk and still resets the engine", async () => {
    const controller = new AbortController();
    const fake = new FakeInlDevice({
      // Abort while the 3rd of 8 chunks is in flight; the per-chunk
      // throwIfAborted must stop the loop before chunk 4 is requested.
      onPayloadCall: (n) => {
        if (n === 3) controller.abort();
      },
    });

    await expect(
      dumpRegion(asDevice(fake), { ...REGION, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // No further status polls after the abort landed...
    expect(fake.statusPollCount()).toBeLessThanOrEqual(4);
    // ...and the engine still returns to idle on the way out.
    expect(fake.ops(STATUS.RESET)).toHaveLength(2);
    expect(fake.buffers(BUFFER.RAW_BUFFER_RESET)).toHaveLength(2);
  });
});
