/**
 * Nintendo Switch Pro Controller / Joy-Con (R) — NFC Amiibo reader.
 *
 * Reads NTAG215 tags (540 bytes) via the controller's built-in NFC reader.
 * Uses HID input report 0x31 (MCU data mode) with the NFC sub-protocol.
 *
 * References:
 *   github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering
 *   github.com/aka256/joycon-webhid
 *   github.com/CTCaer/jc_toolkit
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

interface McuWaiter {
  predicate: (data: DataView) => boolean;
  resolve: (data: DataView) => void;
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
  private device: HIDDevice;
  private events: Partial<DeviceDriverEvents> = {};

  // Packet counter (low nibble, 0x0-0xF)
  private packetNum = 0;

  // MCU waiter queue — resolved by input report handler
  private mcuWaiters: McuWaiter[] = [];

  // NFC polling state
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private detectedUid: Uint8Array | null = null;

  constructor(transport: HidTransport, device: HIDDevice) {
    this.transport = transport;
    this.device = device;
    device.addEventListener("inputreport", this.onInputReport);
  }

  // ─── DeviceDriver interface ──────────────────────────────────────────

  async initialize(): Promise<DeviceInfo> {
    // USB handshake — required for USB-connected controllers.
    // Steps: get status -> UART handshake -> switch to 3 Mbps baud ->
    //        re-handshake at new baud -> force USB-only mode.
    // Bluetooth controllers don't support report 0x80, so we catch errors.
    try {
      await this.device.sendReport(REPORT.USB_CMD, new Uint8Array([0x01]));
      await sleep(100);
      await this.device.sendReport(REPORT.USB_CMD, new Uint8Array([0x02]));
      await sleep(100);
      await this.device.sendReport(REPORT.USB_CMD, new Uint8Array([0x03]));
      await sleep(100);
      await this.device.sendReport(REPORT.USB_CMD, new Uint8Array([0x02]));
      await sleep(100);
      await this.device.sendReport(REPORT.USB_CMD, new Uint8Array([0x04]));
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
    this.stopNfcPolling();
    // Let in-flight poll commands settle
    await sleep(200);

    try {
      return await this.readNtag215(signal);
    } finally {
      // Clear detected UID so the scanner can detect re-placement or removal
      this.detectedUid = null;
      this.startNfcPolling();
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

  // ─── NTAG215 read ────────────────────────────────────────────────────

  private async readNtag215(signal?: AbortSignal): Promise<Uint8Array> {
    this.log("Reading NTAG215 (540 bytes)...");

    // Send start-waiting + read command
    await this.sendMcuNfc(NFC_CMD.START_WAITING, [...WAIT_ARGS]);
    await sleep(50);
    await this.sendMcuNfc(NFC_CMD.READ_NTAG, buildReadNtagArgs());

    // Keep sending status requests so the MCU delivers fragments
    const keepalive = setInterval(() => {
      this.sendMcuNfc(NFC_CMD.START_WAITING, [...WAIT_ARGS]).catch(() => {});
    }, 100);

    try {
      const data = new Uint8Array(NTAG215_SIZE);

      // Fragment 1: 245 bytes of NTAG data at offset 115
      const frag1 = await this.waitForMcu(
        (d) =>
          d.getUint8(OFF.MCU_REPORT_TYPE) === MCU_REPORT.NFC_DATA &&
          d.getUint8(OFF.NFC_FRAGMENT_NUM) === 0x01,
        READ_TIMEOUT_MS,
        signal,
      );
      for (let i = 0; i < FRAG1_LEN; i++) {
        data[i] = frag1.getUint8(OFF.FRAG1_DATA + i);
      }
      this.emitProgress("rom", FRAG1_LEN, NTAG215_SIZE);

      // Fragment 2: 295 bytes of NTAG data at offset 55
      const frag2 = await this.waitForMcu(
        (d) =>
          d.getUint8(OFF.MCU_REPORT_TYPE) === MCU_REPORT.NFC_DATA &&
          d.getUint8(OFF.NFC_FRAGMENT_NUM) === 0x02,
        READ_TIMEOUT_MS,
        signal,
      );
      for (let i = 0; i < FRAG2_LEN; i++) {
        data[FRAG1_LEN + i] = frag2.getUint8(OFF.FRAG2_DATA + i);
      }
      this.emitProgress("rom", NTAG215_SIZE, NTAG215_SIZE);

      // Wait for read-finished confirmation
      await this.waitForMcu(
        (d) =>
          d.getUint8(OFF.MCU_REPORT_TYPE) === MCU_REPORT.NFC_STATE &&
          d.getUint8(OFF.NFC_IC_STATE) === NFC_IC.READ_FINISHED,
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
    if (this.pollTimer) return;

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
    this.sendMcuNfc(NFC_CMD.STOP_POLLING, [...WAIT_ARGS]).catch(() => {});
  }

  // ─── Input report handling ───────────────────────────────────────────

  private onInputReport = (event: Event): void => {
    const e = event as unknown as HIDInputReportEvent;
    const { data, reportId } = e;

    if (reportId === INPUT.MCU_DATA) {
      this.handleMcuReport(data);
    }
    // 0x81 and 0x21 replies don't carry MCU data we need to process
  };

  private handleMcuReport(data: DataView): void {
    const type = data.getUint8(OFF.MCU_REPORT_TYPE);
    if (type === MCU_REPORT.EMPTY || type === MCU_REPORT.EMPTY_FF) return;

    // Update internal NFC detection state
    if (type === MCU_REPORT.NFC_STATE) {
      const icState = data.getUint8(OFF.NFC_IC_STATE);
      const result = data.getUint8(OFF.NFC_RESULT);

      if (
        icState === NFC_IC.DETECTED &&
        data.getUint8(OFF.TAG_PRESENT) === 1
      ) {
        const uidLen = data.getUint8(OFF.TAG_UID_LEN);
        const uid = new Uint8Array(uidLen);
        for (let i = 0; i < uidLen; i++) {
          uid[i] = data.getUint8(OFF.TAG_UID + i);
        }
        if (!this.detectedUid || toHex(uid) !== toHex(this.detectedUid)) {
          this.detectedUid = uid;
          this.debug(`Tag detected: ${toHex(uid)}`);
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
    predicate: (data: DataView) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DataView> {
    return new Promise<DataView>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"));
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
        d.getUint8(OFF.MCU_REPORT_TYPE) === MCU_REPORT.STATE &&
        d.getUint8(OFF.MCU_STATE) === targetState,
      timeoutMs,
    );

    // Keep sending status requests to trigger MCU data in 0x31 reports
    const poll = setInterval(() => {
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
    for (let i = 0; i < args.length; i++) packet[10 + i] = args[i];
    await this.device.sendReport(REPORT.SUBCOMMAND, packet);
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
    for (let i = 0; i < args.length; i++) mcuSubCmdArg[1 + i] = args[i];

    const packet = new Uint8Array(48);
    packet[0] = this.nextPacketNum();
    packet.set(NEUTRAL_RUMBLE, 1);
    packet[9] = SUBCMD.SET_MCU_CONFIG;
    packet[10] = mcuCmd;
    packet.set(mcuSubCmdArg, 11);
    packet[47] = crc8(mcuSubCmdArg);
    await this.device.sendReport(REPORT.SUBCOMMAND, packet);
  }

  /**
   * Send an MCU NFC command via report 0x11 with CRC-8.
   * Format: [packetNum, rumble[8], mcuCmd(0x02), mcuSubCmdArg[36], crc8]
   */
  private async sendMcuNfc(subcmd: number, args: number[]): Promise<void> {
    const mcuSubCmdArg = new Uint8Array(36);
    mcuSubCmdArg[0] = subcmd;
    for (let i = 0; i < args.length; i++) mcuSubCmdArg[1 + i] = args[i];

    const packet = new Uint8Array(48);
    packet[0] = this.nextPacketNum();
    packet.set(NEUTRAL_RUMBLE, 1);
    packet[9] = MCU_CMD.NFC;
    packet.set(mcuSubCmdArg, 10);
    packet[46] = crc8(mcuSubCmdArg);
    await this.device.sendReport(REPORT.MCU, packet);
  }

  /** Send MCU status request (report 0x11, cmd 0x01). No CRC needed. */
  private async sendMcuStatus(): Promise<void> {
    const packet = new Uint8Array(48);
    packet[0] = this.nextPacketNum();
    packet.set(NEUTRAL_RUMBLE, 1);
    packet[9] = MCU_CMD.STATUS;
    await this.device.sendReport(REPORT.MCU, packet);
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
