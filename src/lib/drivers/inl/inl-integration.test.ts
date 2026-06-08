/**
 * End-to-end coverage of the INL stack: the real, device-agnostic NES mapper
 * catalog driven through `InlNesBus` and the double-buffered dump engine,
 * against a fake cart that streams bytes the way the firmware would.
 *
 * The shared-mapper specs (`mappers/mappers.test.ts`) already prove each
 * mapper's banking and byte-exact reconstruction with a bank-aware `NesBus`.
 * This file proves the INL-specific layer those specs bypass: that each
 * mapper's `readCpu`/`readPpu` calls translate to the correct firmware region
 * config (memType + address-page hint), and that the engine reassembles a
 * region byte-for-byte across a multi-bank walk.
 *
 * It also pins the key finding that MMC2 needs no INL-specific override: the
 * firmware's NESCPU_4KB / NESPPU_1KB reads at the $8000 / $0000 windows are
 * byte-identical to the vendor's NESCPU_PAGE / NESPPU_PAGE recipe, so the
 * shared `mmc2` mapper dumps correctly on INL as-is.
 *
 * The fake serves payloads sequentially, so byte-exactness here checks the
 * engine's reassembly, not the mapper's bank-select addresses (covered by the
 * shared specs). `makeImage` keeps every bank distinct, so the walk's bank-0
 * dropout retry never fires and never desyncs the sequential stream. Quattro
 * is the one catalog mapper absent: its walk assembles banks out of stream
 * order and snapshots per-block $C000 gate banks, which a sequential stream
 * can't model — its banking is proven in the shared specs.
 *
 * Mapper 268 is the one register-aware exception (`MindkidsCart` below): its
 * consensus read pulls every bank twice, which a sequential stream can't
 * serve, so that fake decodes the $5000 outer registers arriving over
 * NES_CPU_WR and snapshots the mapped window at each region start.
 * Mapper 470 is absent: the INL driver pre-flight-rejects it (same
 * CPLD-refusal family as 268), and its banking is proven in the shared specs.
 */

import { describe, it, expect, vi } from "vitest";
import type { INLDevice } from "./inl-device";
import { InlNesBus } from "./inl-nes-bus";
import { BUFFER, OPER, STATUS, MEM } from "./inl-opcodes";
import { nrom } from "@/lib/systems/nes/mappers/nrom";
import { mmc1 } from "@/lib/systems/nes/mappers/mmc1";
import { uxrom } from "@/lib/systems/nes/mappers/uxrom";
import { cxrom } from "@/lib/systems/nes/mappers/cxrom";
import { mmc3 } from "@/lib/systems/nes/mappers/mmc3";
import { axrom } from "@/lib/systems/nes/mappers/axrom";
import { mmc2 } from "@/lib/systems/nes/mappers/mmc2";
import { colorDreams } from "@/lib/systems/nes/mappers/color-dreams";
import { gxrom } from "@/lib/systems/nes/mappers/gxrom";
import { rambo1 } from "@/lib/systems/nes/mappers/rambo1";
import { fme7 } from "@/lib/systems/nes/mappers/fme7";
import { mapper268Mindkids } from "@/lib/systems/nes/mappers/coolboy";
import type { NesMapper } from "@/lib/systems/nes/mappers/types";

interface RegionConfig {
  memType: number;
  mapper: number;
  mapVar: number;
}

/**
 * Fake INLDevice: streams queued bytes through `payloadIn` (always reporting
 * DUMPED), and records each region's allocation + config so a test can assert
 * the firmware addressing is right.
 */
class FakeCart {
  private data = new Uint8Array(0);
  private cursor = 0;
  startdumpCount = 0;
  readonly regions: RegionConfig[] = [];
  private cur: RegionConfig | null = null;

  /** Append bytes the firmware would stream back (PRG, then CHR, etc.). */
  queue(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.data.length + bytes.length);
    merged.set(this.data);
    merged.set(bytes, this.data.length);
    this.data = merged;
  }

  async io(): Promise<null> {
    return null;
  }
  async nes(): Promise<number> {
    return 0;
  }

  async operation(op: number, operand = 0): Promise<number> {
    if (op === OPER.SET_OPERATION && operand === STATUS.STARTDUMP) {
      this.startdumpCount++;
    }
    return 0;
  }

  async buffer(op: number, operand = 0, misc = 0): Promise<number> {
    if (op === BUFFER.ALLOCATE_BUFFER0) {
      this.cur = { memType: -1, mapper: -1, mapVar: -1 };
      this.regions.push(this.cur);
    } else if (op === BUFFER.SET_MEM_N_PART && misc === 0 && this.cur) {
      this.cur.memType = operand >> 8;
    } else if (op === BUFFER.SET_MAP_N_MAPVAR && misc === 0 && this.cur) {
      this.cur.mapper = operand >> 8;
      this.cur.mapVar = operand & 0xff;
    } else if (op === BUFFER.GET_CUR_BUFF_STATUS) {
      return STATUS.DUMPED;
    }
    return 0;
  }

  async payloadIn(len = 128): Promise<Uint8Array> {
    const out = this.data.slice(this.cursor, this.cursor + len);
    this.cursor += len;
    return out;
  }
}

function asDevice(fake: FakeCart): INLDevice {
  return fake as unknown as INLDevice;
}

/** Deterministic, well-mixed image; `seed` makes distinct regions distinct. */
function makeImage(bytes: number, seed = 0): Uint8Array {
  const a = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++)
    a[i] = (Math.imul(i + seed * 0x9e3779b1, 2654435761) >>> 24) & 0xff;
  return a;
}

// Each mapper's realistic PRG size (a multiple of its bank size). NROM/CxROM
// are flat 32 KiB; the rest carry multi-bank PRG.
const PRG_CASES: { mapper: NesMapper; name: string; kb: number }[] = [
  { mapper: nrom, name: "NROM", kb: 32 },
  { mapper: mmc1, name: "MMC1", kb: 128 },
  { mapper: uxrom, name: "UxROM", kb: 128 },
  { mapper: cxrom, name: "CxROM", kb: 32 },
  { mapper: mmc3, name: "MMC3", kb: 128 },
  { mapper: axrom, name: "AxROM", kb: 128 },
  { mapper: mmc2, name: "MMC2", kb: 128 },
  { mapper: colorDreams, name: "ColorDreams", kb: 128 },
  { mapper: gxrom, name: "GxROM", kb: 128 },
  { mapper: rambo1, name: "RAMBO-1", kb: 128 },
  { mapper: fme7, name: "FME-7", kb: 128 },
];

describe("INL stack — PRG-ROM byte-exact through InlNesBus", () => {
  it.each(PRG_CASES)("$name dumps PRG byte-exact", async ({ mapper, kb }) => {
    const fake = new FakeCart();
    const image = makeImage(kb * 1024);
    fake.queue(image);
    const bus = new InlNesBus(asDevice(fake));

    const out = await mapper.dumpPrgRom(bus, kb);

    expect(out).toEqual(image);
    // PRG reads go through the $8000 (or $C000-fixed) window: all NESCPU_4KB.
    expect(fake.regions.every((r) => r.memType === MEM.NESCPU_4KB)).toBe(true);
  });
});

// CHR-ROM via a pure PPU read ($0000), with no bus-conflict prg-gate prelude.
const CHR_CASES: { mapper: NesMapper; name: string; kb: number }[] = [
  { mapper: nrom, name: "NROM", kb: 8 },
  { mapper: mmc2, name: "MMC2", kb: 128 },
  { mapper: mmc3, name: "MMC3", kb: 128 },
  { mapper: rambo1, name: "RAMBO-1", kb: 128 },
  { mapper: fme7, name: "FME-7", kb: 128 },
];

describe("INL stack — CHR-ROM byte-exact through InlNesBus", () => {
  it.each(CHR_CASES)("$name dumps CHR byte-exact", async ({ mapper, kb }) => {
    const fake = new FakeCart();
    const image = makeImage(kb * 1024, 7);
    fake.queue(image);
    const bus = new InlNesBus(asDevice(fake));

    const out = await mapper.dumpChrRom(bus, kb);

    expect(out).toEqual(image);
    expect(fake.regions.every((r) => r.memType === MEM.NESPPU_1KB)).toBe(true);
  });
});

describe("MMC2 on INL (no PAGE override needed)", () => {
  it("walks 16 PRG banks through the NESCPU_4KB/$8000 window", async () => {
    const fake = new FakeCart();
    const image = makeImage(128 * 1024);
    fake.queue(image);
    const bus = new InlNesBus(asDevice(fake));

    const out = await mmc2.dumpPrgRom(bus, 128);

    expect(out).toEqual(image);
    // One region per 8 KiB bank on this engine, every one at $8000/4KB.
    expect(fake.regions).toHaveLength(16);
    expect(fake.startdumpCount).toBe(16);
    expect(
      fake.regions.every(
        (r) => r.memType === MEM.NESCPU_4KB && r.mapper === 0x08,
      ),
    ).toBe(true);
  });

  it("walks CHR through the NESPPU_1KB/$0000 window", async () => {
    const fake = new FakeCart();
    fake.queue(makeImage(128 * 1024, 7));
    const bus = new InlNesBus(asDevice(fake));

    await mmc2.dumpChrRom(bus, 128);

    // 32 latch-pinned 4 KiB banks, every one a pure PPU read from $0000.
    expect(fake.regions).toHaveLength(32);
    expect(fake.startdumpCount).toBe(32);
    expect(
      fake.regions.every((r) => r.memType === MEM.NESPPU_1KB && r.mapper === 0),
    ).toBe(true);
  });
});

describe("InlNesBus region configs with real mappers", () => {
  it("a bus-conflict CHR dump reads its prg-gate via $8000 then walks the PPU window", async () => {
    // GxROM CHR reads PRG bank 0 once as the bus-conflict gate (NESCPU_4KB)
    // before walking CHR via the PPU window (NESPPU_1KB).
    const fake = new FakeCart();
    fake.queue(makeImage(128 * 1024)); // PRG
    fake.queue(makeImage(32 * 1024, 3)); // CHR gate read (PRG bank 0)
    fake.queue(makeImage(32 * 1024, 9)); // CHR banks
    const bus = new InlNesBus(asDevice(fake));

    await gxrom.dumpPrgRom(bus, 128);
    const prgRegions = fake.regions.length;
    expect(
      fake.regions.every(
        (r) => r.memType === MEM.NESCPU_4KB && r.mapper === 0x08,
      ),
    ).toBe(true);

    await gxrom.dumpChrRom(bus, 32);
    const chrRegions = fake.regions.slice(prgRegions);
    expect(chrRegions[0]).toEqual({
      memType: MEM.NESCPU_4KB,
      mapper: 0x08,
      mapVar: 0,
    }); // the prg-gate read
    expect(chrRegions.length).toBeGreaterThan(1);
    expect(
      chrRegions
        .slice(1)
        .every((r) => r.memType === MEM.NESPPU_1KB && r.mapper === 0),
    ).toBe(true);
  });

  it("routes the $6000 SRAM window to PRGRAM", async () => {
    const fake = new FakeCart();
    const image = makeImage(8 * 1024);
    fake.queue(image);
    const bus = new InlNesBus(asDevice(fake));

    const out = await bus.readCpu(0x6000, 8 * 1024);

    expect(out).toEqual(image);
    expect(fake.regions[0].memType).toBe(MEM.PRGRAM);
  });
});

/**
 * Register-aware fake for Mapper 268: tracks the Mindkids outer registers
 * written via NES_CPU_WR ($5000-$5003) and serves each dump region from the
 * 16 KiB window those registers map, snapshotted when the region's buffer is
 * allocated. GNROM-mode decode mirrors the spec-side model in
 * `mappers/mappers.test.ts`; until GNROM is engaged, reads return the boot
 * (power-on menu) window.
 */
class MindkidsCart extends FakeCart {
  private regs = [0, 0, 0, 0];
  private window: Uint8Array = new Uint8Array(0);
  private winCursor = 0;
  private readonly flash: Uint8Array;
  private readonly boot: Uint8Array;
  constructor(flash: Uint8Array, boot: Uint8Array) {
    super();
    this.flash = flash;
    this.boot = boot;
  }
  override async nes(_op?: number, addr = 0, value = 0): Promise<number> {
    if (addr < 0x5000 || addr > 0x5fff) {
      throw new Error(`unexpected CPU write $${addr.toString(16)}`);
    }
    this.regs[addr & 3] = value;
    return 0;
  }
  override async buffer(op: number, operand = 0, misc = 0): Promise<number> {
    if (op === BUFFER.ALLOCATE_BUFFER0) {
      // Region start: snapshot the currently-mapped $8000 window.
      this.window = this.currentWindow();
      this.winCursor = 0;
    }
    return super.buffer(op, operand, misc);
  }
  override async payloadIn(len = 128): Promise<Uint8Array> {
    const out = this.window.slice(this.winCursor, this.winCursor + len);
    this.winCursor += len;
    return out;
  }
  private currentWindow(): Uint8Array {
    const [r0, r1, , r3] = this.regs;
    if (!(r3 & 0x10) || !(r0 & 0x40) || !(r1 & 0x80)) return this.boot;
    const bank =
      ((r3 >> 1) & 7) |
      ((r0 & 7) << 3) |
      (((r1 >> 4) & 1) << 6) |
      (((r1 >> 2) & 3) << 7) |
      (((r0 >> 4) & 3) << 9);
    const off = (bank * 0x4000) % this.flash.length;
    return this.flash.slice(off, off + 0x4000);
  }
}

describe("Mapper 268 (Mindkids) on INL", () => {
  // 512 KiB keeps the 128-byte-chunk pulls tractable; the full 2 MiB
  // register-bit coverage runs against the fast bank-aware bus in the
  // shared mapper specs.
  it("dumps 512 KiB byte-exact via $5000 writes over NES_CPU_WR", async () => {
    vi.useFakeTimers();
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    try {
      const flash = makeImage(512 * 1024); // 32 banks
      const cart = new MindkidsCart(flash, makeImage(16 * 1024, 5));
      const bus = new InlNesBus(asDevice(cart));

      const p = mapper268Mindkids.dumpPrgRom(bus, 512);
      await vi.runAllTimersAsync(); // the per-write settle delays
      const out = await p;

      expect(out).toEqual(flash);
      // 32 banks x 2 consensus reads, every region a NESCPU_4KB read
      // through the $8000 window.
      expect(cart.regions).toHaveLength(64);
      expect(
        cart.regions.every(
          (r) => r.memType === MEM.NESCPU_4KB && r.mapper === 0x08,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      spies.forEach((s) => s.mockRestore());
    }
  });
});
