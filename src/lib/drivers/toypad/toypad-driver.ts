// ─── Lego Dimensions Toy Pad driver — known issues / TODOs ──────────────────
//
// 1. Multi-tag addressing is broken.
//    When more than one tag is on the portal, CMD.READ ignores the tagIndex
//    arg and returns data for whichever tag the NFC controller happens to be
//    locked onto. We detect this at the scanner layer by cross-checking the
//    returned page-0 UID against the anti-collision UID and failing loudly,
//    but we don't yet know whether there's a "select tag N" command that
//    would let us address tags reliably. Until that's understood, users
//    effectively get "one-tag-at-a-time" behavior.
//
// 2. Disney Infinity (MIFARE Classic) tags poison the NFC channel.
//    If a Disney tag is on the pad, every other tag's READ returns error
//    0xf2 (MIFARE auth required). The MIFARE Classic tag seems to win NFC
//    arbitration. There is no known way to deprioritize it — removal is the
//    only recovery. This is a portal-firmware behavior we can't fix in the
//    driver.
//
// 3. READ arg order was wrong in Ellerbach/node-ld reference code.
//    Those projects document `[mode, tagIndex, page]`; the correct order is
//    `[mode, page, tagIndex]`. With the wrong order, READ silently returns
//    pages 0-3 regardless of the requested page (because tagIndex=0 in the
//    page-arg position reads from page 0). The pre-fix driver had literally
//    never been reading real NTAG213 content past page 3 — it was returning
//    pages 0-3 repeated 11× (for NTAG213) or 34× (for NTAG215) and labeling
//    the result a "character." We should upstream this correction to the
//    reference projects.
//
// 4. PWD_AUTH arg order is unverified.
//    We corrected READ but haven't validated PWD_AUTH's arg order the same
//    way. It currently uses `[mode, tagIndex, ...key]` which *may* be wrong.
//    Authentication appears to succeed on Lego tags, but we haven't
//    confirmed whether the post-auth reads actually access password-
//    protected pages (pages 38+ on NTAG213) that unauthenticated reads
//    would return 0xf2 for.
//
// 5. No auto-retry after coexistence clears.
//    When a non-NTAG tag (e.g. Disney) is lifted off the portal, any NTAG
//    tags that failed to read during the coexistence stay in "error" state
//    in the UI until the user manually lifts and re-places each one. Should
//    auto-re-issue reads for in-error NTAG pads when a non-NTAG is removed.
//
// 6. Driver's HID listener isn't cleaned up on disconnect.
//    The constructor does `device.addEventListener("inputreport", ...)` but
//    the corresponding `removeEventListener` only runs from the explicit
//    `destroy()` method, which isn't wired into the connection lifecycle.
//    Each Vite HMR reload or user-driven reconnect leaves a zombie
//    listener attached, so every subsequent tag event fires once per
//    accumulated instance. Symptoms: console logs appear N× where N is
//    the number of connect/reload cycles since the page was hard-loaded.
//    Fix: call `destroy()` from the connection's handleDisconnect path
//    (and on unexpected HID disconnect).
//
// 7. Amiibo detection works, content read doesn't.
//    Amiibo CC (magic 0xF1) is recognized and short-circuited with a
//    generic "this device can't read Amiibo content" message. We could
//    probably read the 540-byte NTAG215 payload too (the portal's READ
//    works on any NTAG21x) and hand it off to the Amiibo system handler
//    for character identification + NXP signature verification — but
//    coexistence issue #1 would likely block reads if a Lego tag is also
//    present, so this is low-priority until #1 is resolved.
//
// 8. "Not a Lego Dimensions figure (CC 0x?? 0x??)" hex values are often
//    confusing noise — they're literal page-0 UID bytes when the portal
//    is in a bad state, not a real NDEF CC. Consider showing a friendlier
//    generic "unsupported tag" message by default and only revealing the
//    hex under a debug toggle.
// ────────────────────────────────────────────────────────────────────────────

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
  checksum,
  kindFromMarker,
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
  // Observed empirically: the portal's auto-read responses use message IDs
  // 0x86 and above (monotonically incrementing after boot). Stay well below
  // that range so a late auto-read can't match our outstanding command.
  private seq = 0x20;

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
   * Read all pages from a Lego Dimensions (NTAG213) tag at the given index.
   *
   * Rejects anything else — an Amiibo (CC magic 0xF1), a generic larger NTAG,
   * or any unknown tag — because the Toy Pad UI is scoped to Lego Dimensions
   * and silently returning someone else's bytes would be misleading.
   */
  async readTag(tagIndex: number, signal?: AbortSignal): Promise<Uint8Array> {
    const cc = await this.readPage(tagIndex, 0x03);
    const ccMagic = cc[0];
    const ccSize = cc[2];

    if (ccMagic === 0xe1 && ccSize === 0x12) {
      return this.readNtag213(tagIndex, signal);
    }

    if (ccMagic === 0xf1) {
      throw new Error("This device can't read Amiibo content.");
    }

    throw new Error(
      `Not a Lego Dimensions figure (CC 0x${ccMagic.toString(16).padStart(2, "0")} 0x${ccSize.toString(16).padStart(2, "0")}).`,
    );
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
    // TODO(#4): Verify this arg order. READ's args were wrong in the same
    // reference projects; PWD_AUTH could be too. Test by reading a
    // password-protected page (e.g. NTAG213 page 40) with and without
    // this call to confirm auth actually took effect.
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
   * Read 4 pages (16 bytes) from a tag starting at the given page.
   * Throws on error response from the portal.
   *
   * Command args are `[mode, startPage, tagIndex]`. The old Ellerbach/node-ld
   * references that described this as `[mode, tagIndex, page]` were wrong —
   * the portal silently returns pages 0-3 if you get this order wrong
   * (because tagIndex at the page-arg position is usually 0).
   */
  private async readPage(tagIndex: number, page: number): Promise<Uint8Array> {
    const resp = await this.sendCommand(CMD.READ, [0x00, page, tagIndex]);
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
   * Format: [0x56, 0x0B, pad, marker, index, presence, uid[7], checksum]
   *   pad: 1=center, 2=left, 3=right
   *   marker: portal's tag classification (see `kindFromMarker`) —
   *           0x00 = NTAG (readable), 0x09 = Disney Infinity MIFARE, etc.
   *   index: portal-assigned tag index (used as arg for READ/WRITE/PWD_AUTH)
   *   presence: 0x00=placed, 0x01=removed
   *   uid: 7-byte NFC UID
   */
  private handleTagEvent(bytes: Uint8Array): void {
    const pad = bytes[2] as PadId;
    if (pad < 1 || pad > 3) return;

    const kind = kindFromMarker(bytes[3]);
    const index = bytes[4];
    const action: TagEvent["action"] = bytes[5] === 0x00 ? "placed" : "removed";
    const uid = bytes.slice(6, 13);

    const event: TagEvent = { pad, uid, action, index, kind };

    this.debug(
      `Tag ${action} on ${PAD_NAMES[pad]} pad (index ${index}, kind ${kind}, UID ${toHex(uid)})`,
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
    // Wrap 0x20..0x7f, below the portal's observed 0x86+ auto-read counter.
    this.seq = this.seq >= 0x7f ? 0x20 : this.seq + 1;
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
