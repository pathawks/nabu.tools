import { describe, it, expect } from "vitest";
import { KazzoNesBus } from "./kazzo-nes-bus";
import type { KazzoDevice } from "./kazzo-device";

interface Call {
  m: "phi2Init" | "cpuWrite" | "cpuWriteBytes" | "cpuRead" | "ppuRead";
  addr?: number;
  value?: number;
  length?: number;
  bytes?: number[];
}

/** Records the device calls a KazzoNesBus makes, serving reads from a ramp. */
function recordingDevice() {
  const calls: Call[] = [];
  const device = {
    async phi2Init() {
      calls.push({ m: "phi2Init" });
    },
    async cpuWrite(addr: number, value: number) {
      calls.push({ m: "cpuWrite", addr, value });
    },
    async cpuWriteBytes(addr: number, bytes: Uint8Array) {
      calls.push({ m: "cpuWriteBytes", addr, bytes: Array.from(bytes) });
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
      return new Uint8Array(length).fill(0x11);
    },
    async ppuRead(addr: number, length: number) {
      calls.push({ m: "ppuRead", addr, length });
      return new Uint8Array(length).fill(0x22);
    },
  };
  return { device: device as unknown as KazzoDevice, calls };
}

describe("KazzoNesBus", () => {
  it("setup() runs PHI2_INIT", async () => {
    const { device, calls } = recordingDevice();
    await new KazzoNesBus(device).setup();
    expect(calls).toEqual([{ m: "phi2Init" }]);
  });

  it("writeCpu maps to a single cpuWrite", async () => {
    const { device, calls } = recordingDevice();
    await new KazzoNesBus(device).writeCpu(0x8000, 0x06);
    expect(calls).toEqual([{ m: "cpuWrite", addr: 0x8000, value: 0x06 }]);
  });

  it("writeSerialRegister batches the MMC1 5-bit load into one cpuWriteBytes", async () => {
    const { device, calls } = recordingDevice();
    // 0x12 = 0b10010 → bit 0 of each shifted byte, LSB first: 0,1,0,0,1.
    await new KazzoNesBus(device).writeSerialRegister(0xe000, 0x12);
    expect(calls).toEqual([
      { m: "cpuWriteBytes", addr: 0xe000, bytes: [0, 1, 0, 0, 1] },
    ]);
  });

  it("writeSerialRegister surfaces an aborted signal before any write", async () => {
    const { device, calls } = recordingDevice();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new KazzoNesBus(device, controller.signal).writeSerialRegister(0xe000, 0x1f),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("readCpu / readPpu map to the matching device reads and forward progress", async () => {
    const { device, calls } = recordingDevice();
    const bus = new KazzoNesBus(device);
    const seen: number[] = [];
    const prg = await bus.readCpu(0x8000, 0x2000, (r) => seen.push(r));
    const chr = await bus.readPpu(0x0000, 0x1000);
    expect(prg.every((b) => b === 0x11)).toBe(true);
    expect(chr.every((b) => b === 0x22)).toBe(true);
    expect(calls).toEqual([
      { m: "cpuRead", addr: 0x8000, length: 0x2000 },
      { m: "ppuRead", addr: 0x0000, length: 0x1000 },
    ]);
    expect(seen).toEqual([0x2000]);
  });

  it("a zero-length read is a no-op (no device call)", async () => {
    const { device, calls } = recordingDevice();
    const out = await new KazzoNesBus(device).readCpu(0x8000, 0);
    expect(out).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("an aborted signal surfaces through readCpu", async () => {
    const { device } = recordingDevice();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new KazzoNesBus(device, controller.signal).readCpu(0x8000, 0x100),
    ).rejects.toThrow();
  });
});
