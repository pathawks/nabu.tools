import { describe, it, expect } from "vitest";
import { INLDevice } from "./inl-device";
import { NES } from "./inl-opcodes";

/**
 * Build an INLDevice whose underlying USBDevice's controlTransferIn returns a
 * fixed number of payload bytes, so the desync guard in payloadIn can be
 * exercised without hardware.
 */
function deviceReturning(byteLength: number): INLDevice {
  const inl = new INLDevice();
  const fakeUsb = {
    opened: true,
    async controlTransferIn(): Promise<USBInTransferResult> {
      return {
        data: new DataView(new ArrayBuffer(byteLength)),
        status: "ok",
      } as USBInTransferResult;
    },
  };
  // The private `device` field is what payloadIn reads; inject the fake.
  (inl as unknown as { device: unknown }).device = fakeUsb;
  return inl;
}

describe("INLDevice.payloadIn desync guard", () => {
  it("returns the full window on a complete payload", async () => {
    const inl = deviceReturning(128);
    const data = await inl.payloadIn(128);
    expect(data.length).toBe(128);
  });

  it("throws on a short payload (firmware buffer desync)", async () => {
    const inl = deviceReturning(64);
    await expect(inl.payloadIn(128)).rejects.toThrow(/short read/i);
  });

  it("throws on an empty payload", async () => {
    const inl = deviceReturning(0);
    await expect(inl.payloadIn(128)).rejects.toThrow(/short read/i);
  });

  it("rejects transfers over the 254-byte firmware limit", async () => {
    // The firmware's BUFF_PAYLOAD transfer length is an 8-bit value and the
    // stock host caps a single payload at 254 bytes; a bigger buffer would
    // have to be pulled in a split, so guard against an oversized read.
    const inl = deviceReturning(255);
    await expect(inl.payloadIn(255)).rejects.toThrow(/254/);
    await expect(inl.payloadIn(512)).rejects.toThrow(/254/);
  });
});

describe("INLDevice flash-write guard (read-only dumper)", () => {
  it("refuses MMC3_PRG_FLASH_WR at any address — the misused opcode", async () => {
    // No device connected: the guard must fire before any transfer, so a
    // flash command can never reach the cart — at a $5xxx register address
    // (the one-off experiment's misuse) AND at a real $8000 flash address.
    const inl = new INLDevice();
    await expect(inl.nes(NES.MMC3_PRG_FLASH_WR, 0x5000, 0x40)).rejects.toThrow(
      /flash-write opcode/i,
    );
    await expect(inl.nes(NES.MMC3_PRG_FLASH_WR, 0x8000, 0x40)).rejects.toThrow(
      /flash-write opcode/i,
    );
  });

  it("refuses the whole flash-program family, not just MMC3", async () => {
    // Spot-check the contiguous block (CHR + other-mapper PRG writes) and
    // the MMC3S stray at 0x26.
    const inl = new INLDevice();
    for (const op of [0x08, 0x0a, 0x0e, 0x14, 0x26]) {
      await expect(inl.nes(op, 0x8000, 0x55)).rejects.toThrow(
        /never programs/i,
      );
    }
  });

  it("refuses a flash opcode disguised in the high bits of an out-of-range value", async () => {
    // controlIn() transmits only opcode & 0xff, so a caller passing 0x107
    // would send 0x07 (MMC3_PRG_FLASH_WR). The guard normalizes first, so the
    // disguised flash write is still refused — never sent as 0x07.
    const inl = new INLDevice();
    await expect(inl.nes(0x100 | NES.MMC3_PRG_FLASH_WR, 0x8000, 0x40)).rejects.toThrow(
      /flash-write opcode/i,
    );
  });

  it("does not interfere with the writes dumping needs", async () => {
    // Register/serial writes used to select banks must still pass through to
    // the transport (here they fail only because no device is connected).
    const inl = new INLDevice();
    await expect(inl.nes(NES.NES_CPU_WR, 0x5000, 0x40)).rejects.toThrow(
      /not connected/i,
    );
    await expect(inl.nes(NES.NES_MMC1_WR, 0x8000, 0x01)).rejects.toThrow(
      /not connected/i,
    );
  });
});
