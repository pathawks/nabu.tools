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

/**
 * Additional opcodes the official EMS Windows app uses but the public
 * ndsplus reference does not document. Kept here as documentation of
 * the device surface even though the driver does not use them. All
 * follow the standard 10-byte packet framing with MAGIC=0xA5 byte[1],
 * except UPGRADE_* which use different MAGIC values (see below).
 */
export const UNDOCUMENTED_CMD = {
  /** Tell MCU to drop cart power. App sleeps 1000 ms before next op. */
  EJECT: 0x5f,
  /** Auth/challenge step 1 (encrypted-cart handshake). */
  AUTH_1: 0x3c,
  /** Auth/challenge step 2. */
  AUTH_2: 0x4f,
  /** Auth/challenge step 3 — response is 64 bytes (session key). */
  AUTH_3: 0x1f,
  /** Encrypted bulk save-read (2320-byte XOR stream after read). */
  ENCRYPTED_READ: 0x2b,
  /** Variant of ENCRYPTED_READ for a different chip family. */
  ENCRYPTED_READ_ALT: 0xaf,
  /** Encrypted 512 B save chunk — requires AUTH_1..3 to have run. */
  ENCRYPTED_READ_512: 0xb7,
} as const;

/**
 * Firmware upgrade opcode. **All upgrade packets use opcode 0x55 but
 * switch the MAGIC byte from 0xA5 to one of {0xAA, 0x40, 0x20, 0x80}**
 * to indicate which upgrade operation is being performed:
 *
 *   0xAA = enter-bootloader (no payload)
 *   0x40 = erase-page at addr  (13 pages × 512 B starting at 0xE000)
 *   0x20 = program-page at addr (followed by 512 B page payload)
 *   0x80 = finish / reboot into new firmware
 *
 * Crucially, **the device stays enumerated as the EMS vendor-bulk
 * device through the entire upgrade** — it does NOT re-enumerate as
 * HID. So a driver could theoretically implement firmware upgrade
 * over the existing bulk endpoints. Not currently implemented here
 * because bricking-on-failure is a risk that needs explicit user
 * consent + recovery tooling.
 */
export const UPGRADE = {
  OPCODE: 0x55,
  MAGIC_ENTER: 0xaa,
  MAGIC_ERASE: 0x40,
  MAGIC_PROGRAM: 0x20,
  MAGIC_FINISH: 0x80,
  PAGE_SIZE: 512,
  PAGE_COUNT: 13,
  FLASH_BASE: 0xe000,
} as const;

/** Magic/sync byte — byte 1 of every *normal-mode* command. */
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

/**
 * Decode the firmware-version word returned in statusBytes[6,7].
 *
 * The word is little-endian (hi*256 + lo). Observed on real hardware:
 * v3.04 returns raw=304, so the firmware packs it as major*100 + minor.
 * This matches the public archive naming (v2.1, v3.01, v3.02, ... v3.05).
 * Treat `raw` as authoritative and the {major, minor} decode as best-effort.
 */
export interface FirmwareVersion {
  raw: number;
  major: number;
  minor: number;
  /**
   * Bit 7 of statusBytes[7]. The official EMS Windows app treats this
   * bit as a "firmware is in recovery state" indicator: when set, the
   * app displays `"error code : 1001A"` and disables every operation
   * (no backup, no restore, no upgrade button responses). So this is
   * NOT a cosmetic release/beta flag — it's a hard signal that the
   * adapter's firmware is damaged or mid-update and should not be
   * commanded.
   *
   * We still surface it rather than throwing, because "the adapter
   * replied but its firmware is degraded" is distinct from "can't
   * reach the adapter at all" and the caller (scanner UI) may want
   * to show a different error than a connection failure.
   */
  recovery: boolean;
  /** Display form, e.g. "v3.04" (or "v3.04R" when recovery bit set). */
  display: string;
}

export function parseFirmwareVersion(
  statusBytes6: number,
  statusBytes7: number,
): FirmwareVersion {
  const recovery = (statusBytes7 & 0x80) !== 0;
  const raw = (statusBytes7 & 0x7f) * 256 + statusBytes6;
  const major = Math.floor(raw / 100);
  const minor = raw % 100;
  const display =
    `v${major}.${minor.toString().padStart(2, "0")}` + (recovery ? "R" : "");
  return { raw, major, minor, recovery, display };
}
