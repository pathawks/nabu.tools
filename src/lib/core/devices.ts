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
  // The adapter performs an SIO-level identification challenge before
  // reporting a card type. First-party PS1 cards reply with the expected
  // ID bytes (0x5A 0x5D) on the first request; multi-page clone cards
  // often fail to detect on the first try. The driver polls verify-card
  // a handful of times to give clones a chance to come up
  // (see Ps3McaDriver.getCardType).
  PS3_MCA: {
    id: "PS3_MCA",
    name: "PS3 Memory Card Adaptor",
    vendorId: 0x054c,
    productId: 0x02ea,
    transport: "webusb",
    systems: [{ id: "ps1", name: "PS1 Memory Card" }],
    notes:
      "PS1 cards only; PS2 reads require encryption keys that cannot be " +
      "redistributed. First-party cards detect instantly; clone cards " +
      "may need a few retries. " +
      "Protocol reference: github.com/paolo-caroni/ps3mca-ps1 (GPL-3.0).",
  },
};
