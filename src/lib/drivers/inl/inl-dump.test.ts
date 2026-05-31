import { describe, it, expect } from "vitest";
import type { INLDevice } from "./inl-device";
import { InlNesBus } from "./inl-nes-bus";
import {
  allocateRegion,
  streamRegion,
  dumpRegion,
  LAYOUT_2x128,
  LAYOUT_4x128,
  DEFAULT_LAYOUT,
  type RegionCfg,
} from "./inl-dump";
import { BUFFER, OPER, STATUS, MEM, PART } from "./inl-opcodes";

/**
 * Records every control-transfer the dump engine issues so a test can assert
 * the exact wire sequence (the off-by-one firewall for the buffer layout), and
 * serves payload bytes + buffer-status replies the way the firmware would.
 */
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
    if (this.rx.length < len) return new Uint8Array(len); // sequence-only tests
    return new Uint8Array(this.rx.splice(0, len));
  }

  // ─── assertion helpers ───────────────────────────────────────────────────
  buffers(op: number): Call[] {
    return this.calls.filter((c) => c.m === "buffer" && c.op === op);
  }
  ops(operand: number): Call[] {
    return this.calls.filter(
      (c) => c.m === "operation" && c.op === OPER.SET_OPERATION && c.operand === operand,
    );
  }
  /** The ordered control-transfer sequence, dropping payload reads. */
  wire(): Call[] {
    return this.calls.filter((c) => c.m === "operation" || c.m === "buffer");
  }
}

function asDevice(fake: FakeInlDevice): INLDevice {
  return fake as unknown as INLDevice;
}

/** Deterministic, well-mixed image so every byte position is distinct. */
function makeImage(bytes: number): Uint8Array {
  const a = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) a[i] = (Math.imul(i, 2654435761) >>> 24) & 0xff;
  return a;
}

const PRG_CFG: RegionCfg = { memType: MEM.NESCPU_4KB, mapper: 0x08, mapVar: 0 };

describe("buffer layout constants", () => {
  it("4x128B fills the 16-bank pool as two interleaved 256B-page pairs", () => {
    expect(LAYOUT_4x128.buffSize).toBe(128);
    expect(LAYOUT_4x128.slots).toEqual([
      { id: 0x00, baseBank: 0, firstPage: 0, reload: 2 },
      { id: 0x80, baseBank: 4, firstPage: 0, reload: 2 },
      { id: 0x00, baseBank: 8, firstPage: 1, reload: 2 },
      { id: 0x80, baseBank: 12, firstPage: 1, reload: 2 },
    ]);
    // 4 buffers x 4 banks = 16 = NUM_RAW_BANKS; the firmware rejects more.
    const banks = LAYOUT_4x128.slots.map((s) => s.baseBank);
    expect(banks).toEqual([0, 4, 8, 12]);
    expect(DEFAULT_LAYOUT).toBe(LAYOUT_4x128);
  });

  it("2x128B matches the legacy reload=1 double buffer", () => {
    expect(LAYOUT_2x128.slots).toEqual([
      { id: 0x00, baseBank: 0, firstPage: 0, reload: 1 },
      { id: 0x80, baseBank: 4, firstPage: 0, reload: 1 },
    ]);
  });

  it("declares the four-buffer opcodes the firmware exposes", () => {
    expect(BUFFER.ALLOCATE_BUFFER2).toBe(0x82);
    expect(BUFFER.ALLOCATE_BUFFER3).toBe(0x83);
    expect(BUFFER.SET_RELOAD_PAGENUM0).toBe(0x90);
    expect(BUFFER.SET_RELOAD_PAGENUM3).toBe(0x93);
  });
});

describe("allocateRegion", () => {
  it("emits the exact 4x128B allocate + config sequence once", async () => {
    const fake = new FakeInlDevice();
    await allocateRegion(asDevice(fake), PRG_CFG, LAYOUT_4x128);

    const memPart = (MEM.NESCPU_4KB << 8) | PART.MASKROM;
    const mapVar = (0x08 << 8) | 0;
    expect(fake.wire()).toEqual([
      { m: "operation", op: OPER.SET_OPERATION, operand: STATUS.RESET },
      { m: "buffer", op: BUFFER.RAW_BUFFER_RESET, operand: 0, misc: 0 },
      // allocate: operand = (id<<8)|baseBank, misc = num_banks (128/32 = 4)
      { m: "buffer", op: 0x80, operand: 0x0000, misc: 4 },
      { m: "buffer", op: 0x81, operand: 0x8004, misc: 4 },
      { m: "buffer", op: 0x82, operand: 0x0008, misc: 4 },
      { m: "buffer", op: 0x83, operand: 0x800c, misc: 4 },
      // reload/page_num: operand = firstPage, misc = reload
      { m: "buffer", op: 0x90, operand: 0, misc: 2 },
      { m: "buffer", op: 0x91, operand: 0, misc: 2 },
      { m: "buffer", op: 0x92, operand: 1, misc: 2 },
      { m: "buffer", op: 0x93, operand: 1, misc: 2 },
      // per-buffer mem/part then map/mapvar, selected by misc = buffer index
      { m: "buffer", op: BUFFER.SET_MEM_N_PART, operand: memPart, misc: 0 },
      { m: "buffer", op: BUFFER.SET_MEM_N_PART, operand: memPart, misc: 1 },
      { m: "buffer", op: BUFFER.SET_MEM_N_PART, operand: memPart, misc: 2 },
      { m: "buffer", op: BUFFER.SET_MEM_N_PART, operand: memPart, misc: 3 },
      { m: "buffer", op: BUFFER.SET_MAP_N_MAPVAR, operand: mapVar, misc: 0 },
      { m: "buffer", op: BUFFER.SET_MAP_N_MAPVAR, operand: mapVar, misc: 1 },
      { m: "buffer", op: BUFFER.SET_MAP_N_MAPVAR, operand: mapVar, misc: 2 },
      { m: "buffer", op: BUFFER.SET_MAP_N_MAPVAR, operand: mapVar, misc: 3 },
    ]);
  });

  it("drives SRAM regions through the SRAM part", async () => {
    const fake = new FakeInlDevice();
    await allocateRegion(
      asDevice(fake),
      { memType: MEM.PRGRAM, mapper: 0, mapVar: 0 },
      LAYOUT_2x128,
    );
    const memPart = (MEM.PRGRAM << 8) | PART.SRAM;
    expect(fake.buffers(BUFFER.SET_MEM_N_PART).map((c) => c.operand)).toEqual([
      memPart,
      memPart,
    ]);
  });
});

describe("streamRegion", () => {
  it("STARTDUMPs once then polls and reads one chunk per buffSize", async () => {
    const fake = new FakeInlDevice();
    const image = makeImage(8 * 1024);
    fake.queue(image);

    const out = await streamRegion(asDevice(fake), 8, LAYOUT_4x128);

    expect(out).toEqual(image);
    expect(fake.ops(STATUS.STARTDUMP)).toHaveLength(1);
    const payloads = fake.calls.filter((c) => c.m === "payloadIn");
    expect(payloads).toHaveLength((8 * 1024) / 128); // 64 chunks
    expect(payloads.every((c) => c.len === 128)).toBe(true);
  });

  it("tolerates DUMPING replies before DUMPED without losing bytes", async () => {
    const fake = new FakeInlDevice();
    fake.setDumpingBeforeReady(2);
    const image = makeImage(1024);
    fake.queue(image);

    const out = await streamRegion(asDevice(fake), 1, LAYOUT_4x128);

    expect(out).toEqual(image);
    const chunks = 1024 / 128; // 8
    // each chunk: 2 DUMPING + 1 DUMPED status polls
    expect(fake.buffers(BUFFER.GET_CUR_BUFF_STATUS)).toHaveLength(chunks * 3);
  });
});

describe("dumpRegion one-shot", () => {
  it("allocates, streams, then resets the buffers", async () => {
    const fake = new FakeInlDevice();
    const image = makeImage(8 * 1024);
    fake.queue(image);

    const out = await dumpRegion(asDevice(fake), {
      sizeKB: 8,
      memType: MEM.NESCPU_4KB,
      mapper: 0x08,
      mapVar: 0,
    });

    expect(out).toEqual(image);
    expect(fake.buffers(0x80)).toHaveLength(1); // allocated once
    expect(fake.ops(STATUS.STARTDUMP)).toHaveLength(1);
    // ends by tearing the allocation down
    const tail = fake.wire().slice(-2);
    expect(tail).toEqual([
      { m: "operation", op: OPER.SET_OPERATION, operand: STATUS.RESET },
      { m: "buffer", op: BUFFER.RAW_BUFFER_RESET, operand: 0, misc: 0 },
    ]);
  });
});

describe("InlNesBus setup hoist", () => {
  it("allocates once and re-STARTDUMPs per same-config bank", async () => {
    const fake = new FakeInlDevice();
    const bus = new InlNesBus(asDevice(fake));
    const image = makeImage(3 * 8 * 1024);
    fake.queue(image);

    const out = new Uint8Array(image.length);
    for (let bank = 0; bank < 3; bank++) {
      const chunk = await bus.readCpu(0x8000, 8 * 1024);
      out.set(chunk, bank * 8 * 1024);
    }

    expect(out).toEqual(image); // byte-exact across the hoisted reads
    // allocate + per-buffer config happen exactly once for the whole walk
    expect(fake.buffers(0x80)).toHaveLength(1);
    expect(fake.buffers(BUFFER.RAW_BUFFER_RESET)).toHaveLength(1);
    expect(fake.buffers(BUFFER.SET_MEM_N_PART)).toHaveLength(4);
    expect(fake.buffers(BUFFER.SET_MAP_N_MAPVAR)).toHaveLength(4);
    // but every bank gets its own STARTDUMP
    expect(fake.ops(STATUS.STARTDUMP)).toHaveLength(3);
    // page_num is re-zeroed once at allocate, then per later bank (banks 1,2)
    expect(fake.buffers(BUFFER.SET_RELOAD_PAGENUM0)).toHaveLength(1 + 2);
  });

  it("re-allocates when the region config changes (PRG -> CHR)", async () => {
    const fake = new FakeInlDevice();
    const bus = new InlNesBus(asDevice(fake));
    fake.queue(makeImage(16 * 1024));

    await bus.readCpu(0x8000, 8 * 1024);
    await bus.readPpu(0x0000, 8 * 1024);

    expect(fake.buffers(0x80)).toHaveLength(2); // one allocate per config
    expect(fake.buffers(BUFFER.RAW_BUFFER_RESET)).toHaveLength(2);
    const mapvars = fake.buffers(BUFFER.SET_MAP_N_MAPVAR).map((c) => c.operand);
    expect(mapvars.slice(0, 4)).toEqual([0x0800, 0x0800, 0x0800, 0x0800]); // PRG mapper 0x08
    expect(mapvars.slice(4)).toEqual([0x0000, 0x0000, 0x0000, 0x0000]); // CHR mapper 0x00
  });

  it("setup() ends the session so the next read re-allocates", async () => {
    const fake = new FakeInlDevice();
    const bus = new InlNesBus(asDevice(fake));
    fake.queue(makeImage(16 * 1024));

    await bus.readCpu(0x8000, 8 * 1024);
    await bus.setup();
    await bus.readCpu(0x8000, 8 * 1024);

    expect(fake.buffers(0x80)).toHaveLength(2);
  });

  it("returns correct bytes when the same bank is read twice (retry path)", async () => {
    const fake = new FakeInlDevice();
    const bus = new InlNesBus(asDevice(fake));
    const image = makeImage(8 * 1024);
    fake.queue(image); // attempt 1
    fake.queue(image); // attempt 2 (walkBanks retry re-reads the bank)

    const first = await bus.readCpu(0x8000, 8 * 1024);
    const second = await bus.readCpu(0x8000, 8 * 1024);

    expect(first).toEqual(image);
    expect(second).toEqual(image);
  });
});
