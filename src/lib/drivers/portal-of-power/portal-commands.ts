// Skylanders Portal of Power — HID protocol constants.
//
// Protocol reference: Dolphin Emulator's Skylander.cpp (GPL-2.0-or-later)
//   https://github.com/dolphin-emu/dolphin/blob/master/Source/Core/Core/IOS/USB/Emulated/Skylanders/Skylander.cpp
//
// Wire format:
//   Every HID report, both directions, is exactly 32 bytes. Byte 0 is an
//   ASCII opcode letter; the remaining bytes are either arguments (host →
//   device) or a status/response payload (device → host). There is no
//   length prefix, no sequence number, and no checksum — dispatch is keyed
//   purely on byte 0.
//
// The portal sends unsolicited `S` (0x53) status reports at ~10 Hz while
// open. Command responses echo the command byte (e.g. `Q` request → `Q`
// response), so with commands serialized one-at-a-time we can match a
// response to its request simply by filtering status reports out of the
// input stream.

/** All host→device and device→host reports are exactly 32 bytes. */
export const PACKET_SIZE = 32;

export const DEVICE_FILTERS: HIDDeviceFilter[] = [
  // Wireless Wii dongle, and every wired Giants/SwapForce/Trap Team/
  // SuperChargers/Imaginators portal. The 2011 wired portal uses a
  // different product id and is left out until it can be tested.
  { vendorId: 0x1430, productId: 0x0150 },
];

/**
 * Host → device opcodes.
 *
 * `A`, `C`, `Q`, `R`, `S`, `W` work on every portal model. `J`, `L`, `M`
 * are Trap Team and later; older hardware silently drops unknown opcodes,
 * but sending them is wasted traffic. Kept here to document the surface.
 */
export const CMD = {
  /** Enable/disable figure scanning. `A 01` on, `A 00` off. */
  ACTIVATE: 0x41,
  /** Set the center-ring LED color. `C RR GG BB`. No response. */
  COLOR: 0x43,
  /**
   * Set a sided LED with fade (Trap Team +).
   *   `J <side> RR GG BB <fade_ms_lo> <fade_ms_hi>`
   *   side: 0x00 = right, 0x02 = left.
   */
  LED_FADE: 0x4a,
  /**
   * Set a zoned LED (Trap Team +).
   *   `L <pos> RR GG BB`
   *   pos: 0x00 = right, 0x01 = trap LED (white-only), 0x02 = left.
   */
  LED_ZONE: 0x4c,
  /** Query audio firmware (Trap Team wired only, portals with a speaker). */
  AUDIO_FIRMWARE: 0x4d,
  /**
   * Read one 16-byte tag block.
   *   Request:  `Q <idx> <block>` where `idx = 0x10 | slot` (slot 0–15).
   *   Response success: `Q <idx> <block> <16 bytes data>`.
   *   Response failure: `Q 0x01 <block> …` (byte 1 is 0x01 instead of idx).
   */
  QUERY_BLOCK: 0x51,
  /** Re-scan the portal. Response: `R 02 <hw_rev> …` — a cheap probe. */
  RESET: 0x52,
  /** Ask the portal to emit one Status report immediately. */
  STATUS: 0x53,
  /** Write a 16-byte tag block. `W <idx> <block> <16 bytes>`. */
  WRITE_BLOCK: 0x57,
} as const;

/**
 * Device → host opcodes. Most echo the host opcode; `S` is the only
 * unsolicited channel.
 */
export const RESP = {
  ACTIVATE: 0x41,
  QUERY_BLOCK: 0x51,
  RESET: 0x52,
  /** Unsolicited ~10 Hz presence/state report. */
  STATUS: 0x53,
  WRITE_BLOCK: 0x57,
  /**
   * Wireless-only: emitted by the dongle when the wireless base goes out
   * of range. Does not occur on wired portals.
   */
  OUT_OF_RANGE: 0x5a,
} as const;

/** Number of simultaneous figure slots the portal tracks. */
export const MAX_SLOTS = 16;

/** MIFARE Classic 1K — 64 blocks × 16 bytes. */
export const BLOCKS_PER_FIGURE = 64;
export const BLOCK_SIZE = 16;
export const FIGURE_SIZE = BLOCKS_PER_FIGURE * BLOCK_SIZE; // 1024

/**
 * Byte offsets within tag block 1 (figure identity block, plaintext).
 *   figure_id  — u16 LE at 0x00–0x01, identifies the character model.
 *   variant_id — u16 LE at 0x0C–0x0D, distinguishes reposes/Legendary/etc.
 */
export const BLOCK1_FIGURE_ID_OFFSET = 0x00;
export const BLOCK1_VARIANT_ID_OFFSET = 0x0c;

/**
 * Portal-assigned slot index as transmitted on the wire.
 * The low nibble is the actual slot (0..15); the high nibble is always 1.
 */
export function slotToIdx(slot: number): number {
  return 0x10 | (slot & 0x0f);
}

/**
 * Per-slot state codes used in the Status bitmap. The portal transmits
 * `ADDED` and `REMOVED` as one-shot transitions — the next Status report
 * will promote them to `PRESENT` or `EMPTY` respectively.
 */
export const SlotState = {
  EMPTY: 0b00,
  PRESENT: 0b01,
  REMOVED: 0b10,
  ADDED: 0b11,
} as const;
export type SlotState = (typeof SlotState)[keyof typeof SlotState];

/** Decoded Status report. */
export interface StatusReport {
  /** Per-slot state for all 16 slots, index 0 = slot 0. */
  slots: SlotState[];
  /** Monotonic u8 that wraps; increments on every Status the portal emits. */
  counter: number;
  /** Whether the portal is currently scanning (reflects the last `A` state). */
  activated: boolean;
}

/**
 * Decode a 32-byte Status report.
 *
 * Layout:
 *   byte 0     : 0x53 'S'
 *   bytes 1..4 : little-endian u32, 2 bits per slot × 16 slots
 *   byte 5     : interrupt counter (u8)
 *   byte 6     : 0x01 if activated, 0x00 otherwise
 *   bytes 7+   : 0x00 padding
 */
export function decodeStatus(bytes: Uint8Array): StatusReport {
  const bitmap =
    (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0;
  const slots: SlotState[] = new Array(MAX_SLOTS);
  for (let i = 0; i < MAX_SLOTS; i++) {
    slots[i] = ((bitmap >>> (i * 2)) & 0b11) as SlotState;
  }
  return {
    slots,
    counter: bytes[5],
    activated: bytes[6] === 0x01,
  };
}

export interface SlotEvent {
  slot: number;
  kind: "added" | "removed";
}

/**
 * Diff two consecutive Status reports and synthesize placed/removed events.
 *
 * The portal itself reports one-shot ADDED/REMOVED codes, but relying on
 * them alone means we'd miss transitions that landed between our polling
 * windows (e.g. figure placed then lifted faster than a Status round-trip).
 * Walking the slot-state delta is authoritative. Passing `prev = null`
 * yields an `added` for every currently-occupied slot — handy for seeding
 * a freshly-mounted scanner from `currentStatus`.
 */
export function diffStatus(
  prev: StatusReport | null,
  next: StatusReport,
): SlotEvent[] {
  const events: SlotEvent[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const prevOccupied =
      prev !== null &&
      (prev.slots[i] === SlotState.PRESENT ||
        prev.slots[i] === SlotState.ADDED);
    const nextOccupied =
      next.slots[i] === SlotState.PRESENT || next.slots[i] === SlotState.ADDED;
    if (!prevOccupied && nextOccupied) events.push({ slot: i, kind: "added" });
    else if (prevOccupied && !nextOccupied)
      events.push({ slot: i, kind: "removed" });
  }
  return events;
}

/** Wait time for a command response before giving up. */
export const COMMAND_TIMEOUT_MS = 2000;

/** Fail-fast timeout for the initial Reset probe. */
export const RESET_TIMEOUT_MS = 1000;
