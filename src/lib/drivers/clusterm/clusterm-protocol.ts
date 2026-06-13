/**
 * Famicom Dumper/Writer — request/response protocol over WebSerial.
 *
 * One method per device operation; each sends a frame and awaits the
 * expected reply, surfacing the firmware's error frames as descriptive
 * exceptions. Chunking, progress, and abort granularity live a layer up
 * in `ClusterMNesBus` — every read/write here is a single
 * device-side operation (length ≤ the LE16 frame limit).
 */

import type { SerialTransport } from "@/lib/transport/serial-transport";
import { CMD, MAGIC, crc8, buildFrame } from "./clusterm-commands";

/** Parsed STARTED payload — the device's version/capacity report. */
export interface DumperInfo {
  protocolVersion: number;
  /** 0xFFFF is the firmware's "streams any size" sentinel. */
  maxReadPacketSize: number;
  maxWritePacketSize: number;
  /** "major.minor.patch", absent on pre-3.x firmware's short payloads. */
  firmwareVersion?: string;
  /** Stamped into flash by the bootloader; absent on pre-3.x firmware. */
  hardwareVersion?: string;
}

interface Frame {
  command: number;
  payload: Uint8Array;
}

const NAME_BY_CMD = new Map<number, string>(
  Object.entries(CMD).map(([name, value]) => [value, name]),
);

function cmdName(command: number): string {
  return NAME_BY_CMD.get(command) ?? `0x${command.toString(16)}`;
}

/** Cap on resync scanning before declaring the byte stream lost. */
const MAX_RESYNC_BYTES = 65536;

const READ_TIMEOUT_MS = 5000;
/** RESET floats the bus for ~500 ms before the ack arrives. */
const RESET_TIMEOUT_MS = 3000;
/** Init probes fast and retries, mirroring the reference client. */
const INIT_PROBE_TIMEOUT_MS = 250;
const INIT_ATTEMPTS = 30;

export class ClusterMProtocol {
  private readonly transport: SerialTransport;

  constructor(transport: SerialTransport) {
    this.transport = transport;
  }

  private async sendCommand(
    command: number,
    payload: Uint8Array | number[] = [],
  ): Promise<void> {
    await this.transport.send(buildFrame(command, payload));
  }

  /**
   * Receive the next non-DEBUG frame. Scans byte-wise to the magic (the
   * stream has no other sync marker), validates the trailing CRC, and
   * transparently skips DEBUG frames, which debug firmware builds may
   * interleave at any point.
   */
  private async recvFrame(timeout = READ_TIMEOUT_MS): Promise<Frame> {
    for (;;) {
      let skipped = 0;
      let first = (await this.transport.receive(1, { timeout }))[0];
      while (first !== MAGIC) {
        if (++skipped > MAX_RESYNC_BYTES) {
          throw new Error(
            "Famicom Dumper byte stream desynchronised (no frame magic found)",
          );
        }
        first = (await this.transport.receive(1, { timeout }))[0];
      }
      const head = await this.transport.receive(3, { timeout });
      const command = head[0];
      const length = head[1] | (head[2] << 8);
      const rest = await this.transport.receive(length + 1, { timeout });

      const whole = new Uint8Array(4 + length + 1);
      whole.set([MAGIC, command, head[1], head[2]], 0);
      whole.set(rest, 4);
      if (crc8(whole) !== 0) {
        throw new Error(
          `Famicom Dumper frame CRC error on ${cmdName(command)}`,
        );
      }
      if (command !== CMD.DEBUG) {
        return { command, payload: rest.subarray(0, length) };
      }
    }
  }

  /** Receive a frame and require a specific reply command. */
  private async expect(
    expected: number,
    timeout = READ_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    const { command, payload } = await this.recvFrame(timeout);
    if (command !== expected) {
      throw new Error(
        `Famicom Dumper replied ${cmdName(command)}, expected ${cmdName(expected)}`,
      );
    }
    return payload;
  }

  /**
   * Version/connection handshake: drain stale bytes, then probe with
   * PRG_INIT until STARTED arrives. The reply payload is parsed by length
   * — old firmware sends shorter variants.
   */
  async init(): Promise<DumperInfo> {
    await this.transport.flush();
    let lastError: unknown;
    for (let attempt = 0; attempt < INIT_ATTEMPTS; attempt++) {
      try {
        await this.sendCommand(CMD.PRG_INIT);
        const data = await this.expect(CMD.STARTED, INIT_PROBE_TIMEOUT_MS);
        const info: DumperInfo = {
          protocolVersion: data.length >= 1 ? data[0] : 0,
          maxReadPacketSize: data.length >= 3 ? data[1] | (data[2] << 8) : 0,
          maxWritePacketSize: data.length >= 5 ? data[3] | (data[4] << 8) : 0,
        };
        if (data.length >= 9) {
          info.firmwareVersion = `${data[5] | (data[6] << 8)}.${data[7]}.${data[8]}`;
        }
        if (data.length >= 13) {
          info.hardwareVersion = `${data[9] | (data[10] << 8)}.${data[11]}.${data[12]}`;
        }
        return info;
      } catch (e) {
        lastError = e;
        await this.transport.flush();
      }
    }
    throw new Error(
      `Famicom Dumper did not answer the init handshake: ${(lastError as Error)?.message}`,
    );
  }

  /**
   * Simulate a console reset: the device disconnects its level shifters
   * for ~500 ms, so the cart sees the whole bus (M2 included) float.
   */
  async reset(): Promise<void> {
    await this.sendCommand(CMD.RESET);
    await this.expect(CMD.RESET_ACK, RESET_TIMEOUT_MS);
  }

  private static addrLen(addr: number, length: number): number[] {
    // Both encode as LE16; an out-of-range value would wrap silently and
    // make the host and device disagree about the request.
    if (addr < 0 || addr > 0xffff || length < 0 || length > 0xffff) {
      throw new Error(
        `ClusterM request out of range: addr=${addr}, length=${length} (each must be 0..0xFFFF)`,
      );
    }
    return [addr & 0xff, (addr >> 8) & 0xff, length & 0xff, (length >> 8) & 0xff];
  }

  /** Read `length` bytes from the CPU bus in one device operation. */
  async readCpuBlock(addr: number, length: number): Promise<Uint8Array> {
    await this.sendCommand(
      CMD.PRG_READ_REQUEST,
      ClusterMProtocol.addrLen(addr, length),
    );
    return this.expectBlock(CMD.PRG_READ_RESULT, length);
  }

  /** Read `length` bytes from the PPU bus in one device operation. */
  async readPpuBlock(addr: number, length: number): Promise<Uint8Array> {
    await this.sendCommand(
      CMD.CHR_READ_REQUEST,
      ClusterMProtocol.addrLen(addr, length),
    );
    return this.expectBlock(CMD.CHR_READ_RESULT, length);
  }

  private async expectBlock(
    expected: number,
    length: number,
  ): Promise<Uint8Array> {
    const payload = await this.expect(expected);
    if (payload.length !== length) {
      // A short result means host and firmware disagree about the request
      // — surface it rather than silently shifting subsequent reads.
      throw new Error(
        `Famicom Dumper returned ${payload.length} bytes, expected ${length}`,
      );
    }
    return payload;
  }

  /**
   * Write bytes to the CPU bus, one M2-timed write per byte, ascending.
   * `data` is a mapper-register payload — a handful of bytes in practice.
   * The frame's LE16 length bounds the whole payload to 0xFFFF, so with the
   * 4-byte addr/len header `data` tops out at 0xFFFF - 4. Not worth a runtime
   * check (no caller comes within kilobytes of that), and buildFrame throws
   * loudly in the impossible overflow case.
   */
  async writeCpu(addr: number, data: Uint8Array | number[]): Promise<void> {
    await this.sendCommand(CMD.PRG_WRITE_REQUEST, [
      ...ClusterMProtocol.addrLen(addr, data.length),
      ...data,
    ]);
    await this.expect(CMD.PRG_WRITE_DONE);
  }

  /**
   * Write bytes to the PPU bus (CHR-RAM), ascending addresses. Same
   * register-sized `data` and per-frame payload bound as `writeCpu`.
   */
  async writePpu(addr: number, data: Uint8Array | number[]): Promise<void> {
    await this.sendCommand(CMD.CHR_WRITE_REQUEST, [
      ...ClusterMProtocol.addrLen(addr, data.length),
      ...data,
    ]);
    await this.expect(CMD.CHR_WRITE_DONE);
  }

  // NOTE: never pipeline two command frames into one transport send. The
  // firmware's parser holds a single command slot: the next frame's first
  // byte clears `comm_recv_done` and overwrites the buffer (comm.c,
  // comm_proceed), so two frames landing in one CDC packet execute
  // LAST-FRAME-WINS — the first command is silently dropped.
  // Hardware-confirmed 2026-06-13: a "fused" write+read lost the write.

  /**
   * Raw mirroring probe: CIRAM A10 levels after PPU reads at $0000,
   * $0400, $0800, $0C00 (i.e. for nametables $2000/$2400/$2800/$2C00).
   * Current firmware returns 4 bytes; ancient firmware returned 1.
   */
  async getMirroringRaw(): Promise<boolean[]> {
    await this.sendCommand(CMD.MIRRORING_REQUEST);
    const payload = await this.expect(CMD.MIRRORING_RESULT);
    return [...payload].map((v) => v !== 0);
  }
}
