// Disney Infinity Base — HID command constants.
// Protocol reference: Dolphin Emulator's Infinity.cpp (GPL-2.0-or-later)
//   https://github.com/dolphin-emu/dolphin/blob/master/Source/Core/Core/IOS/USB/Emulated/Infinity.cpp
// Commands marked "(undocumented)" were discovered via command-space fuzzing
// against v9.09 firmware and are not described in Dolphin's reference.

export const CMD = {
  ACTIVATE: 0x80,
  SET_LED: 0x90,
  GET_LED_COLOR: 0x91, // (undocumented) — arg: panel 0..2 (0-indexed!). Returns 3 bytes R G B of whatever was last set with 0x90.
  FADE_LED: 0x92,
  FLASH_LED: 0x93,
  GET_PRESENT_FIGURES: 0xa1,
  READ_BLOCK: 0xa2,
  WRITE_BLOCK: 0xa3,
  GET_FIGURE_UID: 0xb4,
} as const;

// Portal error codes returned as the first byte of a READ_BLOCK / WRITE_BLOCK
// response payload when the operation fails.
export const ERR = {
  NO_FIGURE: 0x80, // order_added doesn't correspond to a placed figure
  INVALID_POSITION: 0x82, // order out of range
  READ_ONLY: 0x84, // the block is write-protected (identity, sector trailers)
  INVALID_ARG: 0x86, // block / U out of range, etc.
} as const;

// "Marker" byte accompanying each entry in the GET_PRESENT_FIGURES response
// (and in the equivalent async 0xAB tag events). It appears to be the
// portal's internal classification of the tag it detected. Observed values:
//
//   0x00 — NFC Forum Type 2 / NDEF tag (conference swag, stickers,
//          Lego Dimensions, some hotel key cards). The portal can detect
//          these but sometimes ghosts one physical tag onto multiple slot
//          positions (apparently a firmware quirk triggered by certain
//          NTAG anti-collision responses — unpredictable per-tag).
//   0x01 — A MIFARE Classic tag with a 7-byte UID (e.g. Skylanders).
//   0x08 — A MIFARE Classic tag with a 4-byte UID (e.g. older hotel keys).
//   0x09 — A MIFARE Mini/Classic tag that MIFARE-authenticated against the
//          portal's built-in Disney Key A — i.e. an authenticated Disney
//          Infinity figure.
//
// Any non-0x09 value is treated as "foreign / unreadable" at the driver
// level: the portal won't expose block data for those tags, we only get
// the UID via GET_FIGURE_UID. Block reads on any foreign marker
// (confirmed for 0x00, 0x01, and 0x08) return 0x82 "invalid position"
// regardless of (block, U) args — the portal's firmware reserves full
// block access exclusively for tags that MIFARE-authenticated as Disney.
export const MARKER = {
  NDEF_NTAG: 0x00,
  FOREIGN_MIFARE: 0x01,
  MIFARE_CLASSIC_4BYTE: 0x08,
  DISNEY_INFINITY: 0x09,
} as const;

export const PACKET_SIZE = 32;
export const REQ_MARKER = 0xff;
export const RES_MARKER = 0xaa;
export const ASYNC_MARKER = 0xab;

// "(c) Disney 2013" — sent as the payload of the ACTIVATE command.
export const ACTIVATION_STRING = new Uint8Array([
  0x28, 0x63, 0x29, 0x20, 0x44, 0x69, 0x73, 0x6e, 0x65, 0x79, 0x20, 0x32, 0x30,
  0x31, 0x33,
]);

export const COMMAND_TIMEOUT_MS = 2000;

export const DEVICE_FILTERS: HIDDeviceFilter[] = [
  { vendorId: 0x0e6f, productId: 0x0129 },
];

// Slot masks in the high nibble of the byte returned by GET_PRESENT_FIGURES.
export const SLOT = {
  HEXAGON: 0x10,
  PLAYER_ONE: 0x20,
  PLAYER_TWO: 0x30,
} as const;

export function slotName(slotByte: number): string {
  switch (slotByte & 0xf0) {
    case SLOT.HEXAGON:
      return "hexagon";
    case SLOT.PLAYER_ONE:
      return "player 1";
    case SLOT.PLAYER_TWO:
      return "player 2";
    default:
      return `unknown (0x${slotByte.toString(16).padStart(2, "0")})`;
  }
}

/** Map a slot byte to the LED panel index used by SET_LED / FADE_LED / FLASH_LED. */
export function slotPanel(slotByte: number): 1 | 2 | 3 | null {
  switch (slotByte & 0xf0) {
    case SLOT.HEXAGON:
      return 1;
    case SLOT.PLAYER_ONE:
      return 2;
    case SLOT.PLAYER_TWO:
      return 3;
    default:
      return null;
  }
}

export type Position = 1 | 2 | 3;

export function positionName(position: Position): string {
  switch (position) {
    case 1:
      return "hexagon";
    case 2:
      return "player 1";
    case 3:
      return "player 2";
  }
}

export interface TagEvent {
  position: Position;
  order: number;
  added: boolean;
  kind: "authenticated" | "unreadable";
}
