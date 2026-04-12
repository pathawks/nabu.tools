/**
 * EMS NDS Adapter+ — protocol constants and save type definitions.
 *
 * Protocol reverse-engineered by Thulinma (github.com/Thulinma/ndsplus).
 * All communication uses USB bulk transfers with 10-byte command packets.
 *
 * WARNING: This device shares VID/PID with the EMS Game Boy USB 64M Smart Card.
 * They have completely different protocols — the driver validates via the
 * status response marker byte (0xAA at offset 5).
 */

export const EMS_NDS_VID = 0x4670;
export const EMS_NDS_PID = 0x9394;

export const EMS_NDS_FILTER = {
  vendorId: EMS_NDS_VID,
  productId: EMS_NDS_PID,
};

/** Command codes — byte 0 of the 10-byte packet. */
export const CMD = {
  GET_STATUS: 0x9c,
  PREPARE_1: 0x9f,
  PREPARE_2: 0x90,
  READ_HEADER: 0x00,
  READ_SAVE: 0x2c,
  WRITE_SAVE: 0x7b,
  ERASE_A: 0x5b, // For save type 0x93
  ERASE_B: 0x5e, // For save types 0x53, 0xA3
} as const;

/** Magic/sync byte — always byte 1 of every command. */
export const MAGIC = 0xa5;

/** Byte 5 of status response is always 0xAA on genuine NDS adapters. */
export const STATUS_MARKER = 0xaa;

/** Save type byte when no card is inserted. */
export const NO_CARD = 0xff;

/** Device returns 512 bytes per read command. */
export const READ_CHUNK = 512;

/** Device accepts 256 bytes per write command. */
export const WRITE_CHUNK = 256;

/** Known EEPROM save types with fixed sizes. */
export const EEPROM_SIZES: Record<number, { name: string; size: number }> = {
  0x01: { name: "EEPROM", size: 512 },
  0x02: { name: "EEPROM", size: 8_192 },
  0x12: { name: "EEPROM", size: 65_536 },
};

/** FLASH save types that require an erase command before each write. */
export const FLASH_ERASE_CMD: Partial<Record<number, number>> = {
  0x93: CMD.ERASE_A,
  0x53: CMD.ERASE_B,
  0xa3: CMD.ERASE_B,
};
