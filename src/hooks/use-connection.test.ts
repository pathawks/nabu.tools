import { describe, it, expect } from "vitest";
import { webusbMatches } from "./use-connection";
import type { DeviceDef } from "@/lib/core/devices";

/**
 * The Kazzo and INL Retro both enumerate as V-USB 16c0:05dc. Matching by
 * VID/PID alone made one physical device claim both drivers (and the INL
 * driver would run against kazzo firmware → Device error 0xff). `webusbMatches`
 * disambiguates by the iProduct string: Kazzo claims "kazzo"; INL is the
 * catch-all for the shared ID.
 */

const KAZZO: DeviceDef = {
  id: "KAZZO",
  name: "Kazzo",
  vendorId: 0x16c0,
  productId: 0x05dc,
  transport: "webusb",
  usbProduct: "kazzo",
  systems: [],
  description: "",
};
const INL: DeviceDef = {
  id: "INL_RETRO",
  name: "INL Retro",
  vendorId: 0x16c0,
  productId: 0x05dc,
  transport: "webusb",
  // no usbProduct → catch-all for the shared ID
  systems: [],
  description: "",
};
const defs = [KAZZO, INL];

const usb = (productName: string | undefined, vid = 0x16c0, pid = 0x05dc) =>
  ({ vendorId: vid, productId: pid, productName }) as unknown as USBDevice;

describe("webusbMatches — shared-VID/PID disambiguation", () => {
  it("a 'kazzo' device matches KAZZO, not the INL catch-all", () => {
    const d = usb("kazzo");
    expect(webusbMatches(d, KAZZO, defs)).toBe(true);
    expect(webusbMatches(d, INL, defs)).toBe(false);
  });

  it("an 'INL Retro-Prog' device matches the INL catch-all, not KAZZO", () => {
    const d = usb("INL Retro-Prog");
    expect(webusbMatches(d, KAZZO, defs)).toBe(false);
    expect(webusbMatches(d, INL, defs)).toBe(true);
  });

  it("a device with no product string falls to the catch-all (INL), not KAZZO", () => {
    const d = usb(undefined);
    expect(webusbMatches(d, KAZZO, defs)).toBe(false);
    expect(webusbMatches(d, INL, defs)).toBe(true);
  });

  it("matches the product string as a substring (tolerates suffixes)", () => {
    const d = usb("kazzo r2");
    expect(webusbMatches(d, KAZZO, defs)).toBe(true);
    expect(webusbMatches(d, INL, defs)).toBe(false);
  });

  it("does not match a different VID/PID", () => {
    expect(webusbMatches(usb("kazzo", 0x1234, 0x5678), KAZZO, defs)).toBe(false);
  });

  it("with no usbProduct siblings, a catch-all matches its VID/PID outright", () => {
    const solo: DeviceDef = { ...INL };
    expect(webusbMatches(usb("anything"), solo, [solo])).toBe(true);
  });
});
