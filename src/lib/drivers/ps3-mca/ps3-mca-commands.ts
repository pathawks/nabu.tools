// ─── PS3 Memory Card Adaptor protocol notes ────────────────────────────────
//
// Command framing (EP2 OUT bulk):
//   Short form: [AA op]                          (2 bytes total)
//   Long form:  [AA 42 <len_lo> <len_hi> <payload…>]   (4 + len bytes)
//     `len` is the payload length, little-endian. Total packet = 4 + len.
//
// Response framing (EP1 IN bulk):
//   Short form reply:   [55 <byte>]
//   Long form success:  [55 5A <len_lo> <len_hi> <payload…>]
//   Long form auth-fail: [55 AF]
//
// PS1 frame read (long form, payload length 140):
//   Payload: [81 52 00 00 <frame_msb> <frame_lsb> 00*134]
//     81  = memory card access (SIO)
//     52  = read ('R')
//     frame is big-endian on the SIO wire (0x0000..0x03FF)
//     The 134 trailing zeros are dummy bytes that clock out the card reply.
//
// PS1 read response (144 bytes total):
//   [0..3]    55 5A <len_lo> <len_hi>       PS3mca success header
//   [4..9]    SIO echo of command header (unchecked)
//   [10..11]  5C 5D                         command acknowledge
//   [12..13]  <msb> <lsb>                   confirmed frame address
//   [14..141] 128 data bytes                ← the frame
//   [142]     checksum (MSB XOR LSB XOR all 128 data bytes)
//   [143]     memory end byte (47h = good, 4Eh = bad checksum, FFh = bad frame)
//
// Reference: github.com/paolo-caroni/ps3mca-ps1 (GPL-3.0)
// ────────────────────────────────────────────────────────────────────────────

export const DEVICE_FILTERS = [{ vendorId: 0x054c, productId: 0x02ea }];

export const REQ_MARKER = 0xaa;
export const RES_MARKER = 0x55;
export const LONG_FORM_OP = 0x42;
export const LONG_FORM_SUCCESS = 0x5a;
export const PERMISSION_FAIL = 0xaf;

/** Short-form opcode: report the kind of card currently inserted. */
export const OP_VERIFY_CARD = 0x40;

export const CARD_TYPE_NONE = 0x00;
export const CARD_TYPE_PS1 = 0x01;
export const CARD_TYPE_PS2 = 0x02;

// PS1 SIO memory-card opcodes (used inside long-form payloads).
export const SIO_CARD_ACCESS = 0x81;
export const SIO_READ = 0x52;

export const PS1_FRAME_SIZE = 128;
export const PS1_FRAMES = 1024;
export const PS1_CARD_SIZE = PS1_FRAMES * PS1_FRAME_SIZE; // 131072

/** Total size of the response to a PS1 frame read. */
export const PS1_READ_RESPONSE_SIZE = 144;

/** Card-reply byte indicating a successful read ("Good" memory end byte). */
export const MEB_GOOD = 0x47;

export const COMMAND_TIMEOUT_MS = 5000;

/** Short-form probe for the inserted card (reply: [55, 00|01|02]). */
export function buildVerifyCardCommand(): Uint8Array {
  return new Uint8Array([REQ_MARKER, OP_VERIFY_CARD]);
}

/**
 * Long-form PS1 read command for a single 128-byte frame.
 * Frame is 0..1023; encoded big-endian on the SIO wire.
 */
export function buildPs1ReadCommand(frame: number): Uint8Array {
  const payloadLen = 140;
  const cmd = new Uint8Array(4 + payloadLen);
  cmd[0] = REQ_MARKER;
  cmd[1] = LONG_FORM_OP;
  cmd[2] = payloadLen & 0xff;
  cmd[3] = (payloadLen >> 8) & 0xff;
  cmd[4] = SIO_CARD_ACCESS;
  cmd[5] = SIO_READ;
  // cmd[6..7] = 00 00 (filler, card ID request slots)
  cmd[8] = (frame >> 8) & 0xff; // frame MSB (big-endian)
  cmd[9] = frame & 0xff; // frame LSB
  // cmd[10..143] remain 0x00 (4 SIO ack slots + 130 clock-out bytes)
  return cmd;
}
