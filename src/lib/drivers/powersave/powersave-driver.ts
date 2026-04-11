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
  PACKET_SIZE,
  PAD_BYTE,
  NTAG215_SIZE,
  COMMAND_TIMEOUT_MS,
} from "./powersave-commands";

export class PowerSaveDriver implements DeviceDriver {
  readonly id = "POWERSAVE";
  readonly name = "PowerSaves for Amiibo";
  readonly capabilities: DeviceCapability[] = [
    { systemId: "amiibo", operations: ["dump_rom"], autoDetect: true },
  ];

  transport: HidTransport;
  private events: Partial<DeviceDriverEvents> = {};
  private ledOn = false;

  constructor(transport: HidTransport) {
    this.transport = transport;
  }

  async initialize(): Promise<DeviceInfo> {
    return {
      firmwareVersion: "",
      deviceName: this.name,
      capabilities: this.capabilities,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    return { systemId: "amiibo", cartInfo: {} };
  }

  /**
   * Single poll attempt: toggle RF field and check for a tag.
   * Returns CartridgeInfo with UID if a tag is present, null otherwise.
   */
  async detectCartridge(_systemId: SystemId): Promise<CartridgeInfo | null> {
    const { data: uidResp, isError } = await this.pollOnce();
    if (isError) {
      // No tag — turn LED off if it was on from a previous read
      if (this.ledOn) {
        await this.sendCmd(CMD.SET_LED_STATE, [0x00]);
        this.ledOn = false;
      }
      return null;
    }

    const uid = this.extractUid(uidResp);
    if (!uid) return null;

    const uidHex = toHex(uid);
    return {
      title: uidHex,
      meta: { uid, uidHex },
    };
  }

  /**
   * Read an NFC tag. Detects whether the tag is a standard NDEF tag or an
   * Amiibo and chooses the appropriate read strategy:
   *
   *  - NDEF tags (CC magic 0xE1): skip init dance, best-effort page read
   *  - Amiibo (non-standard CC):  full init dance + double-read validation
   */
  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const uid = config.params.uid as Uint8Array;
    const cc = await this.readCc();

    if (cc?.isAmiibo) {
      // Amiibo path — full init dance + double-read validation
      this.log("Authenticating...");
      const ok = await this.initDance(uid);
      if (!ok) throw new Error("Tag lost during authentication");

      this.log("Reading (pass 1)...");
      const first = await this.readToken(signal);
      this.emitProgress("rom", NTAG215_SIZE, NTAG215_SIZE * 2);

      this.log("Verifying (pass 2)...");
      const second = await this.readToken(signal);
      this.emitProgress("verify", NTAG215_SIZE, NTAG215_SIZE);

      for (let i = 0; i < NTAG215_SIZE; i++) {
        if (first[i] !== second[i]) {
          throw new Error(`Validation failed: mismatch at byte ${i}`);
        }
      }

      this.log("Validation passed");
      return first;
    }

    // Non-amiibo: skip init dance (it breaks reads on other tags),
    // read as many pages as we can.
    await this.sendCmd(CMD.SET_LED_STATE, [0xff]);
    this.ledOn = true;

    this.log("Reading NFC tag...");
    const data = await this.readTokenBestEffort(signal);
    if (data.length === 0) {
      throw new Error(
        "Could not read any pages from this tag. " +
        "It may be a MIFARE Classic or other tag type not supported by this device.",
      );
    }
    this.log(`Read ${data.length} bytes`);
    return data;
  }

  async readSave(_config: ReadConfig, _signal?: AbortSignal): Promise<Uint8Array> {
    throw new Error("Amiibo does not have separate save data");
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("Amiibo writing not implemented");
  }

  on<K extends keyof DeviceDriverEvents>(event: K, handler: DeviceDriverEvents[K]): void {
    this.events[event] = handler;
  }

  /** Turn the portal LED off. Called by the scanner on tag removal. */
  async ledOff(): Promise<void> {
    if (!this.ledOn) return;
    await this.sendCmd(CMD.SET_LED_STATE, [0x00]);
    this.ledOn = false;
  }

  /**
   * Read the capability container (page 3) to determine tag type.
   *
   * Returns { isNdef: true } for standard NDEF tags (CC magic 0xE1),
   * null for Amiibo (non-standard CC like 0xF1) or unreadable tags.
   * Throws for NTAG213 (Lego Dimensions) which can't be fully read.
   */
  private async readCc(): Promise<{ isNdef: boolean } | null> {
    const { data, isError } = await this.sendCmd(CMD.READ, [0x03]);
    if (isError) return null;

    // CC byte 2 (at data[4]) encodes user memory size.
    // NTAG213 = 0x12 — reject since the portal has no PWD_AUTH command.
    if (data[4] === 0x12) {
      throw new Error(
        "Lego Dimensions figures are not supported with this device. " +
        "The PowerSaves portal cannot read password-protected NTAG213 pages.",
      );
    }

    // Amiibo uses non-standard CC magic (0xF1). Only those need the init dance;
    // for everything else, the init dance actively breaks subsequent reads.
    return { isAmiibo: data[2] === 0xf1 };
  }

  // ─── Protocol helpers ──────────────────────────────────────────────────

  private async sendCmd(
    command: number,
    args: number[] | Uint8Array = [],
  ): Promise<{ data: Uint8Array; isError: boolean }> {
    const packet = new Uint8Array(PACKET_SIZE);
    packet.fill(PAD_BYTE);
    packet[0] = command;
    for (let i = 0; i < args.length && i < PACKET_SIZE - 1; i++) {
      packet[1 + i] = args[i];
    }

    await this.transport.send(packet);

    // LED command gets no response
    if (command === CMD.SET_LED_STATE) {
      return { data: new Uint8Array(0), isError: false };
    }

    const data = await this.transport.receive(PACKET_SIZE, {
      timeout: COMMAND_TIMEOUT_MS,
    });
    const isError = data[0] === 0x01 && data[1] === 0x02;
    return { data, isError };
  }

  /** RF off → RF on → GetTokenUID. Returns raw response. */
  private async pollOnce(): Promise<{ data: Uint8Array; isError: boolean }> {
    await this.sendCmd(CMD.RF_FIELD_OFF);
    await this.sendCmd(CMD.RF_FIELD_ON);
    return this.sendCmd(CMD.GET_TOKEN_UID);
  }

  /** Extract UID from GetTokenUid response. Byte 4 = length, bytes 5+ = UID. */
  private extractUid(response: Uint8Array): Uint8Array | null {
    const length = response[4];
    if (length !== 4 && length !== 7) return null;
    if (response.length < 5 + length) return null;
    return response.slice(5, 5 + length);
  }

  /**
   * Initialization dance required before reading real Amiibo.
   * Mirrors handleToken() from the amiigo Go implementation.
   */
  private async initDance(uid: Uint8Array): Promise<boolean> {
    // LED on
    await this.sendCmd(CMD.SET_LED_STATE, [0xff]);
    this.ledOn = true;

    await this.sendCmd(CMD.UNKNOWN1);
    await this.sendCmd(CMD.READ_SIGNATURE);

    // Read page 0x10 → extract 16 bytes
    const { data: page16Resp } = await this.sendCmd(CMD.READ, [0x10]);
    const page16 = page16Resp.slice(2, 18);

    // Generate crypto key from UID + page 0x10 data
    const mkArgs = new Uint8Array(uid.length + page16.length);
    mkArgs.set(uid);
    mkArgs.set(page16, uid.length);
    const { data: keyResp } = await this.sendCmd(CMD.MAKE_KEY, [...mkArgs]);
    const key = keyResp.slice(2, 18);

    // Unknown4 with [0x00, key...]
    const u4Args = new Uint8Array(1 + key.length);
    u4Args[0] = 0x00;
    u4Args.set(key, 1);
    await this.sendCmd(CMD.UNKNOWN4, [...u4Args]);

    await this.sendCmd(CMD.UNKNOWN1);

    // Power cycle — required after authentication
    await this.sendCmd(CMD.RF_FIELD_OFF);
    await this.sendCmd(CMD.RF_FIELD_ON);
    const { isError } = await this.sendCmd(CMD.GET_TOKEN_UID);

    if (isError) {
      this.debug("Tag lost after power cycle");
      return false;
    }

    this.debug("Init dance complete");
    return true;
  }

  /**
   * Best-effort page reader for non-Amiibo NDEF tags.
   * Reads pages sequentially and stops at the first unreadable page,
   * returning however many bytes were successfully read.
   */
  private async readTokenBestEffort(signal?: AbortSignal): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];

    for (let page = 0x00; page < 0x88; page += 4) {
      if (signal?.aborted) throw new Error("Aborted");

      const { data, isError } = await this.sendCmd(CMD.READ, [page]);
      if (isError) break;

      chunks.push(data.slice(2, 18));
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /** Read all 540 bytes from the NTAG215. Retry up to 3 times per page on error. */
  private async readToken(signal?: AbortSignal): Promise<Uint8Array> {
    const token = new Uint8Array(NTAG215_SIZE);
    let offset = 0;

    for (let page = 0x00; page < 0x88; page += 4) {
      if (signal?.aborted) throw new Error("Aborted");

      let attempts = 0;
      while (true) {
        const { data, isError } = await this.sendCmd(CMD.READ, [page]);
        if (isError) {
          if (++attempts > 2) {
            throw new Error(
              `Failed to read page 0x${page.toString(16).padStart(2, "0")} after 3 attempts`,
            );
          }
          continue;
        }
        const bytesToCopy = Math.min(16, NTAG215_SIZE - offset);
        token.set(data.slice(2, 2 + bytesToCopy), offset);
        offset += bytesToCopy;
        break;
      }
    }

    return token;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

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
    console.log(`[powersave] ${message}`);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
