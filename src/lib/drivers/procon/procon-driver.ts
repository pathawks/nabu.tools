/**
 * Nintendo Switch Pro Controller / Joy-Con (R) — NFC Amiibo reader.
 *
 * Reads NTAG215 tags (540 bytes) via the controller's built-in NFC reader.
 * Uses HID input report 0x31 (MCU data mode) with the NFC sub-protocol.
 *
 * Ported from:
 *   github.com/aka256/joycon-webhid (MIT)
 *
 * References:
 *   github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering (protocol notes)
 *   github.com/CTCaer/jc_toolkit (MIT) (cross-referenced)
 *
 * NOTE: On Linux, the Pro Controller's HID descriptor omits report 0x31,
 * which blocks MCU/NFC access. This works on macOS and Windows.
 */

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
  REPORT,
  INPUT,
  SUBCMD,
  MCU_CMD,
  NFC_CMD,
  MCU_REPORT,
  MCU_STATE,
  NFC_IC,
  NFC_ERROR,
  NTAG215_SIZE,
  NEUTRAL_RUMBLE,
  POLL_ARGS,
  WAIT_ARGS,
  OFF,
  FRAG1_LEN,
  FRAG2_LEN,
  crc8,
  buildReadNtagArgs,
} from "./procon-commands";

const MCU_TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 8000;

/** NTAG21x UIDs are 7 bytes; clamp generously to defend against device-controlled lengths. */
const MAX_UID_LEN = 10;

interface McuWaiter {
  predicate: (data: Uint8Array) => boolean;
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ProConDriver implements DeviceDriver {
  readonly id = "PROCON";
  readonly name = "Switch Pro Controller";
  readonly capabilities: DeviceCapability[] = [
    { systemId: "amiibo", operations: ["dump_rom"], autoDetect: false },
  ];

  transport: HidTransport;
  private events: Partial<DeviceDriverEvents> = {};

  // Packet counter (low nibble, 0x0-0xF)
  private packetNum = 0;

  // MCU waiter queue — resolved by input report handler
  private mcuWaiters: McuWaiter[] = [];

  // NFC polling state
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private detectedUid: Uint8Array | null = null;

  private readInProgress = false;
  private disposed = false;

  constructor(transport: HidTransport) {
    this.transport = transport;
    transport.setInputListener(this.handleInputReport);
  }

  // ─── DeviceDriver interface ──────────────────────────────────────────

  async initialize(): Promise<DeviceInfo> {
    // Fail fast if the OS HID stack doesn't expose MCU input report 0x31.
    // On Linux, the kernel's hid-nintendo driver consumes the controller
    // and re-publishes a stripped HID descriptor that omits 0x31, so we
    // would otherwise wait the full MCU_TIMEOUT_MS for input that will
    // never arrive.
    if (!this.transport.supportsInputReport(INPUT.MCU_DATA)) {
      throw new Error(
        "Pro Controller MCU input report 0x31 is not exposed by the OS HID stack. " +
          "On Linux this is the known hid-nintendo limitation — NFC reading " +
          "requires macOS, Windows, or a hid-nintendo BPF descriptor patch.",
      );
    }

    // USB handshake — required for USB-connected controllers.
    // Steps: get status -> UART handshake -> switch to 3 Mbps baud ->
    //        re-handshake at new baud -> force USB-only mode.
    // Bluetooth controllers don't support report 0x80, so we catch errors.
    try {
      await this.transport.sendReport(REPORT.USB_CMD, new Uint8Array([0x01]));
      await sleep(100);
      await this.transport.sendReport(REPORT.USB_CMD, new Uint8Array([0x02]));
      await sleep(100);
      await this.transport.sendReport(REPORT.USB_CMD, new Uint8Array([0x03]));
      await sleep(100);
      await this.transport.sendReport(REPORT.USB_CMD, new Uint8Array([0x02]));
      await sleep(100);
      await this.transport.sendReport(REPORT.USB_CMD, new Uint8Array([0x04]));
      await sleep(100);
      this.debug("USB handshake complete");
    } catch {
      this.debug("USB handshake skipped (Bluetooth?)");
    }

    // Set input report mode to NFC/IR (0x31)
    await this.sendSubcommand(SUBCMD.SET_INPUT_MODE, [0x31]);
    await sleep(100);

    // Suspend -> Resume MCU (clean state)
    await this.sendSubcommand(SUBCMD.SET_MCU_STATE, [0x00]);
    await sleep(50);
    await this.sendSubcommand(SUBCMD.SET_MCU_STATE, [0x01]);

    // Wait for MCU standby
    this.log("Initializing NFC reader...");
    await this.pollUntilMcuState(MCU_STATE.STANDBY, MCU_TIMEOUT_MS);

    // Configure MCU for NFC mode
    await this.sendMcuConfig(0x21, 0x00, [0x04]);
    await this.pollUntilMcuState(MCU_STATE.NFC, MCU_TIMEOUT_MS);

    this.log("NFC reader ready");
    this.startNfcPolling();

    return {
      firmwareVersion: "",
      deviceName: this.name,
      capabilities: this.capabilities,
      // Scanner UI polls continuously — tags come and go freely.
      hotSwap: true,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    return null;
  }

  async detectCartridge(_systemId: SystemId): Promise<CartridgeInfo | null> {
    if (!this.detectedUid) return null;
    return {
      title: toHex(this.detectedUid),
      meta: { uid: this.detectedUid, uidHex: toHex(this.detectedUid) },
    };
  }

  async readROM(
    _config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.readInProgress) {
      throw new Error("Read already in progress");
    }
    this.readInProgress = true;
    try {
      this.stopNfcPolling();
      // Let in-flight poll commands settle
      await sleep(200);

      try {
        return await this.readNtag215(signal);
      } finally {
        // Clear detected UID so the scanner can detect re-placement or removal
        this.detectedUid = null;
        if (!this.disposed) this.startNfcPolling();
      }
    } finally {
      this.readInProgress = false;
    }
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

  /**
   * Stop polling, reject pending waiters, and detach the input listener.
   * Called by the connection layer before transport disconnect; safe to
   * call multiple times.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopNfcPolling();
    const waiters = this.mcuWaiters;
    this.mcuWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("Driver disposed"));
    }
    this.transport.setInputListener(null);
  }

  // ─── NTAG215 read ────────────────────────────────────────────────────

  private async readNtag215(signal?: AbortSignal): Promise<Uint8Array> {
    this.log("Reading NTAG215 (540 bytes)...");

    // Send start-waiting + read command
    await this.sendMcuNfc(NFC_CMD.START_WAITING, [...WAIT_ARGS]);
    await sleep(50);
    await this.sendMcuNfc(NFC_CMD.READ_NTAG, buildReadNtagArgs());

    // Keep sending status requests so the MCU delivers fragments.
    // Bail immediately if the caller aborts — otherwise a final packet can
    // race past clearInterval and desync the MCU.
    const keepalive = setInterval(() => {
      if (signal?.aborted || this.disposed) return;
      this.sendMcuNfc(NFC_CMD.START_WAITING, [...WAIT_ARGS]).catch(() => {});
    }, 100);

    try {
      const data = new Uint8Array(NTAG215_SIZE);

      // Fragment 1: 245 bytes of NTAG data at offset 115
      const frag1 = await this.waitForMcu(
        (d) =>
          d.length >= OFF.FRAG1_DATA + FRAG1_LEN &&
          d[OFF.MCU_REPORT_TYPE] === MCU_REPORT.NFC_DATA &&
          d[OFF.NFC_FRAGMENT_NUM] === 0x01,
        READ_TIMEOUT_MS,
        signal,
      );
      data.set(frag1.subarray(OFF.FRAG1_DATA, OFF.FRAG1_DATA + FRAG1_LEN), 0);
      this.emitProgress("rom", FRAG1_LEN, NTAG215_SIZE);

      // Fragment 2: 295 bytes of NTAG data at offset 55
      const frag2 = await this.waitForMcu(
        (d) =>
          d.length >= OFF.FRAG2_DATA + FRAG2_LEN &&
          d[OFF.MCU_REPORT_TYPE] === MCU_REPORT.NFC_DATA &&
          d[OFF.NFC_FRAGMENT_NUM] === 0x02,
        READ_TIMEOUT_MS,
        signal,
      );
      data.set(
        frag2.subarray(OFF.FRAG2_DATA, OFF.FRAG2_DATA + FRAG2_LEN),
        FRAG1_LEN,
      );
      this.emitProgress("rom", NTAG215_SIZE, NTAG215_SIZE);

      // Wait for read-finished confirmation
      await this.waitForMcu(
        (d) =>
          d.length > OFF.NFC_IC_STATE &&
          d[OFF.MCU_REPORT_TYPE] === MCU_REPORT.NFC_STATE &&
          d[OFF.NFC_IC_STATE] === NFC_IC.READ_FINISHED,
        READ_TIMEOUT_MS,
        signal,
      );

      this.log("Read complete");
      return data;
    } finally {
      clearInterval(keepalive);
    }
  }

  // ─── NFC polling ─────────────────────────────────────────────────────

  private startNfcPolling(): void {
    if (this.pollTimer || this.disposed) return;

    // Initial start-waiting command
    this.sendMcuNfc(NFC_CMD.START_WAITING, [...WAIT_ARGS]).catch(() => {});

    this.pollTimer = setInterval(() => {
      this.sendMcuNfc(NFC_CMD.START_POLLING, [...POLL_ARGS]).catch(() => {});
    }, 300);
  }

  private stopNfcPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.disposed) {
      this.sendMcuNfc(NFC_CMD.STOP_POLLING, [...WAIT_ARGS]).catch(() => {});
    }
  }

  // ─── Input report handling ───────────────────────────────────────────

  private handleInputReport = (data: Uint8Array, reportId: number): void => {
    if (reportId !== INPUT.MCU_DATA) return;
    // 0x81 and 0x21 replies don't carry MCU data we need to process
    this.handleMcuReport(data);
  };

  private handleMcuReport(data: Uint8Array): void {
    if (data.length <= OFF.MCU_REPORT_TYPE) return;

    const type = data[OFF.MCU_REPORT_TYPE];
    if (type === MCU_REPORT.EMPTY || type === MCU_REPORT.EMPTY_FF) return;

    // Update internal NFC detection state
    if (type === MCU_REPORT.NFC_STATE && data.length > OFF.NFC_IC_STATE) {
      const icState = data[OFF.NFC_IC_STATE];
      const result = data[OFF.NFC_RESULT];

      if (
        icState === NFC_IC.DETECTED &&
        data.length > OFF.TAG_UID_LEN &&
        data[OFF.TAG_PRESENT] === 1
      ) {
        const reportedLen = data[OFF.TAG_UID_LEN];
        const uidLen = Math.min(
          reportedLen,
          MAX_UID_LEN,
          Math.max(0, data.length - OFF.TAG_UID),
        );
        if (uidLen > 0) {
          const uid = data.slice(OFF.TAG_UID, OFF.TAG_UID + uidLen);
          if (!this.detectedUid || toHex(uid) !== toHex(this.detectedUid)) {
            this.detectedUid = uid;
            this.debug(`Tag detected: ${toHex(uid)}`);
          }
        }
      } else if (icState === NFC_IC.ERROR) {
        const errMsg = NFC_ERROR[result] ?? `0x${result.toString(16)}`;
        this.debug(`NFC error: ${errMsg}`);
      } else if (icState === NFC_IC.POLLING || icState === NFC_IC.WAITING) {
        if (this.detectedUid) {
          this.debug("Tag removed");
          this.detectedUid = null;
        }
      }
    }

    // Resolve waiters
    for (let i = this.mcuWaiters.length - 1; i >= 0; i--) {
      const waiter = this.mcuWaiters[i];
      if (waiter.predicate(data)) {
        clearTimeout(waiter.timer);
        this.mcuWaiters.splice(i, 1);
        waiter.resolve(data);
        return;
      }
    }
  }

  // ─── MCU waiter ──────────────────────────────────────────────────────

  private waitForMcu(
    predicate: (data: Uint8Array) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"));
        return;
      }
      if (this.disposed) {
        reject(new Error("Driver disposed"));
        return;
      }

      const timer = setTimeout(() => {
        const idx = this.mcuWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.mcuWaiters.splice(idx, 1);
        reject(new Error("MCU response timeout"));
      }, timeoutMs);

      const waiter: McuWaiter = { predicate, resolve, reject, timer };
      this.mcuWaiters.push(waiter);

      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          const idx = this.mcuWaiters.indexOf(waiter);
          if (idx >= 0) this.mcuWaiters.splice(idx, 1);
          reject(new Error("Aborted"));
        },
        { once: true },
      );
    });
  }

  /**
   * Send MCU status requests until the MCU reaches the target state.
   * Needed after sending MCU config commands — the MCU transitions
   * asynchronously and reports its state in 0x31 input reports.
   */
  private async pollUntilMcuState(
    targetState: number,
    timeoutMs: number,
  ): Promise<void> {
    const statePromise = this.waitForMcu(
      (d) =>
        d.length > OFF.MCU_STATE &&
        d[OFF.MCU_REPORT_TYPE] === MCU_REPORT.STATE &&
        d[OFF.MCU_STATE] === targetState,
      timeoutMs,
    );

    // Keep sending status requests to trigger MCU data in 0x31 reports
    const poll = setInterval(() => {
      if (this.disposed) return;
      this.sendMcuStatus().catch(() => {});
    }, 100);

    try {
      await statePromise;
    } finally {
      clearInterval(poll);
    }
  }

  // ─── Protocol layer ──────────────────────────────────────────────────

  /**
   * Send a subcommand via report 0x01.
   * Format: [packetNum, rumble[8], subcmd, ...args]
   */
  private async sendSubcommand(
    subcmd: number,
    args: number[] = [],
  ): Promise<void> {
    const packet = new Uint8Array(48);
    packet[0] = this.nextPacketNum();
    packet.set(NEUTRAL_RUMBLE, 1);
    packet[9] = subcmd;
    packet.set(args, 10);
    await this.transport.sendReport(REPORT.SUBCOMMAND, packet);
  }

  /**
   * Send an MCU config subcommand (0x21) with CRC-8.
   * Format: [packetNum, rumble[8], 0x21, mcuCmd, mcuSubCmdArg[36], crc8]
   */
  private async sendMcuConfig(
    mcuCmd: number,
    mcuSub: number,
    args: number[],
  ): Promise<void> {
    const mcuSubCmdArg = new Uint8Array(36);
    mcuSubCmdArg[0] = mcuSub;
    mcuSubCmdArg.set(args, 1);

    const packet = new Uint8Array(48);
    packet[0] = this.nextPacketNum();
    packet.set(NEUTRAL_RUMBLE, 1);
    packet[9] = SUBCMD.SET_MCU_CONFIG;
    packet[10] = mcuCmd;
    packet.set(mcuSubCmdArg, 11);
    packet[47] = crc8(mcuSubCmdArg);
    await this.transport.sendReport(REPORT.SUBCOMMAND, packet);
  }

  /**
   * Send an MCU NFC command via report 0x11 with CRC-8.
   * Format: [packetNum, rumble[8], mcuCmd(0x02), mcuSubCmdArg[36], crc8]
   */
  private async sendMcuNfc(subcmd: number, args: number[]): Promise<void> {
    const mcuSubCmdArg = new Uint8Array(36);
    mcuSubCmdArg[0] = subcmd;
    mcuSubCmdArg.set(args, 1);

    const packet = new Uint8Array(48);
    packet[0] = this.nextPacketNum();
    packet.set(NEUTRAL_RUMBLE, 1);
    packet[9] = MCU_CMD.NFC;
    packet.set(mcuSubCmdArg, 10);
    packet[46] = crc8(mcuSubCmdArg);
    await this.transport.sendReport(REPORT.MCU, packet);
  }

  /** Send MCU status request (report 0x11, cmd 0x01). No CRC needed. */
  private async sendMcuStatus(): Promise<void> {
    const packet = new Uint8Array(48);
    packet[0] = this.nextPacketNum();
    packet.set(NEUTRAL_RUMBLE, 1);
    packet[9] = MCU_CMD.STATUS;
    await this.transport.sendReport(REPORT.MCU, packet);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private nextPacketNum(): number {
    const n = this.packetNum;
    this.packetNum = (this.packetNum + 1) & 0x0f;
    return n;
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
    console.log(`[procon] ${message}`);
  }
}
