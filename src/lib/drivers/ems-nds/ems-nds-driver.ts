/**
 * EMS NDS Adapter+ — device driver for Nintendo DS/3DS save backup and restore.
 *
 * This device can read and write save data from DS/3DS cartridges but
 * cannot dump ROMs. The readROM() method returns save data as the
 * primary output, following the same pattern as the Amiibo driver.
 *
 * Protocol: github.com/Thulinma/ndsplus
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
import type { UsbTransport } from "@/lib/transport/usb-transport";
import {
  CMD,
  MAGIC,
  STATUS_MARKER,
  NO_CARD,
  READ_CHUNK,
  WRITE_CHUNK,
  EEPROM_SIZES,
  FLASH_ERASE_CMD,
} from "./ems-nds-commands";
import { MAKER_CODES } from "@/lib/systems/nds/nds-maker-codes";

interface CardStatus {
  saveType: number;
  saveSize: number;
  saveTypeName: string;
  firmwareVersion: number;
  raw: Uint8Array;
}

interface CardHeader {
  title: string;
  gameCode: string;
  makerCode: string;
  region: string;
  romVersion: number;
  romSizeMiB: number;
  validHeader: boolean;
  headerAllFF: boolean;
  raw: Uint8Array;
}

// NDS header reference: https://problemkaputt.de/gbatek.htm#dscartridgeheader
const NDS_EXPECTED_LOGO_CRC = 0xcf56;

const NDS_REGIONS: Record<string, string> = {
  J: "Japan",
  E: "USA",
  P: "Europe",
  K: "Korea",
  U: "Australia",
  C: "China",
  D: "Germany",
  F: "France",
  I: "Italy",
  S: "Spain",
  H: "Netherlands",
  R: "Russia",
  W: "International",
};

function parseNDSHeader(raw: Uint8Array): CardHeader {
  const allFF = raw.length > 0 && raw.every((b) => b === 0xff);
  const blank: CardHeader = {
    title: "Unknown",
    gameCode: "????",
    makerCode: "",
    region: "",
    romVersion: 0,
    romSizeMiB: 0,
    validHeader: false,
    headerAllFF: allFF,
    raw,
  };

  if (raw.length < 0x160 || raw[0] === 0xff) return blank;

  // Logo CRC check (0x15C-0x15D LE) — validates this is a real NDS header
  const logoCrc = raw[0x15c] | (raw[0x15d] << 8);
  const validHeader = logoCrc === NDS_EXPECTED_LOGO_CRC;

  const decoder = new TextDecoder("ascii");
  const title = decoder
    .decode(raw.slice(0x00, 0x0c))
    .replace(/\0+$/, "")
    .trim();
  const gameCode = decoder.decode(raw.slice(0x0c, 0x10));
  const makerRaw = decoder.decode(raw.slice(0x10, 0x12));
  const makerCode = MAKER_CODES[makerRaw] ?? makerRaw;
  const romVersion = raw[0x1e];
  const capacity = raw[0x14];
  const romSizeMiB = capacity > 3 ? 1 << (capacity - 3) : 0;

  const regionChar = gameCode[3] ?? "";
  const region = NDS_REGIONS[regionChar] ?? regionChar;

  return {
    title,
    gameCode,
    makerCode,
    region,
    romVersion,
    romSizeMiB,
    validHeader,
    headerAllFF: false,
    raw,
  };
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${bytes >> 10} KB`;
  return `${bytes >> 20} MB`;
}

export class EMSNDSDriver implements DeviceDriver {
  readonly id = "EMS_NDS";
  readonly name = "EMS NDS Adapter Plus";
  readonly capabilities: DeviceCapability[] = [
    {
      systemId: "nds_save",
      operations: ["dump_save", "write_save"],
      autoDetect: true,
    },
  ];

  readonly transport: UsbTransport;
  private events: Partial<DeviceDriverEvents> = {};
  private firmwareVersion = 0;
  private status: CardStatus | null = null;
  private header: CardHeader | null = null;

  constructor(transport: UsbTransport) {
    this.transport = transport;
  }

  async initialize(): Promise<DeviceInfo> {
    let statusBytes: Uint8Array;
    try {
      statusBytes = await this.getStatus();
    } catch (e) {
      // NDS protocol failed — probe for the EMS GB USB Smart Card,
      // which shares VID/PID 4670:9394 but uses a different protocol.
      if (await this.probeGameBoyDevice()) {
        throw new Error(
          "This is an EMS Game Boy USB Smart Card, not an NDS Adapter. " +
            "Both devices share the same USB IDs. " +
            "The Game Boy device is not currently supported.",
        );
      }
      throw e;
    }

    if (statusBytes[5] !== STATUS_MARKER) {
      throw new Error(
        "Device did not respond as an NDS Adapter. " +
          "This may be an EMS Game Boy flash cart (same USB IDs, different protocol).",
      );
    }

    const fw = statusBytes[7] * 256 + statusBytes[6];
    this.firmwareVersion = fw;
    this.log(`Firmware version ${fw}`);

    return {
      firmwareVersion: `${fw}`,
      deviceName: this.name,
      capabilities: this.capabilities,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    const info = await this.detectCartridge("nds_save");
    if (!info) return null;
    return { systemId: "nds_save", cartInfo: info };
  }

  /**
   * Quick status poll — only sends GET_STATUS.
   * Returns null if no cart is present, minimal CartridgeInfo otherwise.
   * Does NOT prepare the card or read the header (that happens in readROM).
   */
  async detectCartridge(_systemId: SystemId): Promise<CartridgeInfo | null> {
    const statusBytes = await this.getStatus();

    if (statusBytes[0] === NO_CARD || statusBytes[1] === NO_CARD) {
      this.status = null;
      this.header = null;
      return null;
    }

    const { name, size } = this.parseSaveType(statusBytes);
    this.status = {
      saveType: statusBytes[0],
      saveSize: size,
      saveTypeName: name,
      firmwareVersion: this.firmwareVersion,
      raw: statusBytes,
    };

    return this.buildCartInfo();
  }

  /** Full cart info including header data, available after readROM(). */
  get cartInfo(): CartridgeInfo | null {
    if (!this.status) return null;
    return this.buildCartInfo();
  }

  /**
   * Prepare card, read header, then read save data — all in one shot.
   * This matches the ndsplus reference sequence: status -> prepare -> header -> save.
   * The prepare+header+save must run without other commands interleaved.
   */
  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const statusBytes = await this.getStatus();

    if (statusBytes[0] === NO_CARD || statusBytes[1] === NO_CARD) {
      throw new Error("No card present");
    }

    const { name, size } = this.parseSaveType(statusBytes);
    this.status = {
      saveType: statusBytes[0],
      saveSize: size,
      saveTypeName: name,
      firmwareVersion: this.firmwareVersion,
      raw: statusBytes,
    };

    await this.prepareCard();
    const headerBytes = await this.readCardHeader();
    this.header = parseNDSHeader(headerBytes);
    this.log(
      `Card: ${this.header.title} [${this.header.gameCode}] — ${this.header.romSizeMiB} MiB ROM`,
    );
    this.log(`Save: ${name} (${formatSize(size)})`);

    return this.readSaveData(config, signal);
  }

  async readSave(
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.readROM(config, signal);
  }

  async writeSave(
    data: Uint8Array,
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.status) throw new Error("Device not initialized");

    const saveSize =
      (config.params.saveSize as number | undefined) ?? this.status.saveSize;
    const { saveType } = this.status;

    this.log(`Writing ${formatSize(saveSize)} save...`);

    for (let offset = 0; offset < saveSize; offset += WRITE_CHUNK) {
      if (signal?.aborted) throw new Error("Aborted");

      const chunk = data.slice(offset, offset + WRITE_CHUNK);
      await this.putSave(saveType, offset, chunk);

      this.emitProgress("save", offset + WRITE_CHUNK, saveSize);
    }
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  // ─── Protocol commands ──────────────────────────────────────────────────

  private buildCommand(cmd: number, address = 0, saveType = 0): Uint8Array {
    const pkt = new Uint8Array(10);
    pkt[0] = cmd;
    pkt[1] = MAGIC;
    pkt[2] = address & 0xff;
    pkt[3] = (address >> 8) & 0xff;
    pkt[4] = (address >> 16) & 0xff;
    pkt[5] = (address >> 24) & 0xff;
    pkt[6] = 0x02;
    pkt[7] = saveType;
    return pkt;
  }

  /**
   * After a failed NDS probe, reset the USB interface and send a
   * GB-format 9-byte ROM read. If the device responds, it's a
   * Game Boy USB Smart Card, not an NDS Adapter.
   */
  private async probeGameBoyDevice(): Promise<boolean> {
    try {
      // Reset interface to clear garbled state from the NDS probe
      await this.transport.disconnect();
      const devices = await navigator.usb!.getDevices();
      const dev = devices.find(
        (d) => d.vendorId === 0x4670 && d.productId === 0x9394,
      );
      if (!dev) return false;
      await dev.open();
      await dev.selectConfiguration(1);
      await dev.claimInterface(0);

      // GB protocol: 9-byte command — read 512 bytes of ROM at address 0
      // Format: [opcode(1), address_BE(4), length_BE(4)]
      const cmd = new Uint8Array([
        0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00,
      ]);
      await dev.transferOut(2, cmd);
      const result = await Promise.race([
        dev.transferIn(1, 512),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2000),
        ),
      ]);

      await dev.releaseInterface(0);
      await dev.close();
      return result.data != null && result.data.byteLength > 0;
    } catch {
      return false;
    }
  }

  private async getStatus(): Promise<Uint8Array> {
    const cmd = new Uint8Array(10);
    cmd[0] = CMD.GET_STATUS;
    cmd[1] = MAGIC;
    cmd[6] = 0x02;
    await this.transport.send(cmd);
    return this.transport.receive(8);
  }

  private async prepareCard(): Promise<void> {
    // Step 1: command 0x9F with address bytes also set to 0x9F
    const req1 = new Uint8Array(10);
    req1[0] = CMD.PREPARE_1;
    req1[1] = MAGIC;
    req1[2] = CMD.PREPARE_1;
    await this.transport.send(req1);

    // Step 2: command 0x90 with address byte 2 also set to 0x90, read 4-byte response
    const req2 = new Uint8Array(10);
    req2[0] = CMD.PREPARE_2;
    req2[1] = MAGIC;
    req2[2] = CMD.PREPARE_2;
    await this.transport.send(req2);
    await this.transport.receive(4);
  }

  private async readCardHeader(): Promise<Uint8Array> {
    // Command 0x00 returns the first 512 bytes of the NDS ROM header
    const cmd = new Uint8Array(10);
    cmd[0] = CMD.READ_HEADER;
    cmd[1] = MAGIC;
    await this.transport.send(cmd);
    return this.transport.receive(512);
  }

  private async getSave(
    saveType: number,
    address: number,
  ): Promise<Uint8Array> {
    const cmd = this.buildCommand(CMD.READ_SAVE, address, saveType);
    await this.transport.send(cmd);
    // Save data arrives on EP3, not EP1 (which handles status/prepare/header)
    return this.transport.receive(READ_CHUNK, {
      timeout: 10_000,
      endpointIn: 3,
    });
  }

  private async putSave(
    saveType: number,
    address: number,
    data: Uint8Array,
  ): Promise<void> {
    // FLASH types need an erase command before writing
    const eraseCmd = FLASH_ERASE_CMD[saveType];
    if (eraseCmd !== undefined) {
      const erase = this.buildCommand(eraseCmd, address, saveType);
      await this.transport.send(erase);
    }

    const write = this.buildCommand(CMD.WRITE_SAVE, address, saveType);
    await this.transport.send(write);
    await this.transport.send(data);
  }

  // ─── Parsing helpers ──────────────────────────────────────────────────

  private readSaveData = async (
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    if (!this.status) throw new Error("Device not initialized");

    const saveSize =
      (config.params.saveSize as number | undefined) ?? this.status.saveSize;
    if (saveSize === 0)
      throw new Error("No save data to read (save size is 0)");

    const { saveType } = this.status;
    const result = new Uint8Array(saveSize);

    this.log(`Reading ${formatSize(saveSize)} save...`);

    for (let offset = 0; offset < saveSize; offset += READ_CHUNK) {
      if (signal?.aborted) throw new Error("Aborted");

      const chunk = await this.getSave(saveType, offset);
      const n = Math.min(READ_CHUNK, saveSize - offset);
      result.set(chunk.subarray(0, n), offset);

      this.emitProgress("rom", offset + n, saveSize);
    }

    return result;
  };

  private parseSaveType(status: Uint8Array): { name: string; size: number } {
    const type = status[0];
    if (type === NO_CARD) return { name: "None", size: 0 };

    const eeprom = EEPROM_SIZES[type];
    if (eeprom) return eeprom;

    // FLASH: size = 1 << status[4]
    const exponent = status[4];
    if (exponent > 0x20) {
      this.log(
        `Unknown save exponent 0x${exponent.toString(16)} for type 0x${type.toString(16)}`,
        "warn",
      );
      return { name: `Unknown (0x${type.toString(16)})`, size: 0 };
    }
    const size = 1 << exponent;
    return { name: "FLASH", size };
  }

  private buildCartInfo(): CartridgeInfo {
    const valid = this.header?.validHeader ?? false;
    return {
      title: valid ? this.header?.title : undefined,
      saveSize: this.status?.saveSize,
      saveType: this.status?.saveTypeName,
      rawHeader: this.header?.raw,
      meta: {
        gameCode: valid ? this.header?.gameCode : undefined,
        makerCode: valid ? this.header?.makerCode : undefined,
        region: valid ? this.header?.region : undefined,
        romVersion: valid ? this.header?.romVersion : undefined,
        romSizeMiB: valid ? this.header?.romSizeMiB : undefined,
        is3DS: this.header?.headerAllFF ?? false,
      },
    };
  }

  // ─── Event helpers ────────────────────────────────────────────────────

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
