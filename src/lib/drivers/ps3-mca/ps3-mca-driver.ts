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
import type { UsbTransport } from "@/lib/transport/usb-transport";
import {
  buildPs1ReadCommand,
  buildVerifyCardCommand,
  CARD_TYPE_NONE,
  CARD_TYPE_PS1,
  CARD_TYPE_PS2,
  COMMAND_TIMEOUT_MS,
  LONG_FORM_SUCCESS,
  MEB_GOOD,
  PERMISSION_FAIL,
  PS1_CARD_SIZE,
  PS1_FRAME_SIZE,
  PS1_FRAMES,
  PS1_READ_RESPONSE_SIZE,
  RES_MARKER,
} from "./ps3-mca-commands";

const PS2_NOT_SUPPORTED = "PS2 memory cards are not supported.";

export class Ps3McaDriver implements DeviceDriver {
  readonly id = "PS3_MCA";
  readonly name = "PS3 Memory Card Adaptor";
  readonly capabilities: DeviceCapability[] = [
    // The dump output is save data (a memory-card image), not a ROM — even
    // though we call readROM() under the hood. Declaring this as dump_save
    // keeps ROM-oriented UI (e.g. No-Intro DAT hints) suppressed.
    { systemId: "ps1", operations: ["dump_save"], autoDetect: true },
  ];

  transport: UsbTransport;
  private events: Partial<DeviceDriverEvents> = {};

  constructor(transport: UsbTransport) {
    this.transport = transport;
  }

  async initialize(): Promise<DeviceInfo> {
    // The adapter has no activate/wake sequence — it's ready as soon as the
    // USB interface is claimed. No firmware version is exposed.
    return {
      firmwareVersion: "",
      deviceName: this.name,
      capabilities: this.capabilities,
      // Memory cards are hot-pluggable by spec; no cart-power concerns.
      hotSwap: true,
      compatibilityNote:
        "Some third-party clone cards may not be detected. Click Scan a " +
        "few times if a card isn't recognized.",
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    const type = await this.getCardType();
    switch (type) {
      case CARD_TYPE_PS1:
        return {
          systemId: "ps1",
          cartInfo: { title: "PS1 Memory Card", saveSize: PS1_CARD_SIZE },
        };
      case CARD_TYPE_PS2:
        // Report PS2 detection but flag it unsupported so the UI can render
        // an explanation without offering a dump. readROM still guards against
        // being called on PS2 as defense-in-depth.
        return {
          systemId: "ps2",
          cartInfo: { title: "PS2 Memory Card" },
          unsupported: { reason: PS2_NOT_SUPPORTED },
        };
      case CARD_TYPE_NONE:
        return null;
      default:
        throw new Error(`Unknown card type ${hex(type)}`);
    }
  }

  async detectCartridge(_systemId: SystemId): Promise<CartridgeInfo | null> {
    const result = await this.detectSystem();
    return result?.cartInfo ?? null;
  }

  async readROM(_config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const type = await this.getCardType();
    if (type === CARD_TYPE_NONE) {
      throw new Error("No memory card detected in the PS1 slot.");
    }
    if (type === CARD_TYPE_PS2) {
      throw new Error(PS2_NOT_SUPPORTED);
    }
    if (type !== CARD_TYPE_PS1) {
      throw new Error(`Unknown card type ${hex(type)}`);
    }

    this.log("Reading PS1 memory card (128 KB)...");
    const out = new Uint8Array(PS1_CARD_SIZE);

    // The adapter firmware doesn't tolerate pipelined long-form commands —
    // queueing a second send + recv while the first response is in flight
    // produces a malformed (short) response on frame N+1. Stick to strict
    // request-response.
    for (let frame = 0; frame < PS1_FRAMES; frame++) {
      if (signal?.aborted) throw new Error("Aborted");
      await this.transport.send(buildPs1ReadCommand(frame));
      const resp = await this.transport.receive(PS1_READ_RESPONSE_SIZE, {
        timeout: COMMAND_TIMEOUT_MS,
      });
      const data = this.parseFrameResponse(resp, frame);
      out.set(data, frame * PS1_FRAME_SIZE);
      this.emitProgress("rom", (frame + 1) * PS1_FRAME_SIZE, PS1_CARD_SIZE);
    }

    return out;
  }

  async readSave(_config: ReadConfig, _signal?: AbortSignal): Promise<Uint8Array> {
    throw new Error("PS1 memory cards do not have separate save data");
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("PS1 memory card writing is not yet implemented");
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  // ─── Protocol helpers ──────────────────────────────────────────────────

  private async getCardType(): Promise<number> {
    // First-party cards reply on the first verify-card request. Clone
    // cards often miss the first ID challenge and report NONE; polling a
    // handful of times sometimes brings them up. A real empty slot still
    // resolves to NONE quickly — the worst case is ~1s of wasted polling
    // on Scan.
    const MAX_ATTEMPTS = 6;
    const RETRY_DELAY_MS = 150;
    let lastType = CARD_TYPE_NONE;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.transport.send(buildVerifyCardCommand());
      const resp = await this.transport.receive(2, {
        timeout: COMMAND_TIMEOUT_MS,
      });
      if (resp.length < 2) {
        throw new Error("Short response from adapter on verify-card");
      }
      if (resp[0] !== RES_MARKER) {
        throw new Error(`Unexpected verify-card marker ${hex(resp[0])}`);
      }
      lastType = resp[1];
      if (lastType !== CARD_TYPE_NONE) {
        if (attempt > 1) {
          this.log(`Card detected after ${attempt} attempts`);
        }
        return lastType;
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    return lastType;
  }

  private parseFrameResponse(resp: Uint8Array, frame: number): Uint8Array {
    if (resp.length < PS1_READ_RESPONSE_SIZE) {
      throw new Error(
        `Short read on frame ${frame}: got ${resp.length} bytes, expected ${PS1_READ_RESPONSE_SIZE}`,
      );
    }
    if (resp[0] !== RES_MARKER || resp[1] !== LONG_FORM_SUCCESS) {
      if (resp[0] === RES_MARKER && resp[1] === PERMISSION_FAIL) {
        throw new Error(
          `Authentication failure on frame ${frame} (likely a PS2 card)`,
        );
      }
      throw new Error(
        `Bad response header on frame ${frame}: ${hex(resp[0])} ${hex(resp[1])}`,
      );
    }

    const expectedMsb = (frame >> 8) & 0xff;
    const expectedLsb = frame & 0xff;
    if (resp[12] !== expectedMsb || resp[13] !== expectedLsb) {
      throw new Error(
        `Frame address mismatch on frame ${frame}: got ${hex(resp[12])} ${hex(resp[13])}`,
      );
    }

    // Card-reported checksum is XOR of MSB, LSB, and the 128 data bytes.
    let checksum = 0;
    for (let i = 12; i < 12 + 2 + PS1_FRAME_SIZE; i++) checksum ^= resp[i];
    if (resp[142] !== checksum) {
      throw new Error(
        `Checksum mismatch on frame ${frame}: got ${hex(resp[142])}, computed ${hex(checksum)}`,
      );
    }

    if (resp[143] !== MEB_GOOD) {
      throw new Error(
        `Bad memory-end byte on frame ${frame}: ${hex(resp[143])}`,
      );
    }

    return resp.slice(14, 14 + PS1_FRAME_SIZE);
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

  private log(message: string, level: "info" | "warn" | "error" = "info"): void {
    this.events.onLog?.(message, level);
  }
}

function hex(b: number): string {
  return `0x${b.toString(16).padStart(2, "0")}`;
}
