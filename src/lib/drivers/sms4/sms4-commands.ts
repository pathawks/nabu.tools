/**
 * Neoflash SMS4 — protocol constants and packet builders. See
 * `sms4-driver.ts` for the wire-level protocol description.
 */

export const SMS4_VID = 0xffab;
export const SMS4_PID = 0xdd03;

export const DEVICE_FILTERS = [{ vendorId: SMS4_VID, productId: SMS4_PID }];

/**
 * Bulk endpoint *numbers* (1-15) as WebUSB expects them on transferIn /
 * transferOut. Direction is implicit in the WebUSB API: transferIn always
 * targets an IN endpoint, transferOut always OUT. On the wire these
 * correspond to USB descriptor addresses 0x81 (EP1 IN) and 0x02 (EP2 OUT).
 */
export const ENDPOINT = {
  IN: 1,
  OUT: 2,
} as const;

/**
 * Vendor control-transfer opcodes (bRequest). All use bmRequestType
 * 0x40 (vendor OUT) or 0xC0 (vendor IN).
 */
export const VENDOR_CTRL = {
  /**
   * "Open session" handshake (bmReqType=0xC0, wValue=0x0001, wLength=0,
   * no data stage). Issued once per session. Without it the device
   * firmware accepts cart packets but never produces responses — bulk
   * INs hang waiting indefinitely.
   */
  OPEN_SESSION: 0xa3,
  /**
   * Query bulk status (bmReqType=0xC0, wValue=0x0001, returns 8 bytes).
   * Used as a liveness check + firmware-version probe at init time, and
   * polled after errors to wait for status byte 0 bit 3 ("ready") before
   * retrying.
   */
  QUERY_STATUS: 0xa2,
} as const;

/**
 * Cart-bus command packet — 32 bytes.
 *
 * The device wraps every cart-bus operation in this 32-byte envelope.
 * The leading `0x60 0xA5` opcode tells the firmware "this is a slot-1
 * cart-bus passthrough"; bytes 11..18 carry the 8-byte NDS NTR command
 * verbatim (big-endian on the wire); bytes 6..9 advertise how many
 * bytes the cart will reply with on the next bulk-IN.
 *
 * Field map:
 *   [ 0..1 ] = 0x60 0xA5  — cart-bus passthrough opcode
 *   [ 2..5 ] = extra/addr (LE; often 0; some commands use it as an offset)
 *   [ 6..9 ] = response length (LE; how many bytes to bulk-IN after)
 *   [10    ] = mode flag (0 = standard cart cmd; firmware-specific other values exist)
 *   [11..18] = 8-byte NDS NTR command (BE — cmd[0] is highest byte)
 *   [19    ] = subcommand (0 = normal; 0xF0 = cart reset)
 *   [20..31] = zero padding
 */
export const PACKET_LEN = 32;

/** Lead bytes of every cart-bus passthrough packet. */
export const PACKET_OPCODE = [0x60, 0xa5] as const;

/** Save-chip JEDEC RDID probe lead bytes (0x60 0xA0). Response is 9 bytes:
 *  family code + 3-byte JEDEC ID + flag bit + padding. Byte layout
 *  established empirically against the SMS4 firmware. */
export const PROBE_JEDEC_OPCODE = [0x60, 0xa0] as const;
export const PROBE_JEDEC_RESPONSE_LEN = 9;

/** Byte-19 subcommand selector. */
export const SUBCMD = {
  NORMAL: 0x00,
  RESET: 0xf0,
} as const;

/**
 * NDS NTR (slot-1) command bytes we exercise during header detection
 * and chip-ID readout. Reference:
 * https://problemkaputt.de/gbatek.htm#dscartridgeprotocol
 */
export const NTR_CMD = {
  /** Read header bytes (post-reset). 8 bytes of zero. */
  READ_HEADER: 0x00,
  /** Get cart Chip ID, post-reset. 4 bytes returned. */
  GET_CHIP_ID: 0x90,
  /** Dummy / wake-up command. */
  DUMMY: 0x9f,
} as const;

/** Status response from QUERY_STATUS — 8 bytes returned. */
export const STATUS_RESPONSE_LEN = 8;

/** NDS header is 0x200 bytes; smallest read that includes the CRC fields. */
export const HEADER_LEN = 0x200;

/** Chip ID response — 4 bytes from NTR 0x90. */
export const CHIP_ID_LEN = 4;

/**
 * Build a 32-byte cart-bus packet.
 *
 *   ntrCmd:        the 8-byte NDS command to forward to the cart (LSB-first
 *                  array; we BE-encode it into the packet).
 *   responseLen:   number of bytes the cart will return on the next bulk-IN.
 *   subcmd:        SUBCMD.NORMAL or SUBCMD.RESET.
 *   extra:         optional 4-byte field at offset 2 (some commands use it
 *                  as an offset; defaults to 0).
 */
export function buildCartPacket(opts: {
  ntrCmd: Uint8Array;
  responseLen: number;
  subcmd?: number;
  extra?: number;
}): Uint8Array {
  if (opts.ntrCmd.length !== 8) {
    throw new Error(`ntrCmd must be 8 bytes, got ${opts.ntrCmd.length}`);
  }
  const pkt = new Uint8Array(PACKET_LEN);
  pkt[0] = PACKET_OPCODE[0];
  pkt[1] = PACKET_OPCODE[1];

  const extra = opts.extra ?? 0;
  pkt[2] = extra & 0xff;
  pkt[3] = (extra >> 8) & 0xff;
  pkt[4] = (extra >> 16) & 0xff;
  pkt[5] = (extra >> 24) & 0xff;

  pkt[6] = opts.responseLen & 0xff;
  pkt[7] = (opts.responseLen >> 8) & 0xff;
  pkt[8] = (opts.responseLen >> 16) & 0xff;
  pkt[9] = (opts.responseLen >> 24) & 0xff;

  pkt[10] = 0;

  // NTR command is sent BIG-ENDIAN on the slot-1 bus, so cmd[0] (the
  // opcode byte like 0x90) goes to the highest position.
  pkt[11] = opts.ntrCmd[0];
  pkt[12] = opts.ntrCmd[1];
  pkt[13] = opts.ntrCmd[2];
  pkt[14] = opts.ntrCmd[3];
  pkt[15] = opts.ntrCmd[4];
  pkt[16] = opts.ntrCmd[5];
  pkt[17] = opts.ntrCmd[6];
  pkt[18] = opts.ntrCmd[7];

  pkt[19] = opts.subcmd ?? SUBCMD.NORMAL;
  // bytes [20..31] remain zero from the Uint8Array initializer.

  return pkt;
}

/** Build an 8-byte all-zero NTR header-read command. */
export function ntrReadHeader(): Uint8Array {
  return new Uint8Array(8);
}

/**
 * Build a 32-byte `60 A2` save-read packet. The SMS4 firmware uses the
 * 14-byte `cmdTable` to drive the cart's save-chip SPI lines (cmdTable[1]
 * is typically the SPI READ DATA opcode, byte 0 is the flag/family
 * selector that we patch at runtime).
 *
 * Packet layout:
 *   bytes 0..1   60 A2          save-read opcode
 *   bytes 2..5   address LE     where to start reading on the chip
 *   bytes 6..9   length  LE     how many bytes to return
 *   byte 10      flag (0x07 / 0x0F)   patched from cmdTable[0]
 *   bytes 11..23 cmdTable[1..13]      rest of the SPI command sequence
 *   bytes 24..31 zero padding
 */
export function buildSaveReadPacket(opts: {
  cmdTable: readonly number[];
  flag: 0x07 | 0x0f;
  address: number;
  length: number;
}): Uint8Array {
  if (opts.cmdTable.length !== 14) {
    throw new Error(
      `cmdTable must be 14 bytes, got ${opts.cmdTable.length}`,
    );
  }
  const pkt = new Uint8Array(PACKET_LEN);
  pkt[0] = 0x60;
  pkt[1] = 0xa2;
  pkt[2] = opts.address & 0xff;
  pkt[3] = (opts.address >> 8) & 0xff;
  pkt[4] = (opts.address >> 16) & 0xff;
  pkt[5] = (opts.address >> 24) & 0xff;
  pkt[6] = opts.length & 0xff;
  pkt[7] = (opts.length >> 8) & 0xff;
  pkt[8] = (opts.length >> 16) & 0xff;
  pkt[9] = (opts.length >> 24) & 0xff;
  pkt[10] = opts.flag;
  // cmdTable[1..13] → packet bytes 11..23
  for (let i = 1; i < 14; i++) {
    pkt[10 + i] = opts.cmdTable[i]!;
  }
  return pkt;
}

/** Build an 8-byte NTR Get-Chip-ID command (opcode 0x90 + 7 zeros). */
export function ntrGetChipId(): Uint8Array {
  const c = new Uint8Array(8);
  c[0] = NTR_CMD.GET_CHIP_ID;
  return c;
}
