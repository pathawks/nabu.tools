import type {
  DeviceDriver,
  DeviceDriverEvents,
  DeviceCapability,
  DeviceInfo,
  CartridgeInfo,
  ReadConfig,
  DumpProgress,
  SystemId,
  DetectSystemResult,
} from "@/lib/types";
import type { HidTransport } from "@/lib/transport/hid-transport";
import {
  CMD,
  CMD_PREFIX,
  EVT_PREFIX,
  PACKET_SIZE,
  PAD_BYTE,
  INIT_PAYLOAD,
  NTAG213_SIZE,
  NTAG215_SIZE,
  checksum,
  type PadId,
  type TagEvent,
  PAD_NAMES,
} from "./toypad-commands";

const RESPONSE_TIMEOUT_MS = 3000;
const MAX_READ_RETRIES = 2;

interface PendingCommand {
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ToyPadDriver implements DeviceDriver {
  readonly id = "TOYPAD";
  readonly name = "Lego Dimensions Toy Pad";
  readonly capabilities: DeviceCapability[] = [
    { systemId: "lego_dimensions", operations: ["dump_rom"], autoDetect: true },
  ];

  transport: HidTransport;
  private device: HIDDevice;
  private events: Partial<DeviceDriverEvents> = {};
  private tagListeners: Set<(event: TagEvent) => void> = new Set();
  private pending = new Map<number, PendingCommand>();
  private seq = 0x80; // Start high to avoid collision with portal's auto-read counters

  /**
   * The ToyPad uses event-driven communication: the portal sends unsolicited
   * tag events (0x56) alongside command responses (0x55). We attach directly
   * to the HIDDevice for input reports and route them ourselves, while using
   * the transport only for sending.
   */
  constructor(transport: HidTransport, device: HIDDevice) {
    this.transport = transport;
    this.device = device;
    device.addEventListener("inputreport", this.onInputReport);
  }

  // ─── DeviceDriver interface ──────────────────────────────────────────

  async initialize(): Promise<DeviceInfo> {
    // Init is special — send the exact reference bytes, no messageId.
    // The portal responds with auto-read data that we don't need to match.
    const init = new Uint8Array(PACKET_SIZE);
    init[0] = CMD_PREFIX;
    init[1] = 1 + INIT_PAYLOAD.length;
    init[2] = CMD.INIT;
    init.set(INIT_PAYLOAD, 3);
    init[3 + INIT_PAYLOAD.length] = checksum(init, 3 + INIT_PAYLOAD.length);
    await this.transport.send(init);

    // Wait for the auto-read burst to finish — the portal reads all tags
    // currently on the pad and sends unsolicited 0x55 responses.
    await new Promise((r) => setTimeout(r, 1500));
    this.debug("Portal initialized");
    return {
      firmwareVersion: "",
      deviceName: this.name,
      capabilities: this.capabilities,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    return null;
  }

  async detectCartridge(_systemId: SystemId): Promise<CartridgeInfo | null> {
    return null;
  }

  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const tagIndex = config.params.padIndex as number;
    return this.readTag(tagIndex, signal);
  }

  async readSave(
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throw new Error("NFC tags do not have separate save data");
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("NFC tag writing not implemented");
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  // ─── Toy Pad–specific API ────────────────────────────────────────────

  /** Subscribe to tag placed/removed events. Returns an unsubscribe function. */
  onTagEvent(callback: (event: TagEvent) => void): () => void {
    this.tagListeners.add(callback);
    return () => this.tagListeners.delete(callback);
  }

  /** Set the LED color for a pad (1=center, 2=left, 3=right). */
  async setLed(pad: PadId, r: number, g: number, b: number): Promise<void> {
    await this.sendCommand(CMD.LED_FADE, [pad, r, g, b]);
  }

  /**
   * Read all pages from the NFC tag at the given index.
   *
   * Detects tag type from the capability container (page 3):
   *   - CC size 0x12 -> NTAG213 (Lego Dimensions): 45 pages, attempt PWD_AUTH first
   *   - CC size 0x3E -> NTAG215 (amiibo): 135 pages, no auth
   *   - Other -> best-effort sequential read until first error
   */
  async readTag(tagIndex: number, signal?: AbortSignal): Promise<Uint8Array> {
    const cc = await this.readPage(tagIndex, 0x03);
    const ccSize = cc[2];

    if (ccSize === 0x12) {
      return this.readNtag213(tagIndex, signal);
    }

    // NTAG215 (amiibo) or other — amiibo uses non-standard CC (0xFF),
    // so we can't rely on ccSize === 0x3E. Just read 135 pages directly.
    return this.readNtag215(tagIndex, signal);
  }

  /** Remove the input report listener. Call when done with the driver. */
  destroy(): void {
    this.device.removeEventListener("inputreport", this.onInputReport);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Driver destroyed"));
    }
    this.pending.clear();
  }

  // ─── Tag reading strategies ──────────────────────────────────────────

  /** NTAG213 (Lego Dimensions): 45 pages (0x00-0x2C), PWD_AUTH first. */
  private async readNtag213(
    tagIndex: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    // Attempt password authentication — the portal derives the password
    // from the UID internally when mode=1 (automatic).
    try {
      await this.sendCommand(CMD.PWD_AUTH, [
        0x01, // automatic mode — portal derives password from UID
        tagIndex,
        0x00,
        0x00,
        0x00,
        0x00, // unused in automatic mode
      ]);
      this.debug("PWD_AUTH succeeded");
    } catch {
      this.log("PWD_AUTH failed, reading unprotected pages only", "warn");
    }

    this.log("Reading NTAG213 (45 pages)...");
    const token = new Uint8Array(NTAG213_SIZE);
    const totalPages = 45;
    let offset = 0;

    for (let page = 0x00; page < totalPages; page += 4) {
      if (signal?.aborted) throw new Error("Aborted");

      const data = await this.readPageRetry(tagIndex, page);
      const bytesToCopy = Math.min(16, NTAG213_SIZE - offset);
      token.set(data.subarray(0, bytesToCopy), offset);
      offset += bytesToCopy;
      this.emitProgress("rom", offset, NTAG213_SIZE);
    }

    return token;
  }

  /** NTAG215 (amiibo): 135 pages (0x00-0x86), no auth needed. */
  private async readNtag215(
    tagIndex: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.log("Reading NTAG215 (135 pages)...");
    const token = new Uint8Array(NTAG215_SIZE);
    const totalPages = 135;
    let offset = 0;

    for (let page = 0x00; page < totalPages; page += 4) {
      if (signal?.aborted) throw new Error("Aborted");

      const data = await this.readPageRetry(tagIndex, page);
      const bytesToCopy = Math.min(16, NTAG215_SIZE - offset);
      token.set(data.subarray(0, bytesToCopy), offset);
      offset += bytesToCopy;
      this.emitProgress("rom", offset, NTAG215_SIZE);
    }

    return token;
  }

  // ─── Protocol layer ──────────────────────────────────────────────────

  /**
   * Build and send a command frame, returning the response payload.
   *
   * Outgoing: [0x55, length, command, messageId, ...args, checksum, 0-padding]
   * Length = 2 + args.length (command + messageId + args).
   *
   * The portal echoes our messageId at byte 2 of its response, so we can
   * match commands to responses and ignore unsolicited auto-reads.
   */
  private async sendCommand(
    command: number,
    args: number[] = [],
  ): Promise<Uint8Array> {
    const msgId = this.nextSeq();
    const payloadLen = 2 + args.length;
    const packet = new Uint8Array(PACKET_SIZE);
    packet.fill(PAD_BYTE);

    let i = 0;
    packet[i++] = CMD_PREFIX;
    packet[i++] = payloadLen;
    packet[i++] = command;
    packet[i++] = msgId;
    for (const b of args) packet[i++] = b;
    packet[i] = checksum(packet, i);

    const response = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`Command 0x${command.toString(16)} timed out`));
      }, RESPONSE_TIMEOUT_MS);

      this.pending.set(msgId, { resolve, reject, timer });
      this.transport.send(packet).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(msgId);
        reject(err);
      });
    });

    return response;
  }

  /**
   * Read 4 pages (16 bytes) from a tag.
   * Throws on error response from the portal.
   */
  private async readPage(tagIndex: number, page: number): Promise<Uint8Array> {
    const resp = await this.sendCommand(CMD.READ, [0x00, tagIndex, page]);
    if (resp[0] !== 0x00) {
      throw new Error(
        `Read failed at page 0x${page.toString(16).padStart(2, "0")} (error 0x${resp[0].toString(16)})`,
      );
    }
    return resp.subarray(1, 17);
  }

  /** Read a page with retries on transient errors. */
  private async readPageRetry(
    tagIndex: number,
    page: number,
  ): Promise<Uint8Array> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt++) {
      try {
        return await this.readPage(tagIndex, page);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError;
  }

  // ─── Input report handling ───────────────────────────────────────────

  private onInputReport = (event: Event): void => {
    const { data } = event as unknown as HIDInputReportEvent;
    const bytes = new Uint8Array(data.buffer);
    if (bytes.length === 0) return;

    const prefix = bytes[0];

    if (prefix === CMD_PREFIX) {
      this.handleResponse(bytes);
    } else if (prefix === EVT_PREFIX) {
      this.handleTagEvent(bytes);
    }
  };

  /**
   * Handle a command response (0x55 prefix).
   *
   * Response format: [0x55, length, messageId, ...payload]
   * The messageId at byte 2 echoes what we sent at byte 3, so we can
   * match responses to commands and ignore unsolicited auto-reads.
   */
  private handleResponse(bytes: Uint8Array): void {
    const msgId = bytes[2];
    const pending = this.pending.get(msgId);
    if (!pending) return; // Unsolicited auto-read, discard

    clearTimeout(pending.timer);
    this.pending.delete(msgId);

    const length = bytes[1];
    const payload = bytes.slice(3, 2 + length);
    pending.resolve(payload);
  }

  /**
   * Handle a tag event (0x56 prefix).
   *
   * Format: [0x56, 0x0B, pad, type, index, presence, uid[7], checksum]
   *   pad: 1=center, 2=left, 3=right
   *   type: 0x00=normal, 0x08=error
   *   index: tag slot on the pad (0-6)
   *   presence: 0x00=placed, 0x01=removed
   *   uid: 7-byte NFC UID
   */
  private handleTagEvent(bytes: Uint8Array): void {
    const pad = bytes[2] as PadId;
    if (pad < 1 || pad > 3) return;

    const index = bytes[4];
    const action: TagEvent["action"] = bytes[5] === 0x00 ? "placed" : "removed";
    const uid = bytes.slice(6, 13);

    const event: TagEvent = { pad, uid, action, index };

    this.debug(
      `Tag ${action} on ${PAD_NAMES[pad]} pad (index ${index}, UID ${toHex(uid)})`,
    );

    for (const listener of this.tagListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[toypad] Tag event listener error:", err);
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private nextSeq(): number {
    const s = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    if (this.seq === 0) this.seq = 1; // Skip 0 to avoid collision with portal counters
    return s;
  }

  private emitProgress(
    phase: DumpProgress["phase"],
    bytesRead: number,
    totalBytes: number,
  ): void {
    this.events.onProgress?.({
      phase,
      bytesRead,
      totalBytes,
      fraction: bytesRead / totalBytes,
    });
  }

  private log(
    message: string,
    level: "info" | "warn" | "error" = "info",
  ): void {
    this.events.onLog?.(message, level);
  }

  private debug(message: string): void {
    console.log(`[toypad] ${message}`);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
