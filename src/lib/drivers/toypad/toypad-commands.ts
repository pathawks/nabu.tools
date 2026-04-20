// Lego Dimensions Toy Pad — HID protocol constants
// Protocol reverse-engineered by community (woodenphone, AlinaNova21/node-ld, Ellerbach/LegoDimensions)

export const DEVICE_FILTERS: HIDDeviceFilter[] = [
  { vendorId: 0x0e6f, productId: 0x0241 }, // Lego Dimensions Toy Pad (Wii U/PS3/PS4)
  { vendorId: 0x0e6f, productId: 0x0141 }, // Lego Dimensions Toy Pad (Xbox — detected but read-only)
];

export const PACKET_SIZE = 32;
export const PAD_BYTE = 0x00;

// Outgoing commands use 0x55 prefix, incoming tag events use 0x56
export const CMD_PREFIX = 0x55;
export const EVT_PREFIX = 0x56;

export const CMD = {
  INIT: 0xb0,
  SEED: 0xb1,
  CHALLENGE: 0xb3,
  READ: 0xd2,
  WRITE: 0xd4,
  PWD_AUTH: 0xe1,
  LED_FADE: 0xc0,
  LED_FLASH: 0xc3,
  LED_FADERATE: 0xc6,
  LED_FADEALL: 0xc8,
} as const;

export type PadId = 1 | 2 | 3;
export const PAD_CENTER = 1 as const;
export const PAD_LEFT = 2 as const;
export const PAD_RIGHT = 3 as const;

export const PAD_NAMES: Record<PadId, string> = {
  1: "Center",
  2: "Left",
  3: "Right",
};

/**
 * Portal's own classification of a detected tag (byte 3 of the 0x56 event).
 * Same scheme as the Disney Infinity Base portal — both use the PDP NFC
 * front-end. Only `ntag` tags are readable through the Toy Pad's command
 * surface; the firmware won't authenticate MIFARE Classic tags, so all
 * other kinds are informational only (UID via the event, no block data).
 */
export type TagKind =
  | "ntag" // 0x00: NTAG21x / NDEF tag (Lego Dimensions figures)
  | "mifare-foreign" // 0x01: MIFARE Classic with 7-byte UID (Skylanders etc.)
  | "mifare-4byte" // 0x08: MIFARE Classic with 4-byte UID (hotel keys etc.)
  | "mifare-disney" // 0x09: MIFARE Classic authenticated as Disney Infinity
  | "unknown";

export const MARKER_NTAG = 0x00;
export const MARKER_MIFARE_FOREIGN = 0x01;
export const MARKER_MIFARE_4BYTE = 0x08;
export const MARKER_MIFARE_DISNEY = 0x09;

export function kindFromMarker(marker: number): TagKind {
  switch (marker) {
    case MARKER_NTAG:
      return "ntag";
    case MARKER_MIFARE_FOREIGN:
      return "mifare-foreign";
    case MARKER_MIFARE_4BYTE:
      return "mifare-4byte";
    case MARKER_MIFARE_DISNEY:
      return "mifare-disney";
    default:
      return "unknown";
  }
}

export interface TagEvent {
  pad: PadId;
  uid: Uint8Array;
  action: "placed" | "removed";
  index: number;
  kind: TagKind;
}

// "(c) LEGO 2014" init payload — the portal requires this exact sequence to activate
export const INIT_PAYLOAD = new Uint8Array([
  0x01, 0x28, 0x63, 0x29, 0x20, 0x4c, 0x45, 0x47, 0x4f, 0x20, 0x32, 0x30, 0x31,
  0x34,
]);

export const NTAG213_SIZE = 180; // 45 pages x 4 bytes
export const NTAG215_SIZE = 540; // 135 pages x 4 bytes

/**
 * Compute checksum for a Toy Pad message.
 * Sum of all bytes before the checksum position, modulo 256.
 */
export function checksum(data: Uint8Array, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += data[i];
  return sum & 0xff;
}
