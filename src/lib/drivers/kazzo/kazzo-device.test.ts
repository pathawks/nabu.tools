import { describe, it, expect } from "vitest";
import { KazzoDevice } from "./kazzo-device";
import { REQUEST, WRITE_XOR_MASK, VRAM_VERTICAL } from "./kazzo-opcodes";

interface OutCall {
  request: number;
  value: number;
  index: number;
  data: Uint8Array;
}
interface InCall {
  request: number;
  value: number;
  index: number;
  length: number;
}

/**
 * Fake USBDevice recording every control transfer. IN transfers are served
 * by `respond` (keyed off the request) so reads can be scripted.
 */
function fakeUsb(respond: (c: InCall) => Uint8Array) {
  const outCalls: OutCall[] = [];
  const inCalls: InCall[] = [];
  const usb = {
    opened: true,
    async controlTransferIn(
      setup: { request: number; value: number; index: number },
      length: number,
    ): Promise<USBInTransferResult> {
      const c = { ...setup, length };
      inCalls.push(c);
      const bytes = respond(c);
      return {
        data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        status: "ok",
      } as USBInTransferResult;
    },
    async controlTransferOut(
      setup: { request: number; value: number; index: number },
      data: BufferSource,
    ): Promise<USBOutTransferResult> {
      const bytes = new Uint8Array(data as ArrayBuffer);
      outCalls.push({ ...setup, data: bytes });
      return { status: "ok", bytesWritten: bytes.length } as USBOutTransferResult;
    },
  };
  return { usb, outCalls, inCalls };
}

function makeDevice(respond: (c: InCall) => Uint8Array = () => new Uint8Array(1)) {
  const inl = new KazzoDevice();
  const fake = fakeUsb(respond);
  (inl as unknown as { device: unknown }).device = fake.usb;
  return { device: inl, ...fake };
}

describe("KazzoDevice writes", () => {
  it("XOR-masks outgoing CPU write bytes with 0xA5", async () => {
    const { device, outCalls } = makeDevice();
    await device.cpuWrite(0x8000, 0x42);
    expect(outCalls).toHaveLength(1);
    expect(outCalls[0].request).toBe(REQUEST.CPU_WRITE_6502);
    expect(outCalls[0].value).toBe(0x8000);
    // The single data byte is transmitted XORed; firmware un-masks it.
    expect(Array.from(outCalls[0].data)).toEqual([0x42 ^ WRITE_XOR_MASK]);
  });

  it("masks a 0xFF byte (the run-length case the XOR exists for)", async () => {
    const { device, outCalls } = makeDevice();
    await device.cpuWrite(0xa000, 0xff);
    expect(outCalls[0].data[0]).toBe(0xff ^ WRITE_XOR_MASK); // 0x5a
  });

  it("cpuWriteBytes sends the whole payload to one address in ONE transfer (XOR-masked)", async () => {
    const { device, outCalls } = makeDevice();
    // The MMC1 serial-load shape: five bytes to one register address.
    await device.cpuWriteBytes(0xe000, new Uint8Array([0, 1, 0, 0, 1]));
    expect(outCalls).toHaveLength(1);
    expect(outCalls[0].request).toBe(REQUEST.CPU_WRITE_6502);
    expect(outCalls[0].value).toBe(0xe000);
    expect(Array.from(outCalls[0].data)).toEqual(
      [0, 1, 0, 0, 1].map((b) => b ^ WRITE_XOR_MASK),
    );
  });
});

describe("KazzoDevice reads", () => {
  it("reassembles a multi-page read across 256-byte chunks", async () => {
    // Serve a ramp byte = low byte of the requested address, so the
    // reassembled buffer is verifiable against the addresses requested.
    const { device, inCalls } = makeDevice((c) => {
      const out = new Uint8Array(c.length);
      for (let i = 0; i < c.length; i++) out[i] = (c.value + i) & 0xff;
      return out;
    });
    const data = await device.cpuRead(0x8000, 0x250); // 592 bytes = 2x256 + 80
    expect(data).toHaveLength(0x250);
    expect(inCalls.map((c) => [c.value, c.length])).toEqual([
      [0x8000, 0x100],
      [0x8100, 0x100],
      [0x8200, 0x50],
    ]);
    expect(data[0]).toBe(0x00); // $8000 low byte
    expect(data[0x100]).toBe(0x00); // $8100 low byte
    expect(data[0x24f]).toBe((0x8200 + 0x4f) & 0xff);
  });

  it("reports progress at each page boundary", async () => {
    const { device } = makeDevice((c) => new Uint8Array(c.length));
    const seen: Array<[number, number]> = [];
    await device.cpuRead(0x8000, 0x200, (read, total) => seen.push([read, total]));
    expect(seen).toEqual([
      [0x100, 0x200],
      [0x200, 0x200],
    ]);
  });

  it("throws a short read rather than returning a truncated buffer", async () => {
    const { device } = makeDevice(() => new Uint8Array(10)); // always short
    await expect(device.cpuRead(0x8000, 0x100)).rejects.toThrow(/short read/i);
  });

  it("aborts between pages when the signal fires", async () => {
    const controller = new AbortController();
    let pages = 0;
    const { device } = makeDevice((c) => {
      if (++pages === 2) controller.abort();
      return new Uint8Array(c.length);
    });
    await expect(
      device.cpuRead(0x8000, 0x400, undefined, controller.signal),
    ).rejects.toThrow();
  });
});

describe("KazzoDevice domain helpers", () => {
  it("parses a NUL-terminated firmware version string", async () => {
    const { device } = makeDevice((c) => {
      expect(c.request).toBe(REQUEST.FIRMWARE_VERSION);
      const s = new TextEncoder().encode("kazzo 1.2");
      const buf = new Uint8Array(c.length);
      buf.set(s);
      return buf; // remainder is 0x00 — the terminator
    });
    expect(await device.fetchFirmwareVersion()).toBe("kazzo 1.2");
    // Cached — a second call must not re-issue the request.
    expect(await device.fetchFirmwareVersion()).toBe("kazzo 1.2");
  });

  it("maps the VRAM pattern (0x05 = vertical)", async () => {
    const { device } = makeDevice(() => new Uint8Array([VRAM_VERTICAL]));
    expect(await device.vramConnection()).toBe(VRAM_VERTICAL);
  });

  it("issues PHI2_INIT on setup", async () => {
    const { device, inCalls } = makeDevice();
    await device.phi2Init();
    expect(inCalls[0].request).toBe(REQUEST.PHI2_INIT);
  });
});

describe("KazzoDevice flash-write guard (read-only dumper)", () => {
  it("refuses flash/firmware-write requests before any transfer", async () => {
    const { device, outCalls, inCalls } = makeDevice();
    for (const req of [
      REQUEST.CPU_WRITE_FLASH,
      REQUEST.FLASH_PROGRAM,
      REQUEST.FLASH_ERASE,
      REQUEST.FIRMWARE_PROGRAM,
    ]) {
      await expect(
        device.controlOut(req, 0, 0, new Uint8Array([0])),
      ).rejects.toThrow(/never programs/i);
      await expect(device.controlIn(req, 0, 0, 1)).rejects.toThrow(
        /never programs/i,
      );
    }
    // Nothing reached the wire.
    expect(outCalls).toHaveLength(0);
    expect(inCalls).toHaveLength(0);
  });
});
