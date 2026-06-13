import { describe, it, expect, vi } from "vitest";
import { KazzoDriver } from "./kazzo-driver";
import type { KazzoTransport } from "./kazzo-transport";
import type { KazzoDevice } from "./kazzo-device";
import type { ReadConfig } from "@/lib/types";
import { VRAM_VERTICAL, VERSION_STRING_SIZE } from "./kazzo-opcodes";
import { M2_IDLE_GATED_MAPPERS } from "./unsupported-mappers";

/**
 * Driver-level coverage exercised entirely through a fake `KazzoDevice` — no
 * hardware. It proves the dump paths drive the shared mapper catalog over the
 * bus correctly: NROM reads flat, an MMC3 cart is banked + reassembled, the
 * M2-idle-gated mappers are classified per firmware and pre-flight-rejected
 * before any cart traffic, and detect/init/save take their expected shapes.
 */

interface Call {
  m: "phi2Init" | "cpuWrite" | "cpuRead" | "ppuRead" | "vram" | "firmware";
  addr?: number;
  value?: number;
  length?: number;
}

interface FakeOptions {
  /** Bytes a cpuRead at (addr,len) yields. Default: zero-fill. */
  cpuRead?: (addr: number, len: number) => Uint8Array;
  /** Bytes a ppuRead at (addr,len) yields. Default: zero-fill. */
  ppuRead?: (addr: number, len: number) => Uint8Array;
  vram?: number;
  /**
   * FIRMWARE_VERSION response: a string (NUL-padded to 32 bytes), raw bytes
   * (e.g. the clipped build's all-0xFF section), or "transfer-error" to make
   * the fetch itself throw.
   */
  firmware?: string | Uint8Array | "transfer-error";
}

/** A NUL-terminated, zero-padded 32-byte version section. */
function versionBytes(s: string): Uint8Array {
  const out = new Uint8Array(VERSION_STRING_SIZE);
  out.set(new TextEncoder().encode(s));
  return out;
}

/** A fake KazzoDevice that records every call the bus/driver makes. */
function fakeKazzo(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const firmware = opts.firmware ?? "kazzo 1.2";
  let fwBytes: Uint8Array | null = null;
  const device = {
    productName: "kazzo",
    get firmwareVersionBytes() {
      return fwBytes;
    },
    async fetchFirmwareVersion() {
      calls.push({ m: "firmware" });
      if (firmware === "transfer-error") {
        throw new Error("Kazzo control IN failed");
      }
      fwBytes = typeof firmware === "string" ? versionBytes(firmware) : firmware;
      return "";
    },
    async phi2Init() {
      calls.push({ m: "phi2Init" });
    },
    async cpuWrite(addr: number, value: number) {
      calls.push({ m: "cpuWrite", addr, value });
    },
    async cpuRead(
      addr: number,
      length: number,
      onProgress?: (r: number, t: number) => void,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      calls.push({ m: "cpuRead", addr, length });
      onProgress?.(length, length);
      return opts.cpuRead?.(addr, length) ?? new Uint8Array(length);
    },
    async ppuRead(
      addr: number,
      length: number,
      onProgress?: (r: number, t: number) => void,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      calls.push({ m: "ppuRead", addr, length });
      onProgress?.(length, length);
      return opts.ppuRead?.(addr, length) ?? new Uint8Array(length);
    },
    async vramConnection() {
      calls.push({ m: "vram" });
      return opts.vram ?? 0;
    },
  };
  return { device: device as unknown as KazzoDevice, calls };
}

function makeDriver(device: KazzoDevice): KazzoDriver {
  return new KazzoDriver({ device } as unknown as KazzoTransport);
}

const romConfig = (params: Record<string, unknown>): ReadConfig => ({
  systemId: "nes",
  params,
});

describe("KazzoDriver capabilities", () => {
  it("advertises NES ROM dumping and greys out the unsupported mappers", () => {
    const { device } = fakeKazzo();
    const cap = makeDriver(device).capabilities;
    expect(cap).toHaveLength(1);
    expect(cap[0].systemId).toBe("nes");
    expect(cap[0].operations).toContain("dump_rom");
    expect(cap[0].autoDetect).toBe(true);
    // Pre-probe default: the M2-idle-gated CPLD mappers are greyed out
    // until initialize() classifies the firmware (fail-safe).
    expect(cap[0].unsupportedMappers).toEqual([...M2_IDLE_GATED_MAPPERS.keys()]);
  });
});

describe("KazzoDriver.initialize", () => {
  it("fetches the firmware version and reports device info", async () => {
    const { device, calls } = fakeKazzo({ firmware: "kazzo16 0.1.3" });
    const info = await makeDriver(device).initialize();
    expect(info.firmwareVersion).toBe("kazzo16 0.1.3");
    expect(info.deviceName).toBe("kazzo");
    expect(info.capabilities[0].systemId).toBe("nes");
    expect(calls.some((c) => c.m === "firmware")).toBe(true);
  });
});

/**
 * The M2-idle firmware gate. initialize() classifies the connected build
 * from its FIRMWARE_VERSION fingerprint (see ./firmware-m2): pre-flip
 * "kazzo16 0.1.0"–"0.1.2" strings and the self-identifying "0.1.3+m2"
 * fork idle M2 high (all-0xFF — a blank version section — gates: capable
 * in practice but not an identity)
 * → the SMD172-family CPLD mappers are enabled; anything else (including a
 * failed read, and before any probe at all) leaves them gated.
 */
describe("KazzoDriver M2-idle firmware gate", () => {
  const gatedIds = [...M2_IDLE_GATED_MAPPERS.keys()];
  const clipped = () => new Uint8Array(VERSION_STRING_SIZE).fill(0xff);

  it("enables the CPLD mappers on the m2-idle-high fork build and dumps mapper 268", async () => {
    const { device } = fakeKazzo({ firmware: "kazzo16 0.1.3+m2 / Jun 10 2026" });
    const driver = makeDriver(device);

    await driver.initialize();

    expect(driver.m2IdleHigh).toBe(true);
    expect(driver.capabilities[0].unsupportedMappers).toEqual([]);

    // A formerly-gated mapper now dumps end to end (one 16 KiB outer bank).
    const data = await driver.readROM(
      romConfig({ mapper: 268, prgSizeBytes: 16384, chrSizeBytes: 0 }),
    );
    expect(data).toHaveLength(16384);
  });

  it("gates the CPLD mappers on the clipped (all-0xFF) build — blank version is no identity", async () => {
    const { device, calls } = fakeKazzo({ firmware: clipped() });
    const driver = makeDriver(device);
    await driver.initialize();
    expect(driver.m2IdleHigh).toBe(false);
    calls.length = 0;
    await expect(
      driver.readROM(
        romConfig({ mapper: 268, prgSizeBytes: 16384, chrSizeBytes: 0 }),
      ),
    ).rejects.toThrow(/Kazzo firmware/);
    expect(calls).toHaveLength(0);
  });

  it("enables the CPLD mappers on a pre-flip version string", async () => {
    const { device } = fakeKazzo({ firmware: "kazzo16 0.1.2" });
    const driver = makeDriver(device);

    await driver.initialize();

    expect(driver.m2IdleHigh).toBe(true);
    expect(driver.capabilities[0].unsupportedMappers).toEqual([]);
  });

  it.each([268, 470])(
    "pre-flight-rejects mapper %i on post-flip firmware without touching the cart",
    async (mapper) => {
      // The driver must reject before any cart traffic rather than produce
      // a boot-bank-mirrored garbage dump.
      const { device, calls } = fakeKazzo({ firmware: "kazzo16 0.1.3" });
      const driver = makeDriver(device);
      await driver.initialize();
      calls.length = 0;

      await expect(
        driver.readROM(
          romConfig({ mapper, prgSizeBytes: 16384, chrSizeBytes: 0 }),
        ),
      ).rejects.toThrow(/Kazzo firmware/);
      expect(calls).toHaveLength(0);
    },
  );

  it("treats a version-read failure as gated (fail-safe)", async () => {
    const { device } = fakeKazzo({ firmware: "transfer-error" });
    const driver = makeDriver(device);

    await driver.initialize(); // must not throw

    expect(driver.m2IdleHigh).toBe(false);
    expect(driver.capabilities[0].unsupportedMappers).toEqual(gatedIds);
  });

  it("gates the mappers before initialize() has classified (fail-safe default)", async () => {
    const { device, calls } = fakeKazzo();
    const driver = makeDriver(device);

    expect(driver.m2IdleHigh).toBe(false);
    expect(driver.capabilities[0].unsupportedMappers).toEqual(gatedIds);
    await expect(
      driver.readROM(
        romConfig({ mapper: 268, prgSizeBytes: 16384, chrSizeBytes: 0 }),
      ),
    ).rejects.toThrow(/Kazzo firmware/);
    expect(calls).toHaveLength(0);
  });

  it("logs exactly one firmware-classification line", async () => {
    const { device } = fakeKazzo({ firmware: "kazzo16 0.1.3+m2 / Jun 10 2026" });
    const driver = makeDriver(device);
    const logs: string[] = [];
    driver.on("onLog", (message) => logs.push(message));

    await driver.initialize();

    const fwLines = logs.filter((l) => l.includes("M2 idles"));
    expect(fwLines).toHaveLength(1);
    expect(fwLines[0]).toBe(
      "Firmware kazzo16 0.1.3+m2 / Jun 10 2026: " +
        "M2 idles high — CPLD mappers (268/470) enabled",
    );
  });

  it("the classification line names the gated mappers as unavailable on a post-flip build", async () => {
    const { device } = fakeKazzo({ firmware: "kazzo16 0.1.3" });
    const driver = makeDriver(device);
    const logs: string[] = [];
    driver.on("onLog", (message) => logs.push(message));

    await driver.initialize();

    const fwLines = logs.filter((l) => l.includes("M2 idles"));
    expect(fwLines).toHaveLength(1);
    expect(fwLines[0]).toBe(
      "Firmware kazzo16 0.1.3: M2 idles low — CPLD mappers (268/470) unavailable",
    );
  });
});

describe("KazzoDriver.detectSystem", () => {
  it("maps the vertical VRAM pattern to vertical mirroring", async () => {
    const { device } = fakeKazzo({ vram: VRAM_VERTICAL });
    const result = await makeDriver(device).detectSystem();
    expect(result?.systemId).toBe("nes");
    expect(result?.cartInfo?.summary).toBe("NES cartridge (mirroring: vertical)");
    expect(result?.cartInfo?.meta).toEqual({ mirroring: "vertical" });
  });

  it("maps any other VRAM pattern to horizontal mirroring", async () => {
    const { device } = fakeKazzo({ vram: 0x00 });
    const result = await makeDriver(device).detectSystem();
    expect(result?.cartInfo?.summary).toBe(
      "NES cartridge (mirroring: horizontal)",
    );
  });

  it("detectCartridge returns the cart info for nes and null otherwise", async () => {
    const { device } = fakeKazzo({ vram: VRAM_VERTICAL });
    const driver = makeDriver(device);
    expect((await driver.detectCartridge("nes"))?.meta).toEqual({
      mirroring: "vertical",
    });
    expect(await driver.detectCartridge("gb")).toBeNull();
  });
});

describe("KazzoDriver.readROM — NROM (flat, unbanked)", () => {
  it("reads PRG off the CPU bus and CHR off the PPU bus, concatenated", async () => {
    // Ramp content keyed off the byte's bus address, so the reassembled
    // image is verifiable against the regions the mapper read.
    const { device, calls } = fakeKazzo({
      cpuRead: (addr, len) =>
        Uint8Array.from({ length: len }, (_, i) => (addr + i) & 0xff),
      ppuRead: (addr, len) =>
        Uint8Array.from({ length: len }, (_, i) => (addr + i) & 0xff),
    });

    const data = await makeDriver(device).readROM(
      romConfig({ mapper: 0, prgSizeBytes: 32768, chrSizeBytes: 8192 }),
    );

    expect(data).toHaveLength(40960); // 32K PRG + 8K CHR
    // PRG: bus address $8000.. → low byte ramp.
    expect(data[0]).toBe(0x00); // $8000
    expect(data[1]).toBe(0x01);
    expect(data[0x7fff]).toBe(0xff);
    // CHR begins at offset 32768, PPU address $0000.. → ramp from 0.
    expect(data[32768]).toBe(0x00);
    expect(data[32768 + 0x1fff]).toBe(0xff);

    // NROM is a single CPU read then a single PPU read, each prefaced by a
    // PHI2_INIT from the mapper's setup().
    expect(calls.filter((c) => c.m === "cpuRead")).toEqual([
      { m: "cpuRead", addr: 0x8000, length: 32768 },
    ]);
    expect(calls.filter((c) => c.m === "ppuRead")).toEqual([
      { m: "ppuRead", addr: 0x0000, length: 8192 },
    ]);
    expect(calls.filter((c) => c.m === "cpuWrite")).toHaveLength(0);
  });

  it("omits CHR when the cart uses CHR-RAM (0 KB CHR-ROM)", async () => {
    const { device, calls } = fakeKazzo();
    const data = await makeDriver(device).readROM(
      romConfig({ mapper: 0, prgSizeBytes: 16384, chrSizeBytes: 0 }),
    );
    expect(data).toHaveLength(16384);
    expect(calls.some((c) => c.m === "ppuRead")).toBe(false);
  });
});

describe("KazzoDriver.readROM — MMC3 (banked)", () => {
  /**
   * Models just enough of the MMC3 register file to make each bank's read
   * distinct: R6 (PRG $8000) and R0 (CHR $0000) drive the fill byte, so the
   * reassembled image proves the driver actually re-banked between reads.
   */
  function mmc3Fake() {
    let selected = 0;
    let prgR6 = 0;
    let chrR0 = 0;
    const fake = fakeKazzo({
      cpuRead: (_addr, len) => new Uint8Array(len).fill(prgR6 & 0xff),
      ppuRead: (_addr, len) => new Uint8Array(len).fill(chrR0 & 0xff),
    });
    const dev = fake.device as unknown as {
      cpuWrite: (addr: number, value: number) => Promise<void>;
    };
    const inner = dev.cpuWrite;
    dev.cpuWrite = async (addr: number, value: number) => {
      if (addr === 0x8000) selected = value & 7;
      else if (addr === 0x8001) {
        if (selected === 6) prgR6 = value;
        else if (selected === 0) chrR0 = value;
      }
      await inner(addr, value);
    };
    return fake;
  }

  it("walks PRG via R6 and CHR via R0, one bank per read", async () => {
    const { device, calls } = mmc3Fake();
    // 256K PRG = 32×8K banks; 128K CHR = 32×4K outer iterations.
    const data = await makeDriver(device).readROM(
      romConfig({ mapper: 4, prgSizeBytes: 262144, chrSizeBytes: 131072 }),
    );

    expect(data).toHaveLength(262144 + 131072);
    // One read per bank — the dropout retry never fires (bank 0 is a uniform
    // fill, which disables the bank-0 comparison).
    expect(calls.filter((c) => c.m === "cpuRead")).toHaveLength(32);
    expect(calls.filter((c) => c.m === "ppuRead")).toHaveLength(32);

    // PRG bank i was selected (R6=i) before its read → 8K of byte i.
    for (let bank = 0; bank < 32; bank++) {
      expect(data[bank * 8192]).toBe(bank);
    }
    // CHR outer i set R0 = (i*2)<<1 = i*4 → 4K of byte (i*4)&0xff.
    for (let i = 0; i < 32; i++) {
      expect(data[262144 + i * 4096]).toBe((i * 4) & 0xff);
    }
  });
});

describe("KazzoDriver.readROM — unsupported mappers", () => {
  // The M2-idle-gated mappers (268/470) are covered by the firmware-gate
  // describe above. resolveMapper additionally rejects ids that aren't in
  // the shared catalog at all:
  it("rejects a mapper that isn't in the catalog at all", async () => {
    const { device } = fakeKazzo();
    await expect(
      makeDriver(device).readROM(romConfig({ mapper: 999 })),
    ).rejects.toThrow(/Unsupported mapper: 999/);
  });
});

describe("KazzoDriver.readROM — abort", () => {
  it("an already-aborted signal stops the dump before any read", async () => {
    const { device, calls } = fakeKazzo();
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeDriver(device).readROM(
        romConfig({ mapper: 0, prgSizeBytes: 32768, chrSizeBytes: 8192 }),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(calls.some((c) => c.m === "cpuRead")).toBe(false);
  });
});

describe("KazzoDriver.readSave", () => {
  it("reads the $6000 PRG-RAM window after PHI2_INIT (default path)", async () => {
    const { device, calls } = fakeKazzo({
      cpuRead: (addr, len) =>
        Uint8Array.from({ length: len }, (_, i) => (addr + i) & 0xff),
    });
    const data = await makeDriver(device).readSave(
      romConfig({ mapper: 0, prgRamSizeBytes: 8192 }),
    );

    expect(data).toHaveLength(8192);
    expect(data[0]).toBe(0x00); // $6000 low byte
    // PHI2_INIT (setup) precedes the single $6000 SRAM read.
    expect(calls.map((c) => c.m)).toEqual(["phi2Init", "cpuRead"]);
    expect(calls.find((c) => c.m === "cpuRead")?.addr).toBe(0x6000);
  });

  it("throws when the cart has no SRAM", async () => {
    const { device } = fakeKazzo();
    await expect(
      makeDriver(device).readSave(romConfig({ mapper: 0, prgRamSizeBytes: 0 })),
    ).rejects.toThrow(/No SRAM/);
  });
});

describe("KazzoDriver.writeSave", () => {
  it("refuses — nabu is a read-only dumper", async () => {
    const { device } = fakeKazzo();
    await expect(
      makeDriver(device).writeSave(
        new Uint8Array(8),
        romConfig({ mapper: 0, prgRamSizeBytes: 8192 }),
      ),
    ).rejects.toThrow(/not yet implemented/);
  });
});

describe("KazzoDriver.detectSystem — probe failure", () => {
  it("falls back to unknown mirroring when the VRAM probe throws", async () => {
    const { device } = fakeKazzo();
    (device as unknown as { vramConnection: () => Promise<number> }).vramConnection =
      vi.fn().mockRejectedValue(new Error("probe not supported"));
    const result = await makeDriver(device).detectSystem();
    expect(result?.cartInfo?.summary).toBe("NES cartridge (mirroring: unknown)");
  });
});
