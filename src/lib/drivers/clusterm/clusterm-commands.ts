/**
 * Famicom Dumper/Writer (ClusterM) — wire-protocol constants.
 *
 * The device is a USB-CDC serial dumper built around an STM32F103ZET +
 * EPM3064 CPLD that memory-maps the cartridge's CPU and PPU buses through
 * the MCU's FSMC, with every PRG access synchronized to a free-running
 * ~1.8 MHz M2 clock — a faithful 2A03 bus simulation. Command IDs and
 * framing are derived from the GPL-3.0 famicom-dumper-client
 * (github.com/ClusterM/famicom-dumper-client,
 * FamicomDumperConnection/FamicomDumperLocal.cs + SerialClient.cs).
 *
 * Frame format, both directions:
 *   0x46 ('F') · command · length LE16 · payload · CRC-8
 * The CRC is Dallas/Maxim 1-Wire (reflected poly 0x8C, init 0) over every
 * preceding byte; a received frame is valid when the CRC over the WHOLE
 * frame, trailing byte included, comes out 0.
 */

/** WebSerial chooser filter — pid.codes VID, "Famicom Dumper/Writer". */
export const DEVICE_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x1209, usbProductId: 0xbaba },
];

/** Frame start byte ('F'). */
export const MAGIC = 0x46;

/**
 * Nominal baud rate from the reference client. The device is a true
 * USB-CDC ACM function, so the rate is ignored on the wire, but
 * `SerialPort.open` requires one.
 */
export const BAUD_RATE = 250_000;

/**
 * Complete command set (protocol version 5, firmware 3.4). Unreferenced
 * entries are kept deliberately — they document the device surface
 * (flash/FDS writing, on-device CRC reads) for future use.
 */
export const CMD = {
  /** Reply to PRG_INIT: payload carries protocol/firmware/hardware versions. */
  STARTED: 0,
  /** Deprecated init ack from pre-3.x firmware. */
  CHR_STARTED: 1,
  ERROR_INVALID: 2,
  ERROR_CRC: 3,
  ERROR_OVERFLOW: 4,
  /** Init/version handshake; also resets COOLBOY GPIO mode device-side. */
  PRG_INIT: 5,
  CHR_INIT: 6,
  /** payload: addr LE16 · length LE16 → PRG_READ_RESULT with the bytes. */
  PRG_READ_REQUEST: 7,
  PRG_READ_RESULT: 8,
  /** payload: addr LE16 · length LE16 · data → PRG_WRITE_DONE. */
  PRG_WRITE_REQUEST: 9,
  PRG_WRITE_DONE: 10,
  /** payload: addr LE16 · length LE16 → CHR_READ_RESULT with the bytes. */
  CHR_READ_REQUEST: 11,
  CHR_READ_RESULT: 12,
  /** payload: addr LE16 · length LE16 · data → CHR_WRITE_DONE. */
  CHR_WRITE_REQUEST: 13,
  CHR_WRITE_DONE: 14,
  /** → MIRRORING_RESULT: CIRAM A10 at PPU $2000/$2400/$2800/$2C00. */
  MIRRORING_REQUEST: 17,
  MIRRORING_RESULT: 18,
  /** Float the cart bus (M2 included) for ~500 ms — a console reset. */
  RESET: 19,
  RESET_ACK: 20,
  // COOLBOY/COOLGIRL + UNROM-512 flash writing and on-device CRC reads —
  // unused by the dump paths but part of the firmware surface.
  FLASH_ERASE_SECTOR_REQUEST: 37,
  FLASH_WRITE_REQUEST: 38,
  /** Like PRG_READ_REQUEST but answers PRG_READ_RESULT with a CRC16. */
  PRG_CRC_READ_REQUEST: 39,
  /** Like CHR_READ_REQUEST but answers CHR_READ_RESULT with a CRC16. */
  CHR_CRC_READ_REQUEST: 40,
  FLASH_WRITE_ERROR: 41,
  FLASH_WRITE_TIMEOUT: 42,
  FLASH_ERASE_ERROR: 43,
  FLASH_ERASE_TIMEOUT: 44,
  // Famicom Disk System, via the RAM adapter cabled into the cart slot
  // (protocol >= 3). Block payloads exclude the on-disk CRC; read-result
  // frames append CrcOk + EndOfHeadMeet trailer bytes.
  FDS_READ_REQUEST: 45,
  FDS_READ_RESULT_BLOCK: 46,
  FDS_READ_RESULT_END: 47,
  FDS_TIMEOUT: 48,
  FDS_NOT_CONNECTED: 49,
  FDS_BATTERY_LOW: 50,
  FDS_DISK_NOT_INSERTED: 51,
  FDS_END_OF_HEAD: 52,
  FDS_WRITE_REQUEST: 53,
  FDS_WRITE_DONE: 54,
  SET_FLASH_BUFFER_SIZE: 55,
  SET_VALUE_DONE: 56,
  FDS_DISK_WRITE_PROTECTED: 57,
  FDS_BLOCK_CRC_ERROR: 58,
  /** Reroute $8000+ writes to the COOLBOY flash /WE header (protocol >= 4). */
  COOLBOY_GPIO_MODE: 59,
  UNROM512_ERASE_REQUEST: 60,
  UNROM512_WRITE_REQUEST: 61,
  /** Debug chatter from DEBUG firmware builds; may interleave anywhere. */
  DEBUG: 0xff,
} as const;

/**
 * Dallas/Maxim 1-Wire CRC-8 (reflected poly 0x8C, init 0) — the frame
 * checksum. Transcribed from SerialClient.cs.
 */
export function crc8(data: Uint8Array | number[]): number {
  let crc = 0;
  for (let inbyte of data) {
    for (let i = 0; i < 8; i++) {
      const mix = (crc ^ inbyte) & 0x01;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      inbyte >>= 1;
    }
  }
  return crc;
}

/** Build a complete frame: magic · command · length LE16 · payload · CRC. */
export function buildFrame(
  command: number,
  payload: Uint8Array | number[] = [],
): Uint8Array {
  // The length field is LE16; a longer payload would wrap it while the
  // frame still carries every byte, desyncing the device's byte stream.
  if (payload.length > 0xffff) {
    throw new Error(
      `ClusterM frame payload too large: ${payload.length} bytes exceeds the 0xFFFF LE16 length field`,
    );
  }
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = MAGIC;
  frame[1] = command;
  frame[2] = payload.length & 0xff;
  frame[3] = (payload.length >> 8) & 0xff;
  frame.set(payload, 4);
  frame[frame.length - 1] = crc8(frame.subarray(0, frame.length - 1));
  return frame;
}
