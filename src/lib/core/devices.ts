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
  POWERSAVE_3DS: {
    id: "POWERSAVE_3DS",
    name: "PowerSaves for 3DS",
    vendorId: 0x1c1a,
    productId: 0x03d5,
    transport: "webhid",
    systems: [{ id: "nds_save", name: "DS (Saves Only)" }],
    notes:
      "Datel PowerSaves — despite the 3DS branding, reads DS cart saves " +
      "via the device's generic NTR + SPI passthrough. Protocol: " +
      "github.com/kitlith/powerslaves (MIT).",
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
};
