// Skylanders Portal of Power driver.
//
// Wire format: fixed 32-byte HID reports in both directions. Host→device
// commands are one ASCII opcode byte (byte 0) followed by argument bytes;
// device→host reports echo the opcode byte for command responses, plus an
// unsolicited ~10 Hz `S` (Status) report stream. See portal-commands.ts.
//
// Platform support — Chrome on macOS and Windows; NOT Linux.
//   The portal firmware STALLs its interrupt-OUT endpoint and only accepts
//   host→device data via the SET_REPORT Output class request
//   (bmRequestType=0x21 bRequest=0x09 wValue=0x0200). Chrome's WebHID
//   `sendReport()` issues SET_REPORT through the OS HID stack on macOS and
//   Windows, so it works there. On Linux `sendReport()` writes via
//   `/dev/hidraw`, which targets the broken interrupt-OUT endpoint and
//   fails with EPROTO; `sendFeatureReport()` (SET_REPORT Feature) is ignored
//   by the firmware, and WebUSB can't claim a HID-class interface — so there
//   is no in-browser Linux path. The device description flags this so Linux
//   users aren't surprised by a connect failure.

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
  BLOCKS_PER_FIGURE,
  BLOCK_SIZE,
  CMD,
  COMMAND_TIMEOUT_MS,
  decodeStatus,
  diffStatus,
  FIGURE_SIZE,
  MAX_SLOTS,
  PACKET_SIZE,
  RESET_TIMEOUT_MS,
  RESP,
  slotToIdx,
  type SlotEvent,
  type StatusReport,
} from "./portal-commands";

/** Placed/removed slot events the driver synthesizes from Status deltas. */
export type PortalTagEvent = SlotEvent;

export class PortalOfPowerDriver implements DeviceDriver {
  readonly id = "PORTAL_OF_POWER";
  readonly name = "Skylanders Portal of Power";
  // Scanner-style device: figures are read on demand through the portal
  // scanner UI (readFigure), not the generic cartridge dump path.
  readonly capabilities: DeviceCapability[] = [
    { systemId: "skylanders", operations: [], autoDetect: false },
  ];

  transport: HidTransport;
  private events: Partial<DeviceDriverEvents> = {};
  private tagEventHandler: ((event: PortalTagEvent) => void) | null = null;

  /** Last observed Status so we can emit diff events. */
  private lastStatus: StatusReport | null = null;

  /**
   * Serialize commands so the one-slot response matching (next non-Status
   * report) can't be trampled by an interleaving caller.
   */
  private commandChain: Promise<unknown> = Promise.resolve();

  constructor(transport: HidTransport) {
    this.transport = transport;
    this.transport.setInputListener(this.handleInputReport);
  }

  // ─── DeviceDriver interface ────────────────────────────────────────────

  async initialize(): Promise<DeviceInfo> {
    // Reset is the cleanest probe: the portal responds with `52 02 <hw_rev>`
    // and re-announces any figures on the pad via fresh ADDED codes. Safe to
    // send even if the portal has never been activated.
    let hwRev: number | null = null;
    try {
      const reset = await this.sendAndReceive(CMD.RESET, [], RESP.RESET, {
        timeoutMs: RESET_TIMEOUT_MS,
      });
      hwRev = reset[2] ?? null;
    } catch (e) {
      // Some models NAK the reset if the portal is mid-boot; fall through and
      // let activation surface the real problem.
      this.log(`Reset probe failed: ${(e as Error).message}`, "warn");
    }

    await this.sendAndReceive(CMD.ACTIVATE, [0x01], RESP.ACTIVATE);

    return {
      firmwareVersion: "",
      hardwareRevision:
        hwRev !== null
          ? `rev 0x${hwRev.toString(16).padStart(2, "0")}`
          : undefined,
      deviceName: this.name,
      capabilities: this.capabilities,
      // Figures come and go freely; the portal pushes presence over Status.
      hotSwap: true,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    return { systemId: "skylanders", cartInfo: {} };
  }

  async detectCartridge(_systemId: SystemId): Promise<CartridgeInfo | null> {
    return null;
  }

  async readROM(
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throw new Error(
      "Skylanders figures are read through the portal scanner, not the generic dump path",
    );
  }

  async readSave(
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throw new Error("Skylanders figures do not have separate save data");
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("Skylanders figure writing not implemented");
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.tagEventHandler = null;
    this.transport.setInputListener(null);
  }

  // ─── Portal-specific API ───────────────────────────────────────────────

  /** Subscribe to placed/removed slot events synthesized from Status deltas. */
  onTagEvent(handler: ((event: PortalTagEvent) => void) | null): void {
    this.tagEventHandler = handler;
  }

  /** Most recent decoded Status, or null before the first one arrives. */
  get currentStatus(): StatusReport | null {
    return this.lastStatus;
  }

  /**
   * Set the center-ring LED. The `C` command is the legacy single-zone
   * control that every portal model honors. Values are 0..255 per channel.
   *
   * Hardware LEDs don't render web RGB faithfully — blue bleeds heavily into
   * other hues — so saturated reds/greens benefit from a damped blue channel.
   * Callers that care about fidelity should do that remapping.
   */
  async setColor(r: number, g: number, b: number): Promise<void> {
    // `C` has no response — fire-and-forget, but keep it serialized so it
    // can't jump the queue ahead of a pending Q/W and race the portal.
    await this.sendNoReply(CMD.COLOR, [r & 0xff, g & 0xff, b & 0xff]);
  }

  /**
   * Read a single 16-byte tag block from the figure in `slot`.
   *
   * Throws if the portal reports a read failure (byte 1 = 0x01 instead of the
   * echoed slot index) or returns a truncated reply — typically because the
   * slot is empty or the figure was lifted mid-read.
   */
  async readBlock(slot: number, block: number): Promise<Uint8Array> {
    if (slot < 0 || slot >= MAX_SLOTS) {
      throw new Error(`Slot ${slot} out of range (0..${MAX_SLOTS - 1})`);
    }
    if (block < 0 || block >= BLOCKS_PER_FIGURE) {
      throw new Error(
        `Block ${block} out of range (0..${BLOCKS_PER_FIGURE - 1})`,
      );
    }
    const idx = slotToIdx(slot);
    const resp = await this.sendAndReceive(
      CMD.QUERY_BLOCK,
      [idx, block],
      RESP.QUERY_BLOCK,
    );
    // Failure form: resp[1] === 0x01 instead of the echoed idx (also catches
    // an empty/garbled reply, where resp[1] is undefined).
    if (resp[1] !== idx) {
      throw new Error(
        `Block read failed: slot ${slot}, block ${block} (portal returned idx 0x${(resp[1] ?? 0).toString(16).padStart(2, "0")})`,
      );
    }
    // A short success reply would let readFigure zero-pad a corrupt block
    // into the dump — reject it loudly instead.
    if (resp.length < 3 + BLOCK_SIZE) {
      throw new Error(
        `Portal returned a short block (${resp.length} bytes) for slot ${slot}, block ${block}`,
      );
    }
    return resp.slice(3, 3 + BLOCK_SIZE);
  }

  /** Dump all 64 blocks of a figure into a single 1024-byte buffer. */
  async readFigure(slot: number, signal?: AbortSignal): Promise<Uint8Array> {
    const data = new Uint8Array(FIGURE_SIZE);
    for (let block = 0; block < BLOCKS_PER_FIGURE; block++) {
      if (signal?.aborted) throw new Error("Aborted");
      const buf = await this.readBlock(slot, block);
      data.set(buf, block * BLOCK_SIZE);
      this.emitProgress("rom", (block + 1) * BLOCK_SIZE, FIGURE_SIZE);
    }
    return data;
  }

  /** Best-effort LED-off + deactivate. Failures are ignored. */
  async shutdown(): Promise<void> {
    try {
      await this.setColor(0, 0, 0);
    } catch {
      /* ignore */
    }
    try {
      await this.sendAndReceive(CMD.ACTIVATE, [0x00], RESP.ACTIVATE);
    } catch {
      /* ignore */
    }
  }

  // ─── Protocol layer ────────────────────────────────────────────────────

  /**
   * Pending-response slot. Because commands serialize via `commandChain`,
   * only one caller can be waiting at a time.
   */
  private pending: {
    expectedByte: number;
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private sendAndReceive(
    command: number,
    args: number[],
    expectedResponseByte: number,
    opts: { timeoutMs?: number } = {},
  ): Promise<Uint8Array> {
    const run = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const packet = buildPacket(command, args);
        const timer = setTimeout(() => {
          this.pending = null;
          reject(
            new Error(
              `Command 0x${command.toString(16)} timed out after ${opts.timeoutMs ?? COMMAND_TIMEOUT_MS}ms`,
            ),
          );
        }, opts.timeoutMs ?? COMMAND_TIMEOUT_MS);

        this.pending = {
          expectedByte: expectedResponseByte,
          resolve,
          reject,
          timer,
        };

        this.transport.send(packet).catch((err) => {
          clearTimeout(timer);
          this.pending = null;
          reject(err);
        });
      });

    const next = this.commandChain.then(run, run);
    this.commandChain = next.catch(() => {}); // keep chain alive past errors
    return next;
  }

  private sendNoReply(command: number, args: number[]): Promise<void> {
    const run = () => this.transport.send(buildPacket(command, args));
    const next = this.commandChain.then(run, run);
    this.commandChain = next.catch(() => {});
    return next;
  }

  private handleInputReport = (data: Uint8Array): void => {
    if (data.length === 0) return;
    const opcode = data[0];

    // Status reports are unsolicited and independent of any outstanding
    // command. Always dispatch them regardless of pending state.
    if (opcode === RESP.STATUS) {
      this.handleStatus(data);
      return;
    }

    // Wireless out-of-range notice: log and move on. Not a command response.
    if (opcode === RESP.OUT_OF_RANGE) {
      this.log("Wireless portal went out of range", "warn");
      return;
    }

    // Anything else should be the response to our one pending command.
    if (this.pending && this.pending.expectedByte === opcode) {
      const { resolve, timer } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      resolve(data);
    }
    // Unmatched reports (e.g. stray bytes during boot) are ignored; a command
    // that never sees its response fails via the timeout above.
  };

  private handleStatus(data: Uint8Array): void {
    const status = decodeStatus(data);
    const events = diffStatus(this.lastStatus, status);
    this.lastStatus = status;

    if (this.tagEventHandler) {
      for (const ev of events) this.tagEventHandler(ev);
    }
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
}

/** Build a 32-byte outbound packet with opcode in byte 0 and args following. */
function buildPacket(command: number, args: number[]): Uint8Array {
  const packet = new Uint8Array(PACKET_SIZE);
  packet[0] = command;
  for (let i = 0; i < args.length; i++) packet[1 + i] = args[i];
  return packet;
}
