// ─── Disney Infinity Base protocol notes ────────────────────────────────────
//
// Frame format (all transfers are 32-byte HID interrupt reports):
//   Host → Portal:  FF <len> <cmd> <seq> <data...> <checksum> 00-padding
//   Portal → Host:  AA <len> <seq> <data...> <checksum> 00-padding
//   Portal async:   AB 04 <position> <kind> <order> <added?> <checksum> ...
//
//   `len` covers seq + data bytes (not 0xFF/0xAA or the checksum).
//   `checksum` is the low byte of the sum of every preceding byte.
//
// Asynchronous tag events fire on every placement/removal regardless of
// whether the portal can authenticate the tag. `kind` byte: 0x09 for an
// authenticated Disney figure, anything else for a foreign tag that the
// portal detected but couldn't MIFARE-auth.
//
// Tag-block addressing: the (block, u) arg pair on READ_BLOCK / WRITE_BLOCK
// is (MIFARE sector index, offset within sector). Notable cells:
//     (0, 0) → tag block 0  — manufacturer block, plaintext UID + SAK/ATQA
//     (0, 1) → tag block 1  — encrypted identity block (char ID + CRC)  [read-only]
//     (0, 3) → tag block 3  — sector 0 trailer (keys zeroed on read)    [read-only]
//     (N, 0) → sector N first data block — save 1/2/3 at N=1/2/3        [read-write]
//     (N, 3) → sector N trailer                                         [read-only]
//
// Undocumented commands observed during fuzzing but with no known useful
// behavior (all ACK-only or return constant bytes): 0x84, 0x85, 0x94, 0xA4,
// 0xB1, 0xB5, 0xB6. 0xB6 with arg0 ≥ 15 can hang the portal firmware.
// ────────────────────────────────────────────────────────────────────────────

import type {
  DeviceDriver,
  DeviceDriverEvents,
  DeviceCapability,
  DeviceInfo,
  CartridgeInfo,
  ReadConfig,
  SystemId,
  DetectSystemResult,
} from "@/lib/types";
import type { HidTransport } from "@/lib/transport/hid-transport";
import {
  ACTIVATION_STRING,
  ASYNC_MARKER,
  CMD,
  COMMAND_TIMEOUT_MS,
  PACKET_SIZE,
  REQ_MARKER,
  RES_MARKER,
  slotName,
  type Position,
  type TagEvent,
} from "./infinity-commands";

export type FigureKind = "authenticated" | "unreadable";

export interface InfinityFigure {
  /** Byte as returned by GET_PRESENT_FIGURES. High nibble = slot, low nibble = order. */
  slotByte: number;
  /** "hexagon" | "player 1" | "player 2" | "unknown …" */
  slot: string;
  /** Session-scoped identifier the portal assigns when a figure is placed. */
  order: number;
  /** 0x09 marker = authenticated Disney figure; 0x01 marker = foreign tag. */
  kind: FigureKind;
}

export class InfinityDriver implements DeviceDriver {
  readonly id = "DISNEY_INFINITY";
  readonly name = "Disney Infinity Base";
  readonly capabilities: DeviceCapability[] = [
    { systemId: "disney-infinity", operations: [], autoDetect: false },
  ];

  transport: HidTransport;
  private events: Partial<DeviceDriverEvents> = {};
  private tagEventHandler: ((event: TagEvent) => void) | null = null;
  private seq = 0;
  // Serialize outgoing commands so the single transport-level receive slot
  // isn't trampled by overlapping callers.
  private commandChain: Promise<unknown> = Promise.resolve();

  constructor(transport: HidTransport) {
    this.transport = transport;
    this.transport.setInputListener(this.handleInputReport);
  }

  async initialize(): Promise<DeviceInfo> {
    const resp = await this.sendCmd(CMD.ACTIVATE, ACTIVATION_STRING);
    // Activation response payload (21 bytes after AA/len/seq):
    //   Bytes 0-8  — fixed portal identifier: `00 0F 01 00 03 02 MM mm 43`
    //                where MM.mm is the firmware version (e.g. 09.09).
    //   Bytes 9-20 — portal-specific 12-byte block. Stable across calls for
    //                a given unit; includes the USB iSerial bytes in a
    //                scrambled layout (positions 12-13 and 16-19 on our
    //                v9.09 test unit). Content of the remaining bytes is
    //                undetermined — possibly a per-unit constant or hash.
    const major = resp.payload[6] ?? 0;
    const minor = resp.payload[7] ?? 0;
    const version = `${major}.${minor.toString().padStart(2, "0")}`;

    return {
      firmwareVersion: version,
      deviceName: this.name,
      capabilities: this.capabilities,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    return { systemId: "disney-infinity", cartInfo: {} };
  }

  async detectCartridge(_systemId: SystemId): Promise<CartridgeInfo | null> {
    return null;
  }

  async readROM(_config: ReadConfig, _signal?: AbortSignal): Promise<Uint8Array> {
    throw new Error("Disney Infinity figure reading not yet implemented");
  }

  async readSave(_config: ReadConfig, _signal?: AbortSignal): Promise<Uint8Array> {
    throw new Error("Disney Infinity save reading not yet implemented");
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("Disney Infinity save writing not yet implemented");
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  /**
   * List everything the portal currently sees on its slots, whether or not
   * the portal could authenticate it. The payload is pairs of
   * (slotByte, marker) — marker 0x09 means the portal authenticated the tag
   * as a Disney Infinity figure; anything else is a foreign/unauthenticated
   * tag (Skylanders, Lego Dimensions, etc.).
   */
  async listFigures(): Promise<InfinityFigure[]> {
    const resp = await this.sendCmd(CMD.GET_PRESENT_FIGURES);
    const figures: InfinityFigure[] = [];
    for (let i = 0; i + 1 < resp.payload.length; i += 2) {
      const slotByte = resp.payload[i];
      const marker = resp.payload[i + 1];
      figures.push({
        slotByte,
        slot: slotName(slotByte),
        order: slotByte & 0x0f,
        kind: marker === 0x09 ? "authenticated" : "unreadable",
      });
    }
    return figures;
  }

  /** Read the 7-byte NFC UID of a figure by its portal-assigned order index. */
  async readFigureUid(order: number): Promise<Uint8Array> {
    const resp = await this.sendCmd(CMD.GET_FIGURE_UID, [order]);
    // First payload byte is a status byte (0x00 on success); next 7 bytes are UID.
    return resp.payload.slice(1, 8);
  }

  /**
   * Set a slot's LED to a solid color immediately.
   * @param panel 1 = hexagon, 2 = player 1, 3 = player 2
   *
   * Note: the portal also exposes FADE_LED (0x92), but testing shows it
   * performs a one-shot fade-up-then-down pulse rather than a fade-to-hold,
   * so it isn't useful for "light a slot and keep it lit."
   */
  async setLed(panel: Position, r: number, g: number, b: number): Promise<void> {
    await this.sendCmd(CMD.SET_LED, [panel, r & 0xff, g & 0xff, b & 0xff]);
  }

  /**
   * Read one 16-byte block from a figure. The (block, u) pair selects
   * which MIFARE tag block: `block` is the sector index (0–4) and `u` is
   * the offset within the sector (0 = first data block, 1 = second, 2 =
   * third, 3 = sector trailer). For example:
   *   block=0, u=0 → tag block 0  (manufacturer block with plaintext UID)
   *   block=0, u=1 → tag block 1  (encrypted identity / character ID)
   *   block=0, u=3 → tag block 3  (sector 0 trailer — keys come back zeroed)
   *   block=1, u=0 → tag block 4  (encrypted save block 1)
   *   block=2, u=0 → tag block 8  (encrypted save block 2)
   *   block=3, u=0 → tag block 12 (encrypted save block 3)
   *   block=N, u=3 → sector N's trailer
   */
  async readBlock(
    order: number,
    block: 0 | 1 | 2 | 3 | 4,
    u: number = 0,
  ): Promise<Uint8Array> {
    const resp = await this.sendCmd(CMD.READ_BLOCK, [order, block, u]);
    // First payload byte is a status byte (0x00 on success); next 16 bytes are the block.
    if (resp.payload[0] !== 0x00) {
      throw new Error(
        `Portal error 0x${resp.payload[0].toString(16).padStart(2, "0")}`,
      );
    }
    return resp.payload.slice(1, 17);
  }

  /** Register a handler for unsolicited tag-add/remove events. */
  onTagEvent(handler: ((event: TagEvent) => void) | null): void {
    this.tagEventHandler = handler;
  }

  // ─── Protocol helpers ──────────────────────────────────────────────────

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xff;
    return this.seq;
  }

  private sendCmd(
    command: number,
    args: number[] | Uint8Array = [],
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<{ seq: number; payload: Uint8Array }> {
    const run = async () => {
      const seq = this.nextSeq();
      const payloadLen = 2 + args.length; // cmd + seq + args
      const packet = new Uint8Array(PACKET_SIZE);
      packet[0] = REQ_MARKER;
      packet[1] = payloadLen;
      packet[2] = command;
      packet[3] = seq;
      for (let i = 0; i < args.length; i++) packet[4 + i] = args[i];
      packet[4 + args.length] = checksum(packet, 0, 4 + args.length);

      await this.transport.send(packet);

      // The portal interleaves unsolicited 0xAB tag-change events with
      // command responses. Skip past any that arrive while we wait for 0xAA.
      while (true) {
        const resp = await this.transport.receive(PACKET_SIZE, {
          timeout: timeoutMs,
        });
        if (resp[0] === ASYNC_MARKER) continue;
        if (resp[0] !== RES_MARKER) {
          throw new Error(
            `Unexpected response marker 0x${resp[0].toString(16).padStart(2, "0")}`,
          );
        }
        const respLen = resp[1];
        const respSeq = resp[2];
        if (respSeq !== seq) {
          throw new Error(
            `Response seq mismatch (expected ${seq}, got ${respSeq})`,
          );
        }
        // respLen covers seq + payload, so the payload is respLen - 1 bytes.
        const end = Math.min(3 + Math.max(0, respLen - 1), PACKET_SIZE);
        return { seq, payload: resp.slice(3, end) };
      }
    };

    const next = this.commandChain.then(run, run);
    this.commandChain = next.catch(() => {}); // keep the chain alive after errors
    return next;
  }

  private handleInputReport = (data: Uint8Array): void => {
    if (data[0] !== ASYNC_MARKER) return;
    // Frame: AB 04 <position> <kindMarker> <order> <added/removed> <checksum>
    //   kindMarker: 0x09 for authenticated Disney figures, 0x01 for foreign.
    if (data[1] !== 0x04) return;
    const position = data[2];
    if (position < 1 || position > 3) return;
    const kindMarker = data[3];
    const kind: FigureKind =
      kindMarker === 0x09 ? "authenticated" : "unreadable";
    const event: TagEvent = {
      position: position as Position,
      order: data[4],
      added: data[5] === 0x00,
      kind,
    };
    this.tagEventHandler?.(event);
  };
}

function checksum(bytes: Uint8Array, start: number, endExclusive: number): number {
  let sum = 0;
  for (let i = start; i < endExclusive; i++) sum = (sum + bytes[i]) & 0xff;
  return sum;
}
