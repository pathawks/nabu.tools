// PowerSaves for Amiibo portal — HID command bytes
// Core protocol reverse-engineered from https://github.com/malc0mn/amiigo (Go).
// Additional opcodes (GET_IDENTIFIER, FREEZE, PRF_*) discovered by sweeping
// all 256 opcodes with an NTAG215 Amiibo, a MIFARE Classic figure, and no
// tag placed on the portal.
//
// Pipelining hazard: the portal's HID response slot is shared with its RF
// transceive pipeline. A slow NFC command (e.g. READ_SIGNATURE's ~32-byte
// response) can land in the HID receive slot for a LATER opcode, making
// that opcode look like it returned real tag data. Any "new command"
// hypothesis from fuzzing needs to be reconfirmed with a fresh activation
// and no intervening tag-read opcodes — otherwise you're just seeing a
// late 0x1c / 0x21 reply leak through.

export const CMD = {
  /**
   * Returns the ASCII string "NFC-Portal" padded with NULs in the first
   * ~10 bytes of the response (same string as the USB iProduct descriptor,
   * surfaced via HID). Tag-independent; works with no RF active.
   * (undocumented)
   */
  GET_IDENTIFIER: 0x02,

  /**
   * ACKs with an all-zero response, but then hangs the portal firmware —
   * subsequent sendReport() calls return NotAllowedError until the USB
   * device is closed and reopened. DO NOT CALL. (undocumented)
   */
  FREEZE: 0x08,

  RF_FIELD_ON: 0x10,
  RF_FIELD_OFF: 0x11,
  GET_TOKEN_UID: 0x12,
  READ: 0x1c,
  UNKNOWN4: 0x1e,
  UNKNOWN1: 0x1f,
  SET_LED_STATE: 0x20,

  /**
   * Issues the NTAG READ_SIG command and returns the tag's 32-byte ECC
   * signature at response bytes 2..33. Deterministic per physical chip
   * (tied to the silicon UID). Used by the init dance, but the signature
   * bytes can also be captured for NXP-authenticity verification.
   */
  READ_SIGNATURE: 0x21,

  MAKE_KEY: 0x30,

  /**
   * Pseudo-random function: returns 16 bytes of deterministic, uniform-
   * looking output keyed by the entire packet after the opcode byte
   * (all 63 following bytes contribute, not just args[0]). Identical
   * output survives tag removal, RF off, and USB close+reopen — so the
   * function is purely firmware-internal, not a tag transceive.
   * 0x80 and 0x90 give different per-op constants; both reproduce exactly
   * across sessions with an Amiibo, a MIFARE tag, and no tag at all.
   * Probably an AES/hash primitive exposed to Datel's PowerSaves PC app
   * for device-auth or DRM. NOT a way to read tag blocks. (undocumented)
   */
  PRF_A: 0x80,
  PRF_B: 0x90,
} as const;

// Opcodes observed to return the constant `ff ff 00 00 …` regardless of
// the rest of the packet: 0x9b, 0x9e, 0xa0 (sometimes 0x9f). Purpose
// unknown; may be feature-flag probes used by Datel's PC app.
//
// 0x9d returned real 16-byte data with a MIFARE Classic tag but zeros
// with an Amiibo or no tag. Not reproducible in isolation after fresh
// activation — probably a pipelining artifact (see header) rather than
// a genuine MIFARE-specific command. Left undocumented in CMD.
//
// MIFARE Classic note: block reads are fundamentally unreachable through
// this device. The firmware implements NTAG page reads (CMD.READ) but
// exposes no MIFARE AUTH_A/B surface through any of the 256 opcodes, so
// a Disney Infinity / Skylanders / hotel-key tag's block content cannot
// be read even though the portal hardware is ISO14443-A capable. Only
// the 7-byte UID (via CMD.GET_TOKEN_UID) is retrievable for such tags.

export const PACKET_SIZE = 64;
export const PAD_BYTE = 0xcd;
export const NTAG215_SIZE = 540;
export const COMMAND_TIMEOUT_MS = 2000;

export const DEVICE_FILTERS: HIDDeviceFilter[] = [
  { vendorId: 0x1c1a, productId: 0x03d9 }, // Datel PowerSaves for Amiibo
];
