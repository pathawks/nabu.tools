/**
 * End-to-end coverage of the INL stack: the real, device-agnostic NES mapper
 * catalog driven through `InlNesBus` and the multi-buffer dump engine, against
 * a fake cart that streams bytes the way the firmware would.
 *
 * The shared-mapper specs (`mappers/mappers.test.ts`) already prove each
 * mapper's banking and byte-exact reconstruction with a bank-aware `NesBus`.
 * This file proves the INL-specific layer those specs bypass: that each
 * mapper's `readCpu`/`readPpu` calls translate to the correct firmware region
 * config (memType + address-page hint), that the per-region allocation hoist
 * collapses an N-bank walk into one allocation, and that the new 4×128B engine
 * reassembles a region byte-for-byte.
 *
 * It also pins the key finding that MMC2 needs no INL-specific override: the
 * firmware's NESCPU_4KB / NESPPU_1KB reads at the $8000 / $0000 windows are
 * byte-identical to the vendor's NESCPU_PAGE / NESPPU_PAGE recipe, so the
 * shared `mmc2` mapper dumps correctly on INL as-is.
 *
 * The fake serves payloads sequentially, so byte-exactness here checks the
 * engine's reassembly, not the mapper's bank-select addresses (covered by the
 * shared specs). `makeImage` keeps every bank distinct, so the walk's bank-0
 * dropout retry never fires and never desyncs the sequential stream.
 */

import { describe, it, expect } from "vitest";
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
import type { NesMapper } from "@/lib/systems/nes/mappers/types";

interface RegionConfig {
  memType: number;
  mapper: number;
  mapVar: number;
}

/**
 * Fake INLDevice: streams queued bytes through `payloadIn` (always reporting
 * DUMPED), and records each region's allocation + config so a test can assert
 * the hoist fired and the firmware addressing is right.
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

  get allocCount(): number {
    return this.regions.length;
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
  it("walks 16 PRG banks via one hoisted NESCPU_4KB/$8000 allocation", async () => {
    const fake = new FakeCart();
    const image = makeImage(128 * 1024);
    fake.queue(image);
    const bus = new InlNesBus(asDevice(fake));

    const out = await mmc2.dumpPrgRom(bus, 128);

    expect(out).toEqual(image);
    expect(fake.allocCount).toBe(1); // 16 banks, ONE allocation (the hoist)
    expect(fake.startdumpCount).toBe(16); // one STARTDUMP per bank
    expect(fake.regions[0]).toEqual({
      memType: MEM.NESCPU_4KB,
      mapper: 0x08, // $8000
      mapVar: 0,
    });
  });

  it("walks CHR via one hoisted NESPPU_1KB/$0000 allocation", async () => {
    const fake = new FakeCart();
    fake.queue(makeImage(128 * 1024, 7));
    const bus = new InlNesBus(asDevice(fake));

    await mmc2.dumpChrRom(bus, 128);

    expect(fake.allocCount).toBe(1); // 32 latch-pinned banks, ONE allocation
    expect(fake.startdumpCount).toBe(32);
    expect(fake.regions[0]).toEqual({
      memType: MEM.NESPPU_1KB,
      mapper: 0x00, // $0000
      mapVar: 0,
    });
  });
});

describe("InlNesBus region transitions with real mappers", () => {
  it("re-allocates on every config change in a bus-conflict CHR dump", async () => {
    // GxROM CHR reads PRG bank 0 once as the bus-conflict gate (NESCPU_4KB)
    // before walking CHR via the PPU window (NESPPU_1KB) — two configs, so two
    // allocations, both distinct from the PRG region's.
    const fake = new FakeCart();
    fake.queue(makeImage(128 * 1024)); // PRG
    fake.queue(makeImage(32 * 1024, 3)); // CHR gate read (PRG bank 0)
    fake.queue(makeImage(32 * 1024, 9)); // CHR banks
    const bus = new InlNesBus(asDevice(fake));

    await gxrom.dumpPrgRom(bus, 128);
    await gxrom.dumpChrRom(bus, 32);

    expect(fake.regions).toEqual([
      { memType: MEM.NESCPU_4KB, mapper: 0x08, mapVar: 0 }, // PRG walk
      { memType: MEM.NESCPU_4KB, mapper: 0x08, mapVar: 0 }, // CHR's prg-gate read
      { memType: MEM.NESPPU_1KB, mapper: 0x00, mapVar: 0 }, // CHR walk
    ]);
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
