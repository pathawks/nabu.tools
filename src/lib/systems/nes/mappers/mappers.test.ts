import { describe, it, expect, vi } from "vitest";
import type { NesBus } from "../bus";
import { bytesEqual, isUniformFill } from "./bank-reliability";
import { nrom } from "./nrom";
import { mmc1 } from "./mmc1";
import { uxrom } from "./uxrom";
import { cxrom } from "./cxrom";
import { mmc2 } from "./mmc2";
import { mmc3 } from "./mmc3";
import { axrom } from "./axrom";
import { colorDreams } from "./color-dreams";
import { gxrom } from "./gxrom";
import { mapper185 } from "./mapper185";

/**
 * A deterministic, well-mixed cart image. The multiplicative hash makes
 * every aligned bank distinct (and non-uniform), so the dropout detector
 * never false-positives and bank reconstruction is exactly verifiable.
 */
function makeImage(bytes: number): Uint8Array {
  const a = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++)
    a[i] = (Math.imul(i, 2654435761) >>> 24) & 0xff;
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

describe("mapper 185 (CNROM protection diodes)", () => {
  // CNROM electrically: flat PRG, one 8 KiB CHR bank. The twist is the
  // lockout — a register write latches `cpu & rom` (bus conflict through the
  // fixed PRG image), and the CHR-ROM only drives the PPU bus when the low
  // two latched bits equal the board's `lockout` value. Any other value
  // leaves CHR disabled and the PPU read floats high (open bus, 0xFF).
  class Mapper185Bus implements NesBus {
    private latched = 0;
    private readonly prg: Uint8Array;
    private readonly chr: Uint8Array;
    private readonly lockout: number;
    constructor(prg: Uint8Array, chr: Uint8Array, lockout: number) {
      this.prg = prg;
      this.chr = chr;
      this.lockout = lockout;
    }
    async setup() {}
    async writeCpu(addr: number, value: number) {
      expect(addr).toBeGreaterThanOrEqual(0x8000);
      const romByte = this.prg[addr - 0x8000] ?? 0xff;
      this.latched = value & romByte;
    }
    async readCpu(addr: number, length: number) {
      expect(addr).toBe(0x8000);
      // Flat, fixed PRG window — never banked.
      return this.prg.slice(0, length);
    }
    async readPpu(addr: number, length: number) {
      expect(addr).toBe(0x0000);
      if ((this.latched & 0x03) !== this.lockout) {
        // CHR output disabled — PPU bus floats high.
        return new Uint8Array(length).fill(0xff);
      }
      return this.chr.slice(0, length);
    }
  }

  it("dumps the flat fixed PRG window (like NROM)", async () => {
    const prg = makeImage(32 * 1024);
    const out = await mapper185.dumpPrgRom(
      new Mapper185Bus(prg, new Uint8Array(0), 0),
      32,
    );
    expectSameBytes(out, prg);
  });

  it.each([0, 1, 2, 3])(
    "probes the lockout to release and dump the 8 KiB CHR (enable %i)",
    async (lockout) => {
      const prg = imageWithGate(32 * 1024); // PRG carries the write gate
      const chr = makeImage(8 * 1024);
      const out = await mapper185.dumpChrRom(
        new Mapper185Bus(prg, chr, lockout),
        8,
      );
      expectSameBytes(out, chr);
    },
  );

  it("warns and returns open-bus CHR when no value releases it", async () => {
    const prg = imageWithGate(32 * 1024);
    const chr = makeImage(8 * 1024);
    // A board whose decode never matches any 2-bit candidate (an unknown
    // lockout variant): every probe reads open bus.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await mapper185.dumpChrRom(new Mapper185Bus(prg, chr, 0x99), 8);
    expect(isUniformFill(out)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/mapper 185/));
    warn.mockRestore();
  });

  it("throws a clear error when the bus has no PPU read", async () => {
    const noPpu: NesBus = {
      setup: async () => {},
      writeCpu: async () => {},
      readCpu: async () => new Uint8Array(0x8000),
    };
    await expect(mapper185.dumpChrRom(noPpu, 8)).rejects.toThrow(/PPU-bus/);
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
