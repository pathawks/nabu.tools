import type { TransportType } from "@/lib/types";

export interface DeviceDef {
  id: string;
  name: string;
  vendorId: number | null;
  productId: number | null;
  transport: TransportType;
  systems: { id: string; name: string }[];
  /** Known model identifiers, e.g. ["CECHZM1", "SCPH-98042"]. */
  models?: string[];
  /** Official homepage / product page, when one still exists. */
  homepage?: string;
  /** User-facing prose: 1–2 sentences. What is it, what does it do. */
  description: string;
}

export const DEVICES: Record<string, DeviceDef> = {
  GBXCART: {
    id: "GBXCART",
    name: "GBxCart RW",
    vendorId: 0x1a86,
    productId: 0x7523,
    transport: "serial",
    systems: [
      { id: "gb", name: "Game Boy (DMG)" },
      { id: "gbc", name: "Game Boy Color" },
      { id: "gba", name: "Game Boy Advance" },
    ],
    models: ["v1.4 Pro"],
    homepage: "https://www.gbxcart.com/",
    description:
      "Open-source Game Boy / Game Boy Color / Game Boy Advance cartridge " +
      "reader by insideGadgets. Uses a CH340 USB-serial chip.",
  },
  POWERSAVE: {
    id: "POWERSAVE",
    name: "PowerSaves for Amiibo",
    vendorId: 0x1c1a,
    productId: 0x03d9,
    transport: "webhid",
    systems: [{ id: "amiibo", name: "Amiibo (NTAG215)" }],
    description: "Datel NFC portal for reading Amiibo (NTAG215) tags.",
  },
  DISNEY_INFINITY: {
    id: "DISNEY_INFINITY",
    name: "Disney Infinity Base",
    vendorId: 0x0e6f,
    productId: 0x0129,
    transport: "webhid",
    systems: [{ id: "disney-infinity", name: "Disney Infinity Figures" }],
    models: ["INF-8032386"],
    description:
      "Logic3 / PDP Disney Infinity Base. Reads Disney Infinity figures " +
      "(Wii / Wii U / PS3 / PS4 / PC variant).",
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
    models: ["CECHZM1", "SCPH-98042"],
    description:
      "Sony's PlayStation 3 adapter for PlayStation 1 and 2 memory cards. " +
      "Only PS1 cards are dumpable in the browser (PS2 reads require " +
      "MagicGate authentication keys that cannot be redistributed).",
  },
  // Reads Amiibo via the controller's built-in NFC reader. Linux is
  // blocked because the kernel hid-nintendo driver hides MCU input
  // report 0x31; macOS / Windows work.
  PROCON: {
    id: "PROCON",
    name: "Switch Pro Controller",
    vendorId: 0x057e,
    productId: 0x2009,
    transport: "webhid",
    systems: [{ id: "amiibo", name: "Amiibo (NTAG215)" }],
    models: ["HAC-013"],
    description:
      "Nintendo Switch Pro Controller, used here as a NFC reader for " +
      "Amiibo (NTAG215) tags.",
  },
  // Same NFC reader hardware as the Pro Controller. The left Joy-Con
  // (HAC-015) has no NFC reader and is not supported.
  JOYCON_R: {
    id: "JOYCON_R",
    name: "Joy-Con (R)",
    vendorId: 0x057e,
    productId: 0x2007,
    transport: "webhid",
    systems: [{ id: "amiibo", name: "Amiibo (NTAG215)" }],
    models: ["HAC-016"],
    description:
      "Right Joy-Con. Used here as a NFC reader for Amiibo (NTAG215) tags.",
  },
};
