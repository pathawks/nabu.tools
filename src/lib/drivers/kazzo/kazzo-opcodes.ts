/**
 * Kazzo NES/Famicom cartridge dumper — USB protocol constants.
 *
 * Kazzo is the NES dumper designed by naruko (circa 2010); anago is the
 * original command-line host software. AVR-based INL Retro boards (v1.x,
 * pre-2018) can be reflashed with Kazzo firmware and operated via this
 * protocol as an alternative to the INL dictionary protocol.
 *
 * These are interface facts — vendor request numbers and the wire format —
 * reimplemented from the documented USB protocol, not ported from the
 * (GPL-2.0-only) firmware sources:
 *   github.com/sharkpp/unagi_kazzo/blob/master/firmware/usbrequest.txt
 *   github.com/zerkerX/anago/blob/master/kazzo/kazzo_request.h
 */

// ─── Vendor/device USB descriptors ──────────────────────────────────────────

/**
 * V-USB's shared obdev defaults. Kazzo and INL firmwares both use this
 * VID/PID pair; disambiguate by the iProduct string at device-open time.
 */
export const KAZZO_DEVICE_FILTER = {
  vendorId: 0x16c0,
  productId: 0x05dc,
} as const;

/** iProduct descriptor value reported by Kazzo firmware. */
export const KAZZO_PRODUCT_NAME = "kazzo";

// ─── Request opcodes (bRequest) ─────────────────────────────────────────────

/** Vendor control-transfer request numbers (from `kazzo_request.h`). */
export const REQUEST = {
  ECHO: 0,
  PHI2_INIT: 1,
  CPU_READ_6502: 2,
  CPU_READ: 3,
  CPU_WRITE_6502: 4,
  CPU_WRITE_FLASH: 5,
  PPU_READ: 6,
  PPU_WRITE: 7,
  FLASH_STATUS: 8,
  FLASH_CONFIG_SET: 9,
  FLASH_PROGRAM: 10,
  FLASH_ERASE: 11,
  FLASH_DEVICE: 12,
  VRAM_CONNECTION: 13,
  DISK_STATUS_GET: 14,
  DISK_READ: 15,
  DISK_WRITE: 16,
  FIRMWARE_VERSION: 0x80,
  FIRMWARE_PROGRAM: 0x81,
  FIRMWARE_DOWNLOAD: 0x82,
} as const;

/**
 * Request numbers that PROGRAM/ERASE a cartridge's flash or firmware.
 * nabu is a read-only dumper and never issues these; KazzoDevice refuses
 * them, mirroring the INL driver's flash-write guard.
 */
export const FLASH_WRITE_REQUESTS: ReadonlySet<number> = new Set([
  REQUEST.CPU_WRITE_FLASH,
  REQUEST.FLASH_CONFIG_SET,
  REQUEST.FLASH_PROGRAM,
  REQUEST.FLASH_ERASE,
  REQUEST.DISK_WRITE,
  REQUEST.FIRMWARE_PROGRAM,
  REQUEST.FIRMWARE_DOWNLOAD,
]);

// ─── Region selector (wIndex) ───────────────────────────────────────────────

/**
 * wIndex values used by memory-access opcodes to pick which bus/region the
 * request targets. `IMPLIED` is used for the plain read/write opcodes that
 * already imply a bus via their request number.
 */
export const INDEX = {
  IMPLIED: 0,
  CPU: 1,
  PPU: 2,
  BOTH: 3,
} as const;

// ─── Protocol constants ─────────────────────────────────────────────────────

/**
 * Maximum bytes per single control transfer. Firmware buffers a page at a
 * time; the host loops across pages for larger regions.
 */
export const READ_PACKET_SIZE = 0x100;

/** Firmware version string length returned by FIRMWARE_VERSION. */
export const VERSION_STRING_SIZE = 0x20;

/**
 * Outgoing write data is XORed with this byte before transfer. V-USB
 * occasionally loses bits during long runs of 0xFF, so naruko masks
 * outgoing bytes to break up such runs; the firmware un-masks on receive.
 * Reads are NOT XORed.
 */
export const WRITE_XOR_MASK = 0xa5;

// ─── VRAM A10 / nametable mirroring ─────────────────────────────────────────

/**
 * VRAM_CONNECTION returns a 4-bit pattern encoding how the cartridge wires
 * PPU A10/A11 to CIRAM A10. Per usbrequest.txt the possible values are
 * {0x00, 0x05, 0x09, 0x0F}.
 *
 * The reference host (anago/script_dump.c) only distinguishes 0x05 from
 * everything else: 0x05 is vertical, any other value is horizontal.
 * Single-screen mirroring is mapper-controlled on the carts that use it,
 * so the hardware probe can't see it directly.
 */
export const VRAM_VERTICAL = 0x05;
