// PowerSaves for 3DS — HID command bytes and packet framing.
// Protocol reverse-engineered by kitlith: github.com/kitlith/powerslaves (MIT).
//
// Packet framing (64-byte HID output report, report-id 0x00):
//   byte 0    : opcode
//   bytes 1-2 : command length  (little-endian)
//   bytes 3-4 : response length (little-endian)
//   bytes 5+  : command bytes, zero-padded to 64
//
// Opcode `0x08` triggers ARM SYSRESETREQ (confirmed 2026-04-23: device
// disconnects in ~140 ms, re-enumerates as bcdDevice 0x0011 normal-mode in
// ~236 ms total). We use it as a soft-reset primitive. Opcode `0x09` has
// the same handler on the stub; if kept in the running firmware it would
// also trigger reset. Opcode `0x99` plus a magic sequence triggers
// firmware reflash — the `99 44 46 55` prefix kitlith documented drops
// the device into bcdDevice 0.01 recovery mode. Never send `0x99`.

export const CMD = {
  /** Returns a 64-byte device identifier starting with ASCII "App". */
  TEST: 0x02,
  /** ARM SYSRESETREQ — soft-reset the MCU. USB re-enumerates ~236 ms later. */
  RESET: 0x08,
  /** Reset the MCU so a mode change can be issued. */
  SWITCH_MODE: 0x10,
  /** Enable cartridge-ROM protocol (NTR/CTR). */
  ROM_MODE: 0x11,
  /** Enable SPI passthrough to the save chip. */
  SPI_MODE: 0x12,
  /** NDS cartridge-ROM command (fixed 8 command bytes). */
  NTR: 0x13,
  /** 3DS cartridge-ROM command (fixed 16 command bytes). Not used here. */
  CTR: 0x14,
  /** Raw SPI passthrough (variable command length). */
  SPI: 0x15,
} as const;

export const PACKET_SIZE = 64;
export const COMMAND_TIMEOUT_MS = 2000;

/** NTR ROM-protocol commands — byte 0 is the opcode, rest zero-padded. */
export const NTR_CMD = {
  /** Read 0x200-byte chunk from current ROM address (no args). */
  READ_ROM: 0x00,
  /** Read 4-byte chip ID. */
  GET_CHIP_ID: 0x90,
} as const;

/** Standard SPI save-chip opcodes. */
export const SPI_CMD = {
  /** Read status register (1 reply byte). */
  RDSR: 0x05,
  /** Read data starting at 3-byte address (reply length = bytes wanted). */
  READ: 0x03,
  /** JEDEC ID query (3 reply bytes). FLASH only; EEPROM returns zeros. */
  JEDEC_ID: 0x9f,
} as const;

/**
 * Decode FLASH capacity byte (third byte of JEDEC response) to size in bytes.
 * Common NDS save-FLASH chips:
 *   0x13 = 512 KB   0x14 = 1 MB   0x15 = 2 MB   0x16 = 4 MB
 */
export function flashSizeFromJedec(capacityByte: number): number | null {
  if (capacityByte < 0x10 || capacityByte > 0x1f) return null;
  return 1 << capacityByte;
}

export const DEVICE_FILTERS: HIDDeviceFilter[] = [
  { vendorId: 0x1c1a, productId: 0x03d5 }, // Datel PowerSaves for 3DS
];
