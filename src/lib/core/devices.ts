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
  DISNEY_INFINITY: {
    id: "DISNEY_INFINITY",
    name: "Disney Infinity Base",
    vendorId: 0x0e6f,
    productId: 0x0129,
    transport: "webhid",
    systems: [{ id: "disney-infinity", name: "Disney Infinity Figures" }],
    notes:
      "Logic3/PDP Wii/Wii U/PS3/PS4/PC base (INF-8032386). " +
      "Protocol reference: dolphin-emu (GPL-2.0-or-later).",
  },
  EMS_NDS: {
    id: "EMS_NDS",
    name: "EMS NDS Adapter Plus",
    vendorId: 0x4670,
    productId: 0x9394,
    transport: "webusb",
    systems: [{ id: "nds_save", name: "NDS / 3DS (Saves Only)" }],
    notes:
      "Save backup/restore only — does NOT dump ROMs. " +
      "Protocol: github.com/Thulinma/ndsplus",
  },
};
