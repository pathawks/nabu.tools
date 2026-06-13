import type { SerialTransport } from "@/lib/transport/serial-transport";
import { CMD, MAGIC, crc8, buildFrame } from "./clusterm-commands";

/**
 * Test-only fake of the Famicom Dumper/Writer: parses real frames out of
 * `send()` buffers and queues real response frames, so suites exercise
 * the exact byte stream the firmware sees and produces.
 */

/** Real STARTED payload captured from hardware (fw 3.4.0 / hw 3.2.0). */
export const HW_STARTED_PAYLOAD = [
  0x05, 0xff, 0xff, 0xf8, 0xc7, 0x03, 0x00, 0x04, 0x00, 0x03, 0x00, 0x02,
  0x00,
];

export interface SentCommand {
  command: number;
  payload: Uint8Array;
}

export class FakeClusterMDevice {
  /** Every decoded command frame the host sent, in order. */
  commands: SentCommand[] = [];
  /** Raw `send()` buffers, to assert frame pipelining. */
  sendBuffers: Uint8Array[] = [];
  /** Queued device→host bytes served by `receive`. */
  private rx: number[] = [];
  /** Payload for STARTED replies; override for legacy-firmware tests. */
  startedPayload: number[] = HW_STARTED_PAYLOAD;
  /** When > 0, swallow that many incoming commands without replying. */
  ignoreNextCommands = 0;
  /** CPU-bus read backing: address-dependent pattern by default. */
  cpuRead: (addr: number) => number = (addr) => (addr >> 8) & 0xff;
  ppuRead: (addr: number) => number = (addr) => (addr ^ 0x55) & 0xff;
  mirroringRaw: number[] = [0, 1, 0, 1];

  readonly transport = {
    send: async (data: Uint8Array): Promise<void> => {
      this.sendBuffers.push(data);
      const frames: { command: number; payload: Uint8Array }[] = [];
      let offset = 0;
      while (offset < data.length) {
        if (data[offset] !== MAGIC) throw new Error("fake: bad magic");
        const command = data[offset + 1];
        const length = data[offset + 2] | (data[offset + 3] << 8);
        const frame = data.subarray(offset, offset + length + 5);
        if (crc8(frame) !== 0) throw new Error("fake: bad CRC from host");
        frames.push({ command, payload: frame.subarray(4, 4 + length) });
        offset += length + 5;
      }
      // Real firmware holds a single command slot: a following frame's
      // first byte clears comm_recv_done and overwrites the buffer
      // (comm.c comm_proceed), so frames sharing one CDC packet execute
      // LAST-FRAME-WINS. Emulate that so pipelining bugs fail tests the
      // way they fail on hardware.
      frames.forEach((f) => this.commands.push({ command: f.command, payload: f.payload.slice() }));
      const last = frames.at(-1);
      if (last) this.handle(last.command, last.payload);
    },
    receive: async (
      length: number,
      _options?: { timeout?: number },
    ): Promise<Uint8Array> => {
      if (this.rx.length < length) {
        throw new Error(
          `Serial read timeout: got ${this.rx.length}/${length} bytes`,
        );
      }
      return new Uint8Array(this.rx.splice(0, length));
    },
    flush: async (): Promise<void> => {
      this.rx = [];
    },
  } as unknown as SerialTransport;

  /** Queue a raw device→host frame. */
  push(command: number, payload: Uint8Array | number[] = []): void {
    this.rx.push(...buildFrame(command, payload));
  }

  /** Queue raw bytes verbatim (garbage, corrupted frames). */
  pushRaw(bytes: Uint8Array | number[]): void {
    this.rx.push(...bytes);
  }

  // `commands` recording happens in send() (every decoded frame, even
  // ones the single-slot parser drops); handle() only executes.
  private handle(command: number, payload: Uint8Array): void {
    if (this.ignoreNextCommands > 0) {
      this.ignoreNextCommands--;
      return;
    }
    switch (command) {
      case CMD.PRG_INIT:
        this.push(CMD.STARTED, this.startedPayload);
        break;
      case CMD.RESET:
        this.push(CMD.RESET_ACK);
        break;
      case CMD.PRG_READ_REQUEST: {
        const addr = payload[0] | (payload[1] << 8);
        const length = payload[2] | (payload[3] << 8);
        this.push(
          CMD.PRG_READ_RESULT,
          Array.from({ length }, (_, i) => this.cpuRead(addr + i)),
        );
        break;
      }
      case CMD.CHR_READ_REQUEST: {
        const addr = payload[0] | (payload[1] << 8);
        const length = payload[2] | (payload[3] << 8);
        this.push(
          CMD.CHR_READ_RESULT,
          Array.from({ length }, (_, i) => this.ppuRead(addr + i)),
        );
        break;
      }
      case CMD.PRG_WRITE_REQUEST:
        this.push(CMD.PRG_WRITE_DONE);
        break;
      case CMD.CHR_WRITE_REQUEST:
        this.push(CMD.CHR_WRITE_DONE);
        break;
      case CMD.MIRRORING_REQUEST:
        this.push(CMD.MIRRORING_RESULT, this.mirroringRaw);
        break;
      default:
        this.push(CMD.ERROR_INVALID);
    }
  }
}
