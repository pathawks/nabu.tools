import { describe, it, expect, vi } from "vitest";
import type { NesBus } from "../bus";
import { bytesEqual } from "./bank-reliability";
import { nrom } from "./nrom";
import { mmc1 } from "./mmc1";
import { uxrom } from "./uxrom";
import { cxrom } from "./cxrom";
import { mmc2 } from "./mmc2";
import { mmc3 } from "./mmc3";
import { rambo1 } from "./rambo1";
import { axrom } from "./axrom";
import { colorDreams } from "./color-dreams";
import { gxrom } from "./gxrom";
import { fme7 } from "./fme7";
import { bf909x } from "./bf909x";
import { dxrom } from "./dxrom";
import { quattro } from "./quattro";
import { mapper268Mindkids, mapper268Coolboy } from "./coolboy";
import { mapper413 } from "./batmap";
import { mapper470 } from "./inx007t";

/**
 * A deterministic, well-mixed cart image. The multiplicative hash makes
 * every aligned bank distinct (and non-uniform), so the dropout detector
 * never false-positives and bank reconstruction is exactly verifiable.
 * `seed` makes distinct images distinct (e.g. a boot window that must not
 * collide with any flash bank).
 */
function makeImage(bytes: number, seed = 0): Uint8Array {
  const a = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++)
    a[i] = (Math.imul(i + seed * 0x9e3779b1, 2654435761) >>> 24) & 0xff;
  return a;
}

function expectSameBytes(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length);
  expect(bytesEqual(actual, expected)).toBe(true);
}

/**
 * A cart image guaranteed to hold a 0xFF byte in PRG bank 0. The
 * discrete bus-conflict mappers (GxROM, Color Dreams) write bank numbers
 * through such a byte (`value & 0xFF == value`), so the fake bus needs
 * one present to exercise that path rather than the no-gate fallback.
 */
function imageWithGate(bytes: number): Uint8Array {
  const a = makeImage(bytes);
  a[3] = 0xff;
  return a;
}

/**
 * Like `imageWithGate`, but seeds a 0xFF write gate at offset 3 of *every*
 * `bankBytes`-sized bank. The two-register Quattro (mapper 232) gates its
 * page selects through whichever bank sits in the $C000 window — a different
 * bank per outer block — not just bank 0, so each needs a gate byte.
 */
function imageWithGatePerBank(bytes: number, bankBytes: number): Uint8Array {
  const a = makeImage(bytes);
  for (let off = 0; off < bytes; off += bankBytes) a[off + 3] = 0xff;
  return a;
}

describe("NROM (mapper 0)", () => {
  class NromBus implements NesBus {
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    constructor(prg: Uint8Array, chr: Uint8Array) {
      this.prg = prg;
      this.chr = chr;
    }
    async setup() {}
    async writeCpu() {}
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      return this.prg.slice(0, length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      return this.chr.slice(0, length);
    }
  }

  it("dumps the flat 32 KiB PRG window", async () => {
    const prg = makeImage(32 * 1024);
    const out = await nrom.dumpPrgRom(new NromBus(prg, new Uint8Array(0)), 32);
    expectSameBytes(out, prg);
  });

  it("dumps 8 KiB CHR-ROM", async () => {
    const chr = makeImage(8 * 1024);
    const out = await nrom.dumpChrRom(new NromBus(new Uint8Array(0), chr), 8);
    expectSameBytes(out, chr);
  });

  it("throws a clear error when the bus has no PPU read", async () => {
    const noPpu: NesBus = {
      setup: async () => {},
      writeCpu: async () => {},
      readCpu: async () => new Uint8Array(0),
    };
    await expect(nrom.dumpChrRom(noPpu, 8)).rejects.toThrow(/PPU-bus/);
  });
});

describe("MMC3 (mapper 4)", () => {
  // Models R0/R1 (CHR, 1 KiB units → 2 KiB windows) and R6 (8 KiB PRG at $8000).
  class Mmc3Bus implements NesBus {
    private select = 0;
    private r = new Array<number>(8).fill(0);
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    constructor(prg: Uint8Array, chr: Uint8Array) {
      this.prg = prg;
      this.chr = chr;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      if (addr === 0x8000) this.select = value & 0x07;
      else if (addr === 0x8001) this.r[this.select] = value;
      // $A000 (mirroring) / $A001 (PRG-RAM) are no-ops for content reads.
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      expect(length).toBe(8 * 1024);
      const off = this.r[6] * 0x2000;
      return this.prg.slice(off, off + length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      expect(length).toBe(4 * 1024);
      const b0 = (this.r[0] >> 1) * 0x800;
      const b1 = (this.r[1] >> 1) * 0x800;
      const out = new Uint8Array(length);
      out.set(this.chr.slice(b0, b0 + 0x800), 0);
      out.set(this.chr.slice(b1, b1 + 0x800), 0x800);
      return out;
    }
  }

  it("walks all PRG banks via R6", async () => {
    const prg = makeImage(64 * 1024); // 8 banks of 8 KiB
    const out = await mmc3.dumpPrgRom(new Mmc3Bus(prg, new Uint8Array(0)), 64);
    expectSameBytes(out, prg);
  });

  it("walks CHR via R0/R1", async () => {
    const chr = makeImage(32 * 1024);
    const out = await mmc3.dumpChrRom(new Mmc3Bus(new Uint8Array(0), chr), 32);
    expectSameBytes(out, chr);
  });
});

describe("MMC2 (mapper 9)", () => {
  // Models MMC2: $A000 selects the 8 KiB PRG bank at $8000 (4 bits, ASIC
  // so no bus conflict — the written value latches directly); $B000/$C000
  // are the $0000-window CHR registers for latch states $FD/$FE. `drops`
  // simulates a flaky clone latch by ignoring the first N non-zero $A000
  // selects (leaving the prior bank — bank 0 for the first switch — mapped).
  class Mmc2Bus implements NesBus {
    private prgBank = 0;
    private chrFD = 0; // $B000
    private chrFE = 0; // $C000
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    private drops: number;
    constructor(prg: Uint8Array, chr: Uint8Array, drops = 0) {
      this.prg = prg;
      this.chr = chr;
      this.drops = drops;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      if (addr === 0xa000) {
        const bank = value & 0x0f;
        if (bank !== 0 && this.drops > 0) {
          this.drops--; // dropped latch: register keeps its old value
          return;
        }
        this.prgBank = bank;
      } else if (addr === 0xb000) {
        this.chrFD = value & 0x1f;
      } else if (addr === 0xc000) {
        this.chrFE = value & 0x1f;
      }
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      expect(length).toBe(0x2000); // 8 KiB switchable window
      const off = this.prgBank * 0x2000;
      return this.prg.slice(off, off + length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      expect(length).toBe(0x1000); // 4 KiB window
      // The dump pins both latch registers to the same bank, making the
      // window latch-immune — assert that so a single-register regression
      // is caught — then read that bank regardless of latch state.
      expect(this.chrFD).toBe(this.chrFE);
      const off = this.chrFD * 0x1000;
      return this.chr.slice(off, off + length);
    }
  }

  it("walks all sixteen 8 KiB PRG banks via $A000", async () => {
    const prg = makeImage(128 * 1024);
    const out = await mmc2.dumpPrgRom(new Mmc2Bus(prg, new Uint8Array(0)), 128);
    expectSameBytes(out, prg);
  });

  it("pins both latch registers and walks all 32 CHR banks via $0000", async () => {
    const chr = makeImage(128 * 1024);
    const out = await mmc2.dumpChrRom(new Mmc2Bus(new Uint8Array(0), chr), 128);
    expectSameBytes(out, chr);
  });

  it("recovers from a dropped PRG bank-select via the bank-0 retry", async () => {
    const prg = makeImage(128 * 1024);
    // Drop the first real ($A000) select: bank 1 reads back as bank 0, and
    // readBankWithRetry re-issues it.
    const out = await mmc2.dumpPrgRom(
      new Mmc2Bus(prg, new Uint8Array(0), 1),
      128,
    );
    expectSameBytes(out, prg);
  });

  it("throws a clear error when the bus has no PPU read", async () => {
    const noPpu: NesBus = {
      setup: async () => {},
      writeCpu: async () => {},
      readCpu: async () => new Uint8Array(0),
    };
    await expect(mmc2.dumpChrRom(noPpu, 128)).rejects.toThrow(/PPU-bus/);
  });
});

describe("MMC1 (mapper 1)", () => {
  // A faithful MMC1 cart model. Beyond the serial shift register and the
  // four banking registers, it reproduces the bit-7 reset's documented
  // side effect: clearing the shift register ALSO forces PRG mode to 3
  // (16 KiB, last bank fixed at $C000) via `Control |= $0C`. Since every
  // register write begins with that reset, a 32 KiB-mode dump that fails to
  // re-assert the control register right before reading lands in mode 3 —
  // this model makes that mistake observable, so the tests below would fail
  // if `dumpPrgRom` dropped the re-assert.
  abstract class Mmc1Cart implements NesBus {
    protected control = 0x0c; // power-on: PRG mode 3
    protected prgReg = 0;
    protected chr0 = 0;
    protected chr1 = 0;
    protected readonly prg: Uint8Array;
    protected readonly chr: Uint8Array;
    constructor(prg: Uint8Array, chr: Uint8Array) {
      this.prg = prg;
      this.chr = chr;
    }
    async setup() {}
    /** A bit-7 reset clears the shift register and forces PRG mode 3. */
    protected reset() {
      this.control |= 0x0c;
    }
    /** Latch a 5-bit value into the register picked by address bits 13-14. */
    protected latch(addr: number, value: number) {
      const reg = (addr >> 13) & 0x03; // $8000/$A000/$C000/$E000
      if (reg === 0) this.control = value;
      else if (reg === 1) this.chr0 = value;
      else if (reg === 2) this.chr1 = value;
      else this.prgReg = value;
    }
    abstract writeCpu(addr: number, value: number): Promise<void>;
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      expect(length).toBe(0x8000); // the dump reads 32 KiB windows
      const num16 = this.prg.length / 0x4000;
      const mode = (this.control >> 2) & 0x03;
      let low16: number;
      let high16: number;
      if (mode <= 1) {
        // 32 KiB mode: the bank register's low bit is ignored.
        const bank32 = (this.prgReg >> 1) % (num16 / 2);
        [low16, high16] = [bank32 * 2, bank32 * 2 + 1];
      } else if (mode === 3) {
        // $8000 switchable, $C000 fixed to the last 16 KiB bank.
        [low16, high16] = [(this.prgReg & 0x0f) % num16, num16 - 1];
      } else {
        // mode 2: $8000 fixed to the first bank, $C000 switchable.
        [low16, high16] = [0, (this.prgReg & 0x0f) % num16];
      }
      const out = new Uint8Array(0x8000);
      out.set(this.prg.slice(low16 * 0x4000, low16 * 0x4000 + 0x4000), 0);
      out.set(
        this.prg.slice(high16 * 0x4000, high16 * 0x4000 + 0x4000),
        0x4000,
      );
      return out;
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      // 4 KiB CHR mode: chr0 → PPU $0000, chr1 → PPU $1000.
      const out = new Uint8Array(length);
      out.set(
        this.chr.slice(this.chr0 * 0x1000, this.chr0 * 0x1000 + 0x1000),
        0,
      );
      out.set(
        this.chr.slice(this.chr1 * 0x1000, this.chr1 * 0x1000 + 0x1000),
        0x1000,
      );
      return out;
    }
  }

  // Generic path: the mapper clocks five individual per-bit `writeCpu`s.
  class Mmc1SerialCart extends Mmc1Cart {
    private shift = 0;
    private count = 0;
    async writeCpu(addr: number, value: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      if (value & 0x80) {
        this.shift = 0;
        this.count = 0;
        this.reset();
        return;
      }
      this.shift |= (value & 1) << this.count;
      if (++this.count < 5) return;
      this.latch(addr, this.shift);
      this.shift = 0;
      this.count = 0;
    }
  }

  // Firmware path: the bus exposes the atomic `writeSerialRegister`
  // capability, so the mapper loads each register in one call and the only
  // `writeCpu` it ever issues is the bit-7 reset.
  class Mmc1AtomicCart extends Mmc1Cart {
    async writeCpu(addr: number, value: number) {
      expect(addr).toBe(0x8000);
      expect(value & 0x80).toBe(0x80); // reset only — never a data bit
      this.reset();
    }
    async writeSerialRegister(addr: number, value: number) {
      this.latch(addr, value);
    }
  }

  it("walks PRG banks in 32 KiB mode, re-asserting control past the reset", async () => {
    const prg = makeImage(128 * 1024); // 4 x 32 KiB
    const out = await mmc1.dumpPrgRom(
      new Mmc1SerialCart(prg, new Uint8Array(0)),
      128,
    );
    expectSameBytes(out, prg);
  });

  it("walks CHR via the two 4 KiB windows", async () => {
    const chr = makeImage(16 * 1024); // 2 x 8 KiB
    const out = await mmc1.dumpChrRom(
      new Mmc1SerialCart(new Uint8Array(0), chr),
      16,
    );
    expectSameBytes(out, chr);
  });

  it("loads registers via the atomic writeSerialRegister capability", async () => {
    const prg = makeImage(128 * 1024);
    const out = await mmc1.dumpPrgRom(
      new Mmc1AtomicCart(prg, new Uint8Array(0)),
      128,
    );
    expectSameBytes(out, prg);
  });

  it("walks CHR through the atomic capability too", async () => {
    const chr = makeImage(16 * 1024);
    const out = await mmc1.dumpChrRom(
      new Mmc1AtomicCart(new Uint8Array(0), chr),
      16,
    );
    expectSameBytes(out, chr);
  });
});

describe("GxROM (mapper 66)", () => {
  // Models the bus conflict: a register write latches `cpu_value &
  // rom_value`, where rom_value is the byte at the write address in the
  // currently-mapped PRG bank. Register: bits 4-5 = 32 KiB PRG bank,
  // bits 0-1 = 8 KiB CHR bank. `drops` simulates a flaky clone latch by
  // ignoring the first N non-zero selects (leaving the cart on bank 0).
  class GxromBus implements NesBus {
    private prgBank = 0;
    private chrBank = 0;
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    private drops: number;
    constructor(prg: Uint8Array, chr: Uint8Array, drops = 0) {
      this.prg = prg;
      this.chr = chr;
      this.drops = drops;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      const romByte = this.prg[this.prgBank * 0x8000 + (addr - 0x8000)] ?? 0xff;
      const latched = value & romByte;
      if (latched !== 0 && this.drops > 0) {
        this.drops--; // dropped latch: register keeps its old value
        return;
      }
      this.prgBank = (latched >> 4) & 0x03;
      this.chrBank = latched & 0x03;
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      const off = this.prgBank * 0x8000;
      return this.prg.slice(off, off + length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      const off = this.chrBank * 0x2000;
      return this.chr.slice(off, off + length);
    }
  }

  it("dumps all four 32 KiB PRG banks", async () => {
    const prg = imageWithGate(128 * 1024);
    const out = await gxrom.dumpPrgRom(
      new GxromBus(prg, new Uint8Array(0)),
      128,
    );
    expectSameBytes(out, prg);
  });

  it("dumps all four 8 KiB CHR banks", async () => {
    const prg = imageWithGate(32 * 1024); // bank 0 carries the write gate
    const chr = makeImage(32 * 1024);
    const out = await gxrom.dumpChrRom(new GxromBus(prg, chr), 32);
    expectSameBytes(out, chr);
  });

  it("recovers from a dropped bank-select via the bank-0 retry", async () => {
    const prg = imageWithGate(128 * 1024);
    // Drop the first real select: it reads back as bank 0, and
    // readBankWithRetry re-issues it from bank 0.
    const out = await gxrom.dumpPrgRom(
      new GxromBus(prg, new Uint8Array(0), 1),
      128,
    );
    expectSameBytes(out, prg);
  });
});

describe("Color Dreams (mapper 11)", () => {
  // Bus-conflict model. Register: bits 0-3 = 32 KiB PRG bank, bits 4-7 =
  // 8 KiB CHR bank.
  class ColorDreamsBus implements NesBus {
    private prgBank = 0;
    private chrBank = 0;
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    constructor(prg: Uint8Array, chr: Uint8Array) {
      this.prg = prg;
      this.chr = chr;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      const romByte = this.prg[this.prgBank * 0x8000 + (addr - 0x8000)] ?? 0xff;
      const latched = value & romByte;
      this.prgBank = latched & 0x0f;
      this.chrBank = (latched >> 4) & 0x0f;
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      const off = this.prgBank * 0x8000;
      return this.prg.slice(off, off + length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      const off = this.chrBank * 0x2000;
      return this.chr.slice(off, off + length);
    }
  }

  it("dumps PRG banks via bits 0-3", async () => {
    const prg = imageWithGate(128 * 1024); // 4 banks of 32 KiB
    const out = await colorDreams.dumpPrgRom(
      new ColorDreamsBus(prg, new Uint8Array(0)),
      128,
    );
    expectSameBytes(out, prg);
  });

  it("dumps CHR banks via bits 4-7", async () => {
    const prg = imageWithGate(32 * 1024); // bank 0 carries the write gate
    const chr = makeImage(64 * 1024); // 8 banks of 8 KiB
    const out = await colorDreams.dumpChrRom(new ColorDreamsBus(prg, chr), 64);
    expectSameBytes(out, chr);
  });
});

describe("UxROM (mapper 2)", () => {
  // Models the bus conflict and the fixed last bank. A register write to
  // $8000-$FFFF latches `cpu_value & rom_value`, where rom_value is the
  // byte at the write address in the currently-mapped 16 KiB bank at
  // $8000-$BFFF. bits 0-3 select that switchable bank; $C000-$FFFF is
  // hardwired to the last 16 KiB bank. `drops` simulates a flaky clone
  // latch by ignoring the first N non-zero selects (leaving bank 0).
  class UxromBus implements NesBus {
    private prgBank = 0;
    private readonly prg: Uint8Array;
    private readonly numBanks: number;
    private drops: number;
    constructor(prg: Uint8Array, drops = 0) {
      this.prg = prg;
      this.numBanks = prg.length / 0x4000;
      this.drops = drops;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      // The write resolves through whichever 16 KiB half it lands in:
      // $8000-$BFFF is the switchable bank, $C000-$FFFF the fixed last bank.
      const physBank = addr < 0xc000 ? this.prgBank : this.numBanks - 1;
      const romByte = this.prg[physBank * 0x4000 + (addr & 0x3fff)] ?? 0xff;
      const latched = value & romByte;
      if (latched !== 0 && this.drops > 0) {
        this.drops--; // dropped latch: register keeps its old value
        return;
      }
      this.prgBank = latched & 0x0f;
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      expect(length).toBe(0x4000); // only the switchable $8000-$BFFF window
      const off = this.prgBank * 0x4000;
      return this.prg.slice(off, off + length);
    }
  }

  it("dumps all eight 16 KiB PRG banks (UNROM, 128 KiB)", async () => {
    const prg = imageWithGate(128 * 1024);
    const out = await uxrom.dumpPrgRom(new UxromBus(prg), 128);
    expectSameBytes(out, prg);
  });

  it("dumps all sixteen 16 KiB PRG banks (UOROM, 256 KiB)", async () => {
    const prg = imageWithGate(256 * 1024);
    const out = await uxrom.dumpPrgRom(new UxromBus(prg), 256);
    expectSameBytes(out, prg);
  });

  it("recovers from a dropped bank-select via the bank-0 retry", async () => {
    const prg = imageWithGate(128 * 1024);
    // Drop the first real select: it reads back as bank 0, and
    // readBankWithRetry re-issues it from bank 0.
    const out = await uxrom.dumpPrgRom(new UxromBus(prg, 1), 128);
    expectSameBytes(out, prg);
  });

  it("returns an empty CHR dump for CHR-RAM carts (size 0)", async () => {
    const out = await uxrom.dumpChrRom({} as NesBus, 0);
    expect(out.length).toBe(0);
  });
});

describe("BF909x (mapper 71)", () => {
  // Models the BF9093/BF9097 boards and THROWS on the two write-hazards
  // the dumper must never hit: $8000-$9FFF (BF9097's one-screen mirroring
  // latch) and $E000-$FFFF (the CIC-stun latch present on all BF909x
  // boards) — leaving $A000-$DFFF, of which only $C000-$DFFF is asserted
  // as the bank-register decode the dumper may use. A write latches the
  // exact value (74HC02-buffered, no bus conflict). `drops` simulates a
  // flaky latch by ignoring the first N non-zero selects (leaving bank 0).
  class Bf909xBus implements NesBus {
    private prgBank = 0;
    private readonly prg: Uint8Array;
    private drops: number;
    constructor(prg: Uint8Array, drops = 0) {
      this.prg = prg;
      this.drops = drops;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      if (addr >= 0x8000 && addr <= 0x9fff) {
        throw new Error(
          "$8000-$9FFF is BF9097's mirroring latch — the dumper must not write it",
        );
      }
      if (addr >= 0xe000) {
        throw new Error(
          "$E000-$FFFF drives the CIC-stun latch — the dumper must not write it",
        );
      }
      expect(addr).toBeGreaterThanOrEqual(0xc000); // the bank register decode
      const bank = value & 0x0f;
      if (bank !== 0 && this.drops > 0) {
        this.drops--; // dropped latch: register keeps its old value
        return;
      }
      this.prgBank = bank;
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      expect(length).toBe(0x4000); // only the switchable $8000-$BFFF window
      const off = this.prgBank * 0x4000;
      return this.prg.slice(off, off + length);
    }
  }

  it("dumps all sixteen 16 KiB PRG banks via $C000 (BF9093, 256 KiB)", async () => {
    const prg = makeImage(256 * 1024);
    const out = await bf909x.dumpPrgRom(new Bf909xBus(prg), 256);
    expectSameBytes(out, prg);
  });

  it("recovers from a dropped bank-select via the bank-0 retry", async () => {
    const prg = makeImage(128 * 1024);
    // Drop the first real select: it reads back as bank 0, and
    // readBankWithRetry re-issues it from the 0x00 home write.
    const out = await bf909x.dumpPrgRom(new Bf909xBus(prg, 1), 128);
    expectSameBytes(out, prg);
  });

  it("returns an empty CHR dump for CHR-RAM carts (size 0)", async () => {
    const out = await bf909x.dumpChrRom({} as NesBus, 0);
    expect(out.length).toBe(0);
  });

  it("throws if asked to dump CHR-ROM (BF909x is CHR-RAM)", async () => {
    await expect(bf909x.dumpChrRom({} as NesBus, 8)).rejects.toThrow(
      /CHR-RAM/,
    );
  });
});

describe("CxROM (mapper 3)", () => {
  // CxROM has a fixed PRG window (no banking) and switchable 8 KiB CHR
  // banks. The register lives in PRG space, so a write latches
  // `cpu_value & rom_value`, where rom_value is the byte at the write
  // address in the fixed PRG image. The latched value is the CHR bank.
  // `drops` simulates a flaky clone latch by ignoring the first N
  // non-zero selects (leaving the cart on CHR bank 0).
  class CxromBus implements NesBus {
    private chrBank = 0;
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    private drops: number;
    constructor(prg: Uint8Array, chr: Uint8Array, drops = 0) {
      this.prg = prg;
      this.chr = chr;
      this.drops = drops;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      // PRG is fixed: the gate byte comes from the single PRG image.
      const romByte = this.prg[addr - 0x8000] ?? 0xff;
      const latched = value & romByte;
      if (latched !== 0 && this.drops > 0) {
        this.drops--; // dropped latch: register keeps its old value
        return;
      }
      this.chrBank = latched;
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      // Flat, fixed PRG window — never banked.
      return this.prg.slice(0, length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      const off = this.chrBank * 0x2000;
      return this.chr.slice(off, off + length);
    }
  }

  it("dumps the flat fixed PRG window", async () => {
    const prg = makeImage(32 * 1024);
    const out = await cxrom.dumpPrgRom(
      new CxromBus(prg, new Uint8Array(0)),
      32,
    );
    expectSameBytes(out, prg);
  });

  it("dumps all four 8 KiB CHR banks", async () => {
    const prg = imageWithGate(32 * 1024); // PRG carries the write gate
    const chr = makeImage(32 * 1024); // 4 banks of 8 KiB
    const out = await cxrom.dumpChrRom(new CxromBus(prg, chr), 32);
    expectSameBytes(out, chr);
  });

  it("recovers from a dropped CHR bank-select via the bank-0 retry", async () => {
    const prg = imageWithGate(32 * 1024);
    const chr = makeImage(32 * 1024);
    // Drop the first real select: that bank reads back as CHR bank 0, and
    // readBankWithRetry re-issues it from the conflict-immune 0x00 write.
    const out = await cxrom.dumpChrRom(new CxromBus(prg, chr, 1), 32);
    expectSameBytes(out, chr);
  });
});

describe("AxROM (mapper 7)", () => {
  // Models the bus conflict: a register write latches `cpu_value &
  // rom_value`, where rom_value is the byte at the write address in the
  // currently-mapped PRG bank. Register: bits 0-2 = 32 KiB PRG bank; the
  // select value is the bank index itself. (bit 4 is 1-screen mirroring,
  // which does not affect dumped content.) `drops` simulates a flaky clone
  // latch by ignoring the first N non-zero selects (leaving the cart on
  // bank 0). CHR is RAM, so there is nothing to read on the PPU bus.
  class AxromBus implements NesBus {
    private prgBank = 0;
    private readonly prg: Uint8Array;
    private drops: number;
    constructor(prg: Uint8Array, drops = 0) {
      this.prg = prg;
      this.drops = drops;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      const romByte = this.prg[this.prgBank * 0x8000 + (addr - 0x8000)] ?? 0xff;
      const latched = value & romByte;
      if (latched !== 0 && this.drops > 0) {
        this.drops--; // dropped latch: register keeps its old value
        return;
      }
      this.prgBank = latched & 0x07;
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      const off = this.prgBank * 0x8000;
      return this.prg.slice(off, off + length);
    }
  }

  it("dumps all eight 32 KiB PRG banks via the direct bank index", async () => {
    const prg = imageWithGate(256 * 1024); // 8 banks of 32 KiB
    const out = await axrom.dumpPrgRom(new AxromBus(prg), 256);
    expectSameBytes(out, prg);
  });

  it("recovers from a dropped bank-select via the bank-0 retry", async () => {
    const prg = imageWithGate(256 * 1024);
    // Drop the first real select: it reads back as bank 0, and
    // readBankWithRetry re-issues it from bank 0.
    const out = await axrom.dumpPrgRom(new AxromBus(prg, 1), 256);
    expectSameBytes(out, prg);
  });

  it("returns an empty CHR dump (CHR-RAM cart)", async () => {
    const out = await axrom.dumpChrRom(new AxromBus(new Uint8Array(0)), 0);
    expect(out.length).toBe(0);
  });
});

describe("readChrBankLatched seam (fused-CHR devices)", () => {
  // A device whose firmware fuses the CHR bank-select write and the read
  // into one operation (like the RetroBlaster's 0x67) exposes no standalone
  // readPpu — only readChrBankLatched. The shared bus-conflict CHR-ROM
  // mappers must dump through this path too, not just the readPpu fallback.
  class FusedChrBus implements NesBus {
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    constructor(prg: Uint8Array, chr: Uint8Array) {
      this.prg = prg;
      this.chr = chr;
    }
    async setup() {}
    async writeCpu() {}
    async readCpu(_addr: number, length: number) {
      // PRG bank 0, read once as the bus-conflict gate source.
      return this.prg.slice(0, length);
    }
    async readChrBankLatched(
      selectValue: number,
      _bank0: Uint8Array,
      length: number,
    ) {
      // GxROM latches the CHR bank in bits 1-0 of the written value.
      const off = (selectValue & 0x03) * 0x2000;
      return this.chr.slice(off, off + length);
    }
    // intentionally no readPpu — forces the fused-capability path
  }

  it("dumps GxROM CHR through the fused capability, no readPpu", async () => {
    const prg = imageWithGate(32 * 1024);
    const chr = makeImage(32 * 1024); // 4 banks of 8 KiB
    const out = await gxrom.dumpChrRom(new FusedChrBus(prg, chr), 32);
    expectSameBytes(out, chr);
  });
});

describe("RAMBO-1 (mapper 64)", () => {
  // RAMBO-1 dumps through the shared MMC3 core. This models the
  // MMC3-compatible registers it uses for dumping — R6 (8 KiB PRG at $8000)
  // and R0/R1 (CHR, 1 KiB units → 2 KiB windows) — and ASSERTS $A001 is
  // never written: unlike MMC3, RAMBO-1 has no PRG-RAM control register, so
  // a stray write there would be a bug (the reason RAMBO-1 has its own init).
  class Rambo1Bus implements NesBus {
    private select = 0;
    private r = new Array<number>(16).fill(0);
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    constructor(prg: Uint8Array, chr: Uint8Array) {
      this.prg = prg;
      this.chr = chr;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      if (addr === 0xa001) {
        throw new Error(
          "RAMBO-1 has no $A001 PRG-RAM register — the dumper must not write it",
        );
      }
      if (addr === 0x8000)
        this.select = value & 0x0f; // 4-bit command
      else if (addr === 0x8001) this.r[this.select] = value;
      // $A000 (mirroring) is a no-op for content reads.
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      expect(length).toBe(8 * 1024);
      const off = this.r[6] * 0x2000;
      return this.prg.slice(off, off + length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      expect(length).toBe(4 * 1024);
      const b0 = (this.r[0] >> 1) * 0x800;
      const b1 = (this.r[1] >> 1) * 0x800;
      const out = new Uint8Array(length);
      out.set(this.chr.slice(b0, b0 + 0x800), 0);
      out.set(this.chr.slice(b1, b1 + 0x800), 0x800);
      return out;
    }
  }

  it("walks all PRG banks via R6, never touching $A001 (64 KiB)", async () => {
    const prg = makeImage(64 * 1024); // 8 banks of 8 KiB
    const out = await rambo1.dumpPrgRom(
      new Rambo1Bus(prg, new Uint8Array(0)),
      64,
    );
    expectSameBytes(out, prg);
  });

  it("walks CHR via R0/R1 (64 KiB)", async () => {
    const chr = makeImage(64 * 1024);
    const out = await rambo1.dumpChrRom(
      new Rambo1Bus(new Uint8Array(0), chr),
      64,
    );
    expectSameBytes(out, chr);
  });

  it("throws a clear error when the bus has no PPU read", async () => {
    const noPpu: NesBus = {
      setup: async () => {},
      writeCpu: async () => {},
      readCpu: async () => new Uint8Array(0),
    };
    await expect(rambo1.dumpChrRom(noPpu, 64)).rejects.toThrow(/PPU-bus/);
  });
});

describe("DxROM (mapper 206)", () => {
  // DxROM dumps through the shared MMC3 core. This models the chip's
  // narrower decode and THROWS on any write outside $8000-$9FFF: the real
  // ASIC has no registers in $A000-$FFFF, so a stray MMC3-style mirroring
  // or PRG-RAM write would be a bug (the reason mapper 206 has its own
  // init). It also asserts every written value stays within the bits the
  // chip decodes: select is 3 bits (MMC3's PRG-mode / CHR-inversion bits
  // don't exist), data is 6 bits.
  class DxromBus implements NesBus {
    private select = 0;
    private r = new Array<number>(8).fill(0);
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    constructor(prg: Uint8Array, chr: Uint8Array) {
      this.prg = prg;
      this.chr = chr;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      if (addr < 0x8000 || addr > 0x9fff) {
        throw new Error(
          "DxROM has no registers outside $8000-$9FFF — the dumper must not write there",
        );
      }
      if ((addr & 1) === 0) {
        expect(value & 0xf8).toBe(0); // bits 3-7 don't exist on this chip
        this.select = value & 0x07;
      } else {
        expect(value & 0xc0).toBe(0); // data is 6 bits wide
        this.r[this.select] = value & 0x3f;
      }
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      expect(length).toBe(8 * 1024);
      const off = (this.r[6] & 0x0f) * 0x2000; // R6/R7 decode 4 bits
      return this.prg.slice(off, off + length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      expect(length).toBe(4 * 1024);
      // R0/R1 are 2 KiB banks counted in 1 KiB units with no bit 0 — only
      // even positions exist, same as MMC3's low-bit-ignored behavior.
      const b0 = (this.r[0] >> 1) * 0x800;
      const b1 = (this.r[1] >> 1) * 0x800;
      const out = new Uint8Array(length);
      out.set(this.chr.slice(b0, b0 + 0x800), 0);
      out.set(this.chr.slice(b1, b1 + 0x800), 0x800);
      return out;
    }
  }

  it("walks all PRG banks via R6, writing only $8000/$8001 (128 KiB)", async () => {
    const prg = makeImage(128 * 1024); // 16 banks of 8 KiB — the PRG cap
    const out = await dxrom.dumpPrgRom(
      new DxromBus(prg, new Uint8Array(0)),
      128,
    );
    expectSameBytes(out, prg);
  });

  it("dumps a 32 KiB unbanked board (submapper 1) as a flat $8000-$FFFF read", async () => {
    // The common 32 KiB boards (the 3407/3417/3451 PCBs) wire CPU A13/A14
    // straight to PRG-ROM, so R6/R7 have no effect. This model exposes the
    // whole 32 KiB only through a single flat $8000 read and ignores any
    // bank-register write — so an R6 walk (which reads 8 KiB windows) would
    // fail the length assertion, and the flat-read path must be used.
    const prg = makeImage(32 * 1024);
    const bus: NesBus = {
      setup: async () => {},
      writeCpu: async (addr) => {
        if (addr < 0x8000 || addr > 0x9fff) {
          throw new Error("DxROM writes only $8000-$9FFF");
        }
      },
      readCpu: async (addr, length) => {
        expect(addr).toBe(0x8000);
        expect(length).toBe(32 * 1024); // one flat window, not an 8 KiB walk
        return prg.slice(0, length);
      },
    };
    const out = await dxrom.dumpPrgRom(bus, 32);
    expectSameBytes(out, prg);
  });

  it("walks CHR via R0/R1 up to the 64 KiB cap (data stays within 6 bits)", async () => {
    const chr = makeImage(64 * 1024); // the last stride writes R1 = $3E
    const out = await dxrom.dumpChrRom(
      new DxromBus(new Uint8Array(0), chr),
      64,
    );
    expectSameBytes(out, chr);
  });

  it("throws a clear error when the bus has no PPU read", async () => {
    const noPpu: NesBus = {
      setup: async () => {},
      writeCpu: async () => {},
      readCpu: async () => new Uint8Array(0),
    };
    await expect(dxrom.dumpChrRom(noPpu, 64)).rejects.toThrow(/PPU-bus/);
  });
});

describe("FME-7 (mapper 69)", () => {
  // Models the two-write command/parameter protocol: $8000-$9FFF latches the
  // command (low 4 bits), $A000-$BFFF invokes it with the parameter. Eight
  // 1 KiB CHR windows (commands $0-$7), 8 KiB PRG bank at $8000 via $9, and
  // the command-$8 $6000 window — RAM only when bits 7+6 are both set
  // ($C0|bank), open bus when RAM is selected but disabled ($40-$7F), a ROM
  // bank otherwise. The model THROWS on the two write-hazards the dumper
  // must never hit: IRQ commands $D-$F, and any CPU write at or above $C000
  // (the 5B's expansion-audio ports live there). `drops` simulates a
  // flaky latch by ignoring the first N non-zero PRG bank parameters.
  class Fme7Bus implements NesBus {
    private command = 0;
    private r = new Array<number>(13).fill(0); // commands $0-$C
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    private readonly wram: Uint8Array;
    private drops: number;
    constructor(
      prg: Uint8Array,
      chr: Uint8Array,
      wram = new Uint8Array(0),
      drops = 0,
    ) {
      this.prg = prg;
      this.chr = chr;
      this.wram = wram;
      this.drops = drops;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      if (addr >= 0xc000) {
        throw new Error(
          "CPU write at/above $C000 — the 5B's audio ports; the dumper must not write here",
        );
      }
      if (addr < 0xa000) {
        expect(addr).toBeGreaterThanOrEqual(0x8000);
        this.command = value & 0x0f;
        return;
      }
      if (this.command >= 0x0d) {
        throw new Error(
          "IRQ command $D-$F invoked — the dumper must not touch the IRQ registers",
        );
      }
      if (this.command === 0x09 && value !== 0 && this.drops > 0) {
        this.drops--; // dropped latch: register keeps its old value
        return;
      }
      this.r[this.command] = value;
    }
    async readCpu(addr: number, length: number) {
      expect(length).toBe(8 * 1024);
      if (addr === 0x6000) {
        const reg8 = this.r[0x08];
        // Bit 6 selects RAM, bit 7 enables the chip; both → WRAM (the
        // single 8 KiB chip on real carts ignores the bank bits).
        if ((reg8 & 0xc0) === 0xc0) return this.wram.slice(0, length);
        // RAM selected but disabled → open bus.
        if (reg8 & 0x40) return new Uint8Array(length).fill(0xff);
        const off = (reg8 & 0x3f) * 0x2000;
        return this.prg.slice(off, off + length);
      }
      expect(addr).toBe(0x8000);
      const off = this.r[0x09] * 0x2000;
      return this.prg.slice(off, off + length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      expect(length).toBe(8 * 1024);
      // Each of the eight 1 KiB windows resolves independently.
      const out = new Uint8Array(length);
      for (let w = 0; w < 8; w++) {
        const off = this.r[w] * 0x400;
        out.set(this.chr.slice(off, off + 0x400), w * 0x400);
      }
      return out;
    }
  }

  it("walks all PRG banks via command $9 (128 KiB)", async () => {
    const prg = makeImage(128 * 1024); // 16 banks of 8 KiB
    const out = await fme7.dumpPrgRom(new Fme7Bus(prg, new Uint8Array(0)), 128);
    expectSameBytes(out, prg);
  });

  it("walks CHR through the eight 1 KiB windows (256 KiB)", async () => {
    const chr = makeImage(256 * 1024);
    const out = await fme7.dumpChrRom(new Fme7Bus(new Uint8Array(0), chr), 256);
    expectSameBytes(out, chr);
  });

  it("brackets the save read: $C0 exposes WRAM, $00 re-disables it after", async () => {
    const prg = makeImage(16 * 1024);
    // Inverted so WRAM can't collide with ROM bank 0 (makeImage is
    // deterministic — a plain 8 KiB image would equal PRG's first bank).
    const wram = Uint8Array.from(makeImage(8 * 1024), (b) => b ^ 0xff);
    const bus = new Fme7Bus(prg, new Uint8Array(0), wram);
    const out = await fme7.dumpSave!(bus, 8);
    expectSameBytes(out, wram);
    // The trailing $00 must have re-parked the window ROM-side (RAM
    // chip-disabled), so $6000 reads ROM bank 0 again — not the WRAM.
    expectSameBytes(
      await bus.readCpu(0x6000, 8 * 1024),
      prg.slice(0, 8 * 1024),
    );
  });

  it("recovers from a dropped PRG bank latch via the bank-0 retry", async () => {
    const prg = makeImage(128 * 1024);
    const out = await fme7.dumpPrgRom(
      new Fme7Bus(prg, new Uint8Array(0), new Uint8Array(0), 1),
      128,
    );
    expectSameBytes(out, prg);
  });

  it("returns an empty CHR dump for CHR-RAM carts (size 0)", async () => {
    const out = await fme7.dumpChrRom({} as NesBus, 0);
    expect(out.length).toBe(0);
  });

  it("throws a clear error when the bus has no PPU read", async () => {
    const noPpu: NesBus = {
      setup: async () => {},
      writeCpu: async () => {},
      readCpu: async () => new Uint8Array(0),
    };
    await expect(fme7.dumpChrRom(noPpu, 128)).rejects.toThrow(/PPU-bus/);
  });
});

describe("Quattro (mapper 232)", () => {
  // Two-register BF9096 multicart, modeled WITH a bus conflict on both
  // registers (the gate path must work either way). $8000-$BFFF latches
  // `value & rom` → block in bits 4-3; $C000-$FFFF latches `value & rom` →
  // page in bits 1-0. The $8000 window maps block*4+page; the $C000 window
  // is fixed to block*4+3. The rom gate byte for a write comes from whichever
  // 16 KiB window the address lands in. `drops` simulates a flaky latch by
  // ignoring the first N non-zero PAGE selects, leaving page 0 — which on
  // block 0 reads back as bank 0, the recoverable dropout.
  class QuattroBus implements NesBus {
    private block = 0;
    private page = 0;
    private readonly prg: Uint8Array;
    private drops: number;
    constructor(prg: Uint8Array, drops = 0) {
      this.prg = prg;
      this.drops = drops;
    }
    async setup() {}
    private bankIn(window: 0 | 1): number {
      // 0 = $8000-$BFFF (switchable), 1 = $C000-$FFFF (fixed last page)
      return window === 0 ? this.block * 4 + this.page : this.block * 4 + 3;
    }
    async writeCpu(addr: number, value: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      const window = addr < 0xc000 ? 0 : 1;
      const romByte = this.prg[this.bankIn(window) * 0x4000 + (addr & 0x3fff)];
      const latched = value & (romByte ?? 0xff);
      if (window === 0) {
        // submapper 1: D4 = block bit 0, D3 = block bit 1 (swapped order)
        this.block = (((latched >> 3) & 1) << 1) | ((latched >> 4) & 1);
      } else {
        const newPage = latched & 0x03;
        if (newPage !== 0 && this.drops > 0) {
          this.drops--; // dropped page latch: register keeps its old value
          return;
        }
        this.page = newPage;
      }
    }
    async readCpu(addr: number, length: number) {
      expect(length).toBe(0x4000); // 16 KiB window
      const window = addr === 0x8000 ? 0 : addr === 0xc000 ? 1 : -1;
      expect(window).not.toBe(-1);
      const off = this.bankIn(window as 0 | 1) * 0x4000;
      return this.prg.slice(off, off + length);
    }
  }

  it("dumps all sixteen 16 KiB banks across four blocks (256 KiB)", async () => {
    const prg = imageWithGatePerBank(256 * 1024, 0x4000);
    const out = await quattro.dumpPrgRom(new QuattroBus(prg), 256);
    expectSameBytes(out, prg);
  });

  it("recovers from a dropped page select via the bank-0 retry", async () => {
    const prg = imageWithGatePerBank(256 * 1024, 0x4000);
    // Drop the first non-zero page select (block 0, page 1): it reads back as
    // bank 0, and readBankWithRetry re-issues the select and re-reads.
    const out = await quattro.dumpPrgRom(new QuattroBus(prg, 1), 256);
    expectSameBytes(out, prg);
  });

  it("returns an empty CHR dump for the CHR-RAM cart (size 0)", async () => {
    const out = await quattro.dumpChrRom({} as NesBus, 0);
    expect(out.length).toBe(0);
  });

  it("throws if asked to dump CHR-ROM (Quattro is CHR-RAM)", async () => {
    await expect(quattro.dumpChrRom({} as NesBus, 8)).rejects.toThrow(
      /CHR-RAM/,
    );
  });
});

describe("Mapper 268 (Mindkids / CoolBoy)", () => {
  /**
   * Models the Mindkids variant (submapper 1) from the silicon side: outer
   * registers at $5000-$5003, GNROM-mode decode per the nesdev bit layout.
   * The bank decode inverts the register *layout spec* (which bit field
   * carries which PRG address line), not the mapper's packing math, so a
   * packing bug shows up as a wrong-bank read.
   *
   * `glitchBank = N` makes bank N's first read return one corrupted byte
   * (subsequent reads clean) — the transient bank-substitution glitch the
   * consensus read recovers from.
   */
  class MindkidsBus implements NesBus {
    private regs = [0, 0, 0, 0];
    private glitched = false;
    glitchBank = -1;
    readonly writes: Array<[number, number]> = [];
    private readonly flash: Uint8Array;
    constructor(flash: Uint8Array) {
      this.flash = flash;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      this.writes.push([addr, value]);
      if (addr >= 0x5000 && addr <= 0x5fff) {
        this.regs[addr & 3] = value;
      } else {
        throw new Error(`unexpected CPU write $${addr.toString(16)}`);
      }
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      const [r0, r1, , r3] = this.regs;
      // The walk's invariants: GNROM engaged, A17/A18 masks cleared, r2 = 0.
      expect(r3 & 0x10).toBeTruthy();
      expect(r0 & 0x40).toBeTruthy();
      expect(r1 & 0x80).toBeTruthy();
      expect(this.regs[2]).toBe(0);
      // Spec-side decode: QQ=r3[3..1] → A14-16, EEE=r0[2..0] → A17-19,
      // J=r1[4] → A20, KK=r1[3..2] → A22/A21, CC=r0[5..4] → A23/A24.
      const bank =
        ((r3 >> 1) & 7) |
        ((r0 & 7) << 3) |
        (((r1 >> 4) & 1) << 6) |
        (((r1 >> 2) & 3) << 7) |
        (((r0 >> 4) & 3) << 9);
      const off = (bank * 0x4000) % this.flash.length;
      const window = this.flash.slice(off, off + length);
      if (this.glitchBank === bank && !this.glitched) {
        this.glitched = true;
        window[0] ^= 0xff; // one transient corrupted read
      }
      return window;
    }
  }

  /** Run a dump with the per-write settle timers virtualised. */
  async function dump(
    bus: NesBus,
    sizeKB: number,
    mapper = mapper268Mindkids,
  ): Promise<Uint8Array> {
    vi.useFakeTimers();
    try {
      const p = mapper.dumpPrgRom(bus, sizeKB);
      await vi.runAllTimersAsync();
      return await p;
    } finally {
      vi.useRealTimers();
    }
  }

  it("walks all 128 GNROM banks of a 2 MiB cart byte-exact", async () => {
    const flash = makeImage(2048 * 1024);
    const out = await dump(new MindkidsBus(flash), 2048);
    expectSameBytes(out, flash);
  });

  it("issues the exact two-phase register sequence per bank", async () => {
    const bus = new MindkidsBus(makeImage(32 * 1024)); // 2 banks
    await dump(bus, 32);
    // Bank 1: phase 1 carries the menu's transitional $5001=$90/$5003=$00
    // with the final r0; phase 2 commits r0=$40, r1=$80, r3=$12.
    expect(bus.writes.slice(8, 16)).toEqual([
      [0x5000, 0x40],
      [0x5001, 0x90],
      [0x5002, 0x00],
      [0x5003, 0x00],
      [0x5000, 0x40],
      [0x5001, 0x80],
      [0x5002, 0x00],
      [0x5003, 0x12],
    ]);
    // bank 0 + bank 1, 8 writes each, nothing else (no post-walk recheck).
    expect(bus.writes).toHaveLength(16);
  });

  it("recovers a transient bank glitch via consensus", async () => {
    const flash = makeImage(128 * 1024); // 8 banks
    const bus = new MindkidsBus(flash);
    bus.glitchBank = 2;
    const out = await dump(bus, 128);
    expectSameBytes(out, flash); // the corrupted read never reaches the dump
  });

  it("returns an empty CHR dump (CHR-RAM-only submapper)", async () => {
    const out = await mapper268Mindkids.dumpChrRom({} as NesBus, 0);
    expect(out.length).toBe(0);
  });

  it("CoolBoy (submapper 0) drives the $6000 outer-register block", async () => {
    // The only behavioural difference from the Mindkids variant is the
    // outer-register base; pin that the submapper-0 export targets $6000.
    const writes: number[] = [];
    const flash = makeImage(512 * 1024);
    const bus: NesBus = {
      setup: async () => {},
      writeCpu: async (addr) => {
        writes.push(addr);
      },
      readCpu: async (_addr, length) => flash.slice(0, length),
    };
    const out = await dump(bus, 512, mapper268Coolboy);
    expect(out.length).toBe(512 * 1024);
    expect(writes.some((a) => a >= 0x6000 && a <= 0x6003)).toBe(true);
    expect(writes.some((a) => a >= 0x5000 && a <= 0x5003)).toBe(false);
  });
});

describe("Mapper 470 (INX_007T_V01)", () => {
  /**
   * Evidence-matched (pessimistic) board model: the inner ($8000) bank
   * latch does NOT survive any bus idle, so it is usable only inside the
   * fused `readCpuBankLatched` call; a plain readCpu always serves the
   * power-on default inner bank (0) because the latch decayed in the gap
   * after the writeCpu transaction. This is the failure signature the
   * real cart produced against a split write-then-read walk: whole banks
   * of default-bank content. The outer ($5000) latch holds — also
   * observed on the real cart.
   */
  class InlRomFusedBus implements NesBus {
    private outer = 0;
    readonly fusedCalls: Array<[number, number, number, number]> = [];
    private readonly flash: Uint8Array;
    constructor(flash: Uint8Array) {
      this.flash = flash;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      if (addr === 0x5000) this.outer = value & 3;
      // $8000 writes latch... and decay before any later transaction.
    }
    private window(inner: number, addr: number, length: number) {
      const off = this.outer * 0x40000 + inner * 0x8000 + (addr - 0x8000);
      return this.flash.slice(off, off + length);
    }
    async readCpu(addr: number, length: number) {
      return this.window(0, addr, length); // latch long gone: default bank
    }
    async readCpuBankLatched(
      latchAddr: number,
      latchValue: number,
      addr: number,
      length: number,
    ) {
      expect(latchAddr).toBe(0x8000);
      this.fusedCalls.push([latchAddr, latchValue, addr, length]);
      return this.window(latchValue & 7, addr, length);
    }
  }

  /**
   * Optimistic board model for the split fallback: the inner latch
   * survives the write-to-read idle gap but decays after every readCpu
   * transaction. Validates the fallback's addressing and re-latch
   * cadence — NOT hardware viability, which the pessimistic model above
   * shows requires the fused capability.
   */
  class InlRomSplitBus implements NesBus {
    private outer = 0;
    private inner = 0; // power-on default
    readonly innerWrites: number[] = [];
    private readonly flash: Uint8Array;
    constructor(flash: Uint8Array) {
      this.flash = flash;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      if (addr === 0x5000) {
        this.outer = value & 3;
      } else if (addr === 0x8000) {
        this.innerWrites.push(value);
        this.inner = value & 7; // board decodes the low 3 bits
      } else {
        throw new Error(`unexpected write $${addr.toString(16)}`);
      }
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      const off = this.outer * 0x40000 + this.inner * 0x8000 + (addr - 0x8000);
      const win = this.flash.slice(off, off + length);
      this.inner = 0; // the latch decays at the end of every transaction
      return win;
    }
  }

  it("dumps byte-exact through the fused latch+read on a latch that dies at every idle", async () => {
    const flash = makeImage(1024 * 1024);
    const bus = new InlRomFusedBus(flash);
    const out = await mapper470.dumpPrgRom(bus, 1024);
    expectSameBytes(out, flash);
  });

  it("issues the vendor's exact fused-call stream: global bank index, 2 KiB chunks", async () => {
    const bus = new InlRomFusedBus(makeImage(1024 * 1024));
    await mapper470.dumpPrgRom(bus, 1024);
    // 32 banks x 16 chunks of 2 KiB, each call latching $8000 with the
    // GLOBAL 32 KiB bank index (0-31) — the value stream the vendor's
    // hardware-validated routine emits.
    const expected: Array<[number, number, number, number]> = [];
    for (let g = 0; g < 32; g++) {
      for (let off = 0; off < 0x8000; off += 0x800) {
        expected.push([0x8000, g, 0x8000 + off, 0x800]);
      }
    }
    expect(bus.fusedCalls).toEqual(expected);
  });

  it("documents why the fused capability exists: the split walk dies on the same board", async () => {
    // Strip the capability so the mapper falls back to split write+read
    // against the pessimistic model: every bank comes back as its
    // outer's default (inner-0) bank — the real cart's dead-dump
    // signature, NOT the flash content.
    const flash = makeImage(1024 * 1024);
    const bus = new InlRomFusedBus(flash);
    (bus as { readCpuBankLatched?: unknown }).readCpuBankLatched = undefined;
    const out = await mapper470.dumpPrgRom(bus, 1024);
    expect(bytesEqual(out, flash)).toBe(false);
    for (let outer = 0; outer < 4; outer++) {
      const defaultBank = flash.subarray(
        outer * 0x40000,
        outer * 0x40000 + 0x8000,
      );
      for (let inner = 0; inner < 8; inner++) {
        const start = (outer * 8 + inner) * 0x8000;
        expectSameBytes(out.subarray(start, start + 0x8000), defaultBank);
      }
    }
  });

  it("split fallback is byte-exact when the latch survives the write-to-read gap", async () => {
    const flash = makeImage(1024 * 1024);
    const out = await mapper470.dumpPrgRom(new InlRomSplitBus(flash), 1024);
    expectSameBytes(out, flash);
  });

  it("split fallback re-latches the global bank index before every 4 KiB sub-read", async () => {
    const bus = new InlRomSplitBus(makeImage(1024 * 1024));
    await mapper470.dumpPrgRom(bus, 1024);
    // 32 banks x 8 sub-reads, each preceded by a re-latch carrying the
    // global 32 KiB bank index — pins both the value stream and the
    // re-latch cadence of the fallback path.
    const expected = Array.from({ length: 32 }, (_, g) =>
      new Array<number>(8).fill(g),
    ).flat();
    expect(bus.innerWrites).toEqual(expected);
  });

  it("rejects any PRG size but the board's 1024 KiB", async () => {
    await expect(
      mapper470.dumpPrgRom(new InlRomSplitBus(makeImage(1024 * 1024)), 512),
    ).rejects.toThrow(/1024 KiB/);
  });

  it("returns an empty CHR dump (CHR-RAM board)", async () => {
    const out = await mapper470.dumpChrRom({} as NesBus, 0);
    expect(out.length).toBe(0);
  });
});

describe("Mapper 413 (BATMAP)", () => {
  const PRG = 256 * 1024;
  const CHR = 256 * 1024;
  const MISC = 8 * 1024 * 1024;

  /**
   * Faithful model of the board's CPLD-SPI bridge (hardware-validated
   * protocol, 2026-06-13): $D000 bit 0 = /CS (an $01,$00 arm pulse
   * begins frame capture); $C000 writes shift one command bit each; a
   * 32-bit 0x03+addr24 frame opens the flash's streaming read; in data
   * phase ($D000=$02) every cart-addressed READ clocks one SPI bit
   * (halting at 8), and a $C000 read latches the byte, re-arms the
   * counter, and — like the real CPLD — itself contributes a clock.
   * The first port read after a frame returns pipeline junk (0xff).
   * `clocksPerByte` lets a test model an under-clocking device. Any
   * write to the $8000-$BFFF IRQ block throws: the dump must never
   * touch it.
   */
  class SrrSpiBus implements NesBus {
    private readonly regs = [0, 0, 0, 0];
    private control = 0;
    private csPulsed = false;
    private capturing = false;
    private frameBits: number[] = [];
    private framed = false;
    private flashBitPos = 0;
    private bitsClocked = 0;
    private latch = 0;
    private armed = false;
    readonly framesOpened: number[] = [];
    private readonly clocksPerByte: number;
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    private readonly flash: Uint8Array;
    constructor(
      prg: Uint8Array,
      chr: Uint8Array,
      flash: Uint8Array,
      opts: { clocksPerByte?: number } = {},
    ) {
      this.prg = prg;
      this.chr = chr;
      this.flash = flash;
      this.clocksPerByte = opts.clocksPerByte ?? 8;
    }
    async setup() {}

    async writeCpu(addr: number, value: number) {
      const page = addr & 0xf000;
      if (page === 0xe000 || page === 0xf000) {
        this.regs[value >> 6] = value & 0x3f;
      } else if (page === 0xd000) {
        if (value & 0x01) {
          this.csPulsed = true;
        } else if (this.csPulsed && !(value & 0x02)) {
          // $01 then $00: begin a fresh frame capture
          this.capturing = true;
          this.frameBits = [];
          this.framed = false;
          this.armed = false;
          this.csPulsed = false;
        }
        this.control = value;
      } else if (page === 0xc000) {
        if (this.capturing) {
          this.frameBits.push(value >> 7);
          if (this.frameBits.length === 32) {
            const word = this.frameBits.reduce((acc, b) => (acc << 1) | b, 0);
            const cmd = (word >>> 24) & 0xff;
            expect(cmd).toBe(0x03); // only the flash READ command is valid
            const flashAddr = word & 0xffffff;
            this.flashBitPos = flashAddr * 8;
            this.framed = true;
            this.capturing = false;
            this.framesOpened.push(flashAddr);
          }
        }
      } else {
        // $8000-$BFFF is the scanline-IRQ block (or below: not a register).
        throw new Error(`unexpected write $${addr.toString(16)}`);
      }
    }

    /** One SPI clock, fired by any cart-addressed read in data phase. */
    private clock() {
      if (!(this.control & 0x02) || !this.framed || !this.armed) return;
      if (this.bitsClocked >= this.clocksPerByte || this.bitsClocked >= 8)
        return; // the CPLD's counter halts at a byte
      const bit =
        (this.flash[this.flashBitPos >> 3] >> (7 - (this.flashBitPos & 7))) & 1;
      this.latch = ((this.latch << 1) | bit) & 0xff;
      this.flashBitPos++;
      this.bitsClocked++;
    }

    /**
     * A port read returns the CURRENT shift-register window — like the
     * real CPLD, not a completeness-gated value. A well-clocked cadence
     * sees exactly the assembled byte; an under-clocked one sees stale
     * bits sheared into each byte (non-uniform garbage), which is what
     * the pre-flight overlap probe catches on hardware.
     */
    private portRead(): number {
      this.clock(); // the port read itself contributes a clock
      const out = this.armed ? this.latch : 0xff; // pre-arm read: MISO idle
      this.armed = true;
      this.bitsClocked = 0;
      return out;
    }

    // Synchronous core shared by the async bus method and the paced
    // page-read simulation — an 8 MiB dump is ~75 million bus cycles,
    // which must not each be an awaited promise (worker OOM/timeout on
    // modest hardware).
    private readByteSync(addr: number): number {
      if (addr === 0xc000 && this.control & 0x02) {
        return this.portRead();
      }
      if (addr >= 0x8000) {
        this.clock(); // cart-ROM read = one SPI clock
        return 0xa5; // arbitrary ROM byte; dummies ignore it
      }
      return 0x48; // open bus below $4800-style echo
    }

    async readCpuByte(addr: number) {
      return this.readByteSync(addr);
    }

    /** Simulates the firmware's NESCPU_SPI413 paced page read. */
    async readSpiDataPort(length: number) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        for (let j = 0; j < 8; j++) this.readByteSync(0xd000);
        out[i] = this.readByteSync(0xc000);
      }
      return out;
    }

    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000); // reg1's PRG window — the only block read
      expect(length).toBe(0x2000);
      const off = this.regs[1] * 0x2000;
      return this.prg.slice(off, off + length);
    }

    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      expect(length).toBe(0x1000);
      const off = this.regs[3] * 0x1000;
      return this.chr.slice(off, off + length);
    }
  }

  function makeBus(opts?: { clocksPerByte?: number; flash?: Uint8Array }) {
    return new SrrSpiBus(
      makeImage(PRG),
      makeImage(CHR, 1),
      opts?.flash ?? makeImage(MISC, 2),
      opts,
    );
  }

  it("dumps PRG byte-exact through the reg1 window walk", async () => {
    const prg = makeImage(PRG);
    const bus = new SrrSpiBus(prg, new Uint8Array(0), new Uint8Array(0));
    const out = await mapper413.dumpPrgRom(bus, 256);
    expectSameBytes(out, prg);
  });

  it("dumps CHR byte-exact through the reg3 window walk", async () => {
    const chr = makeImage(CHR, 1);
    const bus = new SrrSpiBus(new Uint8Array(0), chr, new Uint8Array(0));
    const out = await mapper413.dumpChrRom(bus, 256);
    expectSameBytes(out, chr);
  });

  it("dumps the 8 MiB serial flash byte-exact through the SPI frame protocol", async () => {
    const flash = makeImage(MISC, 2);
    const bus = makeBus({ flash });
    const out = await mapper413.dumpMiscRom!(bus, 8192);
    expectSameBytes(out, flash);
  });

  it("re-opens the frame per 1 MiB block, after a 3-frame probe", async () => {
    const bus = makeBus();
    await mapper413.dumpMiscRom!(bus, 8192);
    // probe: 0, 0, 4 — then one frame per 1 MiB block
    expect(bus.framesOpened).toEqual([
      0,
      0,
      4,
      ...Array.from({ length: 8 }, (_, i) => i * 1024 * 1024),
    ]);
  });

  it("probe rejects an under-clocking device within three probe frames", async () => {
    // 7 clocks per byte (6 dummies' worth + the port read) shears one
    // stale bit into every byte. The shear isn't reproducible across
    // re-opened frames (the shift register carries over), so either
    // pre-flight check — determinism or shifted-overlap — fires; what
    // matters is rejecting before the multi-minute full dump.
    const bus = makeBus({ clocksPerByte: 7 });
    await expect(mapper413.dumpMiscRom!(bus, 8192)).rejects.toThrow(
      /probe failed/,
    );
    expect(bus.framesOpened.length).toBeLessThanOrEqual(3);
  });

  it("throws a clear capability error when the bus lacks the paced SPI read", async () => {
    const bus = makeBus();
    (bus as { readSpiDataPort?: unknown }).readSpiDataPort = undefined;
    await expect(mapper413.dumpMiscRom!(bus, 8192)).rejects.toThrow(
      /paced SPI read path/,
    );
  });

  it("rejects any geometry but the board's 256/256/8192 KiB", async () => {
    await expect(mapper413.dumpPrgRom(makeBus(), 128)).rejects.toThrow(
      /256 KiB/,
    );
    await expect(mapper413.dumpChrRom(makeBus(), 128)).rejects.toThrow(
      /256 KiB/,
    );
    await expect(mapper413.dumpMiscRom!(makeBus(), 4096)).rejects.toThrow(
      /8192 KiB/,
    );
  });

  it("throws a clear error when the bus has no PPU read", async () => {
    const bus = makeBus();
    (bus as { readPpu?: unknown }).readPpu = undefined;
    await expect(mapper413.dumpChrRom(bus, 256)).rejects.toThrow(/PPU-bus/);
  });
});
