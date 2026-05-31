import { describe, it, expect } from "vitest";
import { INLDevice } from "./inl-device";

describe("INLDevice.payloadIn", () => {
  it("rejects transfers over the 254-byte firmware limit", async () => {
    // The firmware's BUFF_PAYLOAD transfer length is an 8-bit value and the
    // stock host caps a single payload at 254 bytes; a 256B buffer would have
    // to be pulled in a split, so guard against an oversized single read.
    const device = new INLDevice();
    await expect(device.payloadIn(255)).rejects.toThrow(/254/);
    await expect(device.payloadIn(512)).rejects.toThrow(/254/);
  });
});
