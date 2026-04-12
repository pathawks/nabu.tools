import type { TransportType } from "@/lib/types";

export interface DeviceDef {
  id: string;
  name: string;
  vendorId: number | null;
  productId: number | null;
  transport: TransportType;
  systems: { id: string; name: string }[];
  notes: string;
}

export const DEVICES: Record<string, DeviceDef> = {
  GBXCART: {
    id: "GBXCART",
    name: "GBxCart RW v1.4 Pro",
    vendorId: 0x1a86,
    productId: 0x7523,
    transport: "serial",
    systems: [
      { id: "gb", name: "Game Boy (DMG)" },
      { id: "gbc", name: "Game Boy Color" },
      { id: "gba", name: "Game Boy Advance" },
    ],
    notes:
      "Open-source by insideGadgets. Uses CH340 serial. " +
      "Protocol: github.com/lesserkuma/FlashGBX",
  },
  POWERSAVE: {
    id: "POWERSAVE",
    name: "PowerSaves for Amiibo",
    vendorId: 0x1c1a,
    productId: 0x03d9,
    transport: "webhid",
    systems: [{ id: "amiibo", name: "Amiibo (NTAG215)" }],
    notes:
      "Datel NFC portal. Also supports MaxLander/NaMiio clones. " +
      "Protocol: github.com/malc0mn/amiigo",
  },
  PROCON: {
    id: "PROCON",
    name: "Switch Pro Controller",
    vendorId: 0x057e,
    productId: 0x2009,
    transport: "webhid",
    systems: [{ id: "amiibo", name: "Amiibo (NTAG215)" }],
    notes:
      "Reads Amiibo via the Pro Controller's built-in NFC reader. " +
      "Also supports Joy-Con (R). Linux blocked: HID descriptor omits report 0x31.",
  },
};
