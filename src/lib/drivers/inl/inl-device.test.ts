import { describe, it, expect } from "vitest";
import { INLDevice } from "./inl-device";

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
});
