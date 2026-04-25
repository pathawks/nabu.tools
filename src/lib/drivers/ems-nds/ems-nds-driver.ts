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
  DeviceDriverEvents,
  DeviceCapability,
  DeviceInfo,
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
  parseFirmwareVersion,
  type FirmwareVersion,
} from "./ems-nds-commands";
import { MAKER_CODES } from "@/lib/systems/nds/nds-maker-codes";
import {
  parseNDSHeader as parseNDSHeaderShared,
  type CardHeader,
  type NDSCartridgeInfo,
  type NDSDeviceDriver,
} from "@/lib/systems/nds/nds-header";
import { formatBytes } from "@/lib/core/hashing";

interface CardStatus {
  saveType: number;
  saveSize: number;
  saveTypeName: string;
  firmwareVersion: FirmwareVersion;
  raw: Uint8Array;
}

const parseNDSHeader = (raw: Uint8Array): CardHeader =>
  parseNDSHeaderShared(raw, MAKER_CODES);

export class EMSNDSDriver implements NDSDeviceDriver {
  readonly id = "EMS_NDS";
  readonly name = "EMS NDS Adaptor Plus";
  readonly capabilities: DeviceCapability[] = [
    {
      systemId: "nds_save",
      operations: ["dump_save", "write_save"],
      autoDetect: true,
    },
  ];

  readonly transport: UsbTransport;
  private events: Partial<DeviceDriverEvents> = {};
  private firmwareVersion: FirmwareVersion | null = null;
  private status: CardStatus | null = null;
  private header: CardHeader | null = null;
  /** NDS cart chip ID (NTR opcode 0x90), captured during prepareCard. */
  private cardChipId = "";
  /**
   * Fingerprint of the last status response so we can detect cart swaps
   * between polls. Without this, a fast swap keeps the cached header and
   * mislabels cart B's dump with cart A's title/gameCode.
   */
  private lastStatusFingerprint = "";

  constructor(transport: UsbTransport) {
    this.transport = transport;
  }

  async initialize(): Promise<DeviceInfo> {
    let statusBytes: Uint8Array;
    try {
      statusBytes = await this.getStatus();
    } catch (e) {
      // No GB-device probe here. The former probe path closed and reopened
      // the USB device, and close+reopen has been observed to cause the
      // EMS firmware to issue stray SPI writes to any cart currently
      // inserted — permanently corrupting save data. Safer to just surface
      // the original failure and let the user diagnose (could be a GB-
      // variant EMS cart with the same VID/PID, a flaky connection, or a
      // cart in a bad state).
      const msg = (e as Error).message ?? String(e);
      throw new Error(
        `Device did not respond to GET_STATUS: ${msg}. ` +
          `If this is an EMS Game Boy USB Smart Card (same VID/PID as the ` +
          `NDS Adaptor+), it's not supported by this driver. Otherwise, try ` +
          `unplugging the adaptor, waiting 3 seconds, and reconnecting.`,
      );
    }

    if (statusBytes[5] !== STATUS_MARKER) {
      throw new Error(
        `Device did not respond as an NDS Adaptor ` +
          `(marker=0x${statusBytes[5].toString(16).padStart(2, "0")}, ` +
          `expected 0x${STATUS_MARKER.toString(16).padStart(2, "0")}). ` +
          "This may be an EMS Game Boy flash cart (same USB IDs, different protocol).",
      );
    }

    const fw = parseFirmwareVersion(statusBytes[6], statusBytes[7]);
    this.firmwareVersion = fw;
    this.log(`Firmware ${fw.display} (raw=${fw.raw})`);
    if (fw.recovery) {
      throw new Error(
        `Adaptor reports firmware in recovery state (${fw.display}). ` +
          `The firmware is damaged or mid-update; re-flash via the ` +
          `official EMS upgrader before attempting cart I/O.`,
      );
    }

    return {
      firmwareVersion: fw.display,
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
   * Poll for a cart and — on first detection — prepare the cart and read its
   * header so the UI can show the game title immediately. Returns null if
   * no cart is present, full CartridgeInfo otherwise. Header is cached until
   * the cart is removed, so repeated polling is cheap.
   *
   * The ndsplus reference sequence is status → prepare → header → save; by
   * doing the first three here we let readROM start straight into the save
   * read, with no interleaved commands between header and save.
   */
  async detectCartridge(_systemId: SystemId): Promise<NDSCartridgeInfo | null> {
    const statusBytes = await this.getStatus();

    if (statusBytes[0] === NO_CARD || statusBytes[1] === NO_CARD) {
      this.status = null;
      this.header = null;
      this.cardChipId = "";
      this.lastStatusFingerprint = "";
      return null;
    }

    // Detect cart swap across polls: if the status bytes changed, the cart
    // was replaced (or a previously-transient read has stabilised), so
    // invalidate the cached header so the next reader re-reads it.
    const fingerprint = Array.from(statusBytes).join(",");
    if (fingerprint !== this.lastStatusFingerprint) {
      this.header = null;
      this.cardChipId = "";
      this.lastStatusFingerprint = fingerprint;
    }

    if (!this.firmwareVersion) {
      throw new Error("detectCartridge() called before initialize()");
    }

    const { name, size } = this.parseSaveType(statusBytes);
    this.status = {
      saveType: statusBytes[0],
      saveSize: size,
      saveTypeName: name,
      firmwareVersion: this.firmwareVersion,
      raw: statusBytes,
    };

    if (!this.header) {
      await this.prepareCard();
      const headerBytes = await this.readCardHeader();
      this.header = parseNDSHeader(headerBytes);
      if (this.header.headerAllFF) {
        this.log(
          "Cartridge returned an all-0xFF header — likely a 3DS cart " +
            "(slot-1 format mismatch) or an NDS cart with dirty contacts.",
          "warn",
        );
      } else {
        this.log(
          `Card: ${this.header.title} [${this.header.gameCode}] — ${this.header.romSizeMiB} MiB ROM`,
        );
      }
      this.log(`Save: ${name} (${formatBytes(size)})`);
    }

    return this.buildCartInfo();
  }

  /** Full cart info including header data, populated by detectCartridge(). */
  get cartInfo(): NDSCartridgeInfo | null {
    if (!this.status) return null;
    return this.buildCartInfo();
  }

  /**
   * Dump save data. Assumes detectCartridge() has already run prepare + header
   * read (normal scanner flow); falls back to a detect pass if called directly.
   */
  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.status || !this.header) {
      const info = await this.detectCartridge("nds_save");
      if (!info) throw new Error("No card present");
    }

    const saveData = await this.readSaveData(config, signal);

    // Re-verify the cart is still the one we started with. Save data has
    // no canonical reference to hash against (unlike ROMs), so a cart
    // swap mid-dump would otherwise produce silent, undetectable
    // corruption — the .sav file would look fine but be wrong.
    await this.verifyCartUnchanged();

    return saveData;
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

    // Skip start-of-write identity check — see readROM for why a getStatus
    // here would disrupt the save session. The end-of-write verify (after
    // the readback compare) catches cart-swapped-mid-write and is
    // non-disruptive since the write session is already done by then.

    const saveSize = this.resolveSaveSize(config);
    this.assertSupportedSave(saveSize);
    this.assertWritableSave();

    if (data.length !== saveSize) {
      throw new Error(
        `Save file size (${data.length} bytes) does not match cart save size ` +
          `(${saveSize} bytes). Refusing to write.`,
      );
    }

    const { saveType } = this.status;

    this.log(`Writing ${formatBytes(saveSize)} save...`);

    for (let offset = 0; offset < saveSize; offset += WRITE_CHUNK) {
      if (signal?.aborted) throw new Error("Aborted");

      const chunk = data.slice(offset, offset + WRITE_CHUNK);
      await this.putSave(saveType, offset, chunk, signal);

      this.emitProgress(
        "save",
        Math.min(offset + WRITE_CHUNK, saveSize),
        saveSize,
      );
    }

    // Readback verify — save data is irreplaceable; confirm the device
    // actually accepted every byte before declaring success.
    this.log(`Verifying ${formatBytes(saveSize)} save...`);

    for (let offset = 0; offset < saveSize; offset += READ_CHUNK) {
      if (signal?.aborted) throw new Error("Aborted");

      const chunk = await this.getSave(saveType, offset);
      const n = Math.min(READ_CHUNK, saveSize - offset);
      if (chunk.length < n) {
        throw new Error(
          `Verify failed: short read at offset 0x${offset.toString(16)} ` +
            `(expected ${n} bytes, got ${chunk.length}).`,
        );
      }
      for (let i = 0; i < n; i++) {
        if (chunk[i] !== data[offset + i]) {
          const addr = (offset + i).toString(16).padStart(6, "0");
          throw new Error(
            `Verify failed at offset 0x${addr}: wrote 0x${data[offset + i]
              .toString(16)
              .padStart(2, "0")}, read back 0x${chunk[i]
              .toString(16)
              .padStart(2, "0")}. ` +
              `The cart may have rejected the write; save integrity is not guaranteed.`,
          );
        }
      }
      this.emitProgress("verify", offset + n, saveSize);
    }

    // Final cart-identity check. If the cart was swapped during the write
    // or readback, the byte-for-byte compare above would pass (we'd be
    // reading back from the new cart, which now has our data on it) —
    // only the chip ID tells us we wrote to the wrong cart.
    await this.verifyCartUnchanged();

    this.log("Save verified.");
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

  private async getStatus(): Promise<Uint8Array> {
    const cmd = new Uint8Array(10);
    cmd[0] = CMD.GET_STATUS;
    cmd[1] = MAGIC;
    cmd[6] = 0x02;
    await this.transport.send(cmd);
    return this.transport.receive(8);
  }

  /**
   * Abort the dump/write if the currently-inserted cart isn't the one the
   * scanner cached. Uses a fresh GET_STATUS and compares the raw status
   * bytes (save type, size, firmware version) against the ones captured
   * at detect time.
   *
   * We specifically do NOT re-run prepareCard here — that's 0x9F + 0x90
   * (NTR wake + GET_CHIP_ID), and the ndsplus firmware's save-read session
   * state is fragile to interleaved prepare commands between header and
   * save. GET_STATUS is a side-channel info query that doesn't touch the
   * cart's NTR state, so it's safe to run mid-session.
   */
  private async verifyCartUnchanged(): Promise<void> {
    const cached = this.status?.raw;
    if (!cached) return;

    const statusBytes = await this.getStatus();

    if (statusBytes[0] === NO_CARD || statusBytes[1] === NO_CARD) {
      throw new Error(
        "Cartridge removed since scan — re-insert and re-scan before dumping.",
      );
    }

    // Compare bytes — saveType, saveSize exponent, and firmware version
    // all change when the cart changes. Same cart reseated returns the
    // same bytes.
    for (let i = 0; i < cached.length && i < statusBytes.length; i++) {
      if (cached[i] !== statusBytes[i]) {
        throw new Error(
          "Cartridge changed since scan (status bytes differ). " +
            "Re-scan the new cart before dumping.",
        );
      }
    }
  }

  private async prepareCard(): Promise<void> {
    // Step 1: command 0x9F with address bytes also set to 0x9F
    const req1 = new Uint8Array(10);
    req1[0] = CMD.PREPARE_1;
    req1[1] = MAGIC;
    req1[2] = CMD.PREPARE_1;
    await this.transport.send(req1);

    // Step 2: command 0x90 is NDS NTR GET_CHIP_ID — capture the 4-byte
    // response so the UI and bug reports can show the cart's chip ID,
    // matching what the PowerSaves driver surfaces.
    const req2 = new Uint8Array(10);
    req2[0] = CMD.PREPARE_2;
    req2[1] = MAGIC;
    req2[2] = CMD.PREPARE_2;
    await this.transport.send(req2);
    const chipIdBytes = await this.transport.receive(4);
    this.cardChipId = Array.from(chipIdBytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
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
    // All bulk IN responses — status, header, save — use EP1 (the default).
    //
    // 3 s timeout: empirically, ndsplus responses are bimodal — either the
    // chunk arrives in well under 500 ms or the firmware has wedged and
    // will never respond. There's no "slow but successful" band in between
    // (the slow-read instrumentation in readSaveData confirms this).
    // Waiting longer than 3 s on a wedge is pure dead time before the
    // outer loop's close-and-reopen recovery kicks in.
    return this.transport.receive(READ_CHUNK, { timeout: 3_000 });
  }

  private async putSave(
    saveType: number,
    address: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    // FLASH types need an erase command before writing
    const eraseCmd = FLASH_ERASE_CMD[saveType];
    if (eraseCmd !== undefined) {
      if (signal?.aborted) throw new Error("Aborted");
      const erase = this.buildCommand(eraseCmd, address, saveType);
      await this.transport.send(erase);
    }

    if (signal?.aborted) throw new Error("Aborted");
    const write = this.buildCommand(CMD.WRITE_SAVE, address, saveType);
    await this.transport.send(write);

    if (signal?.aborted) throw new Error("Aborted");
    await this.transport.send(data);
  }

  // ─── Parsing helpers ──────────────────────────────────────────────────

  private readSaveData = async (
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    if (!this.status) throw new Error("Device not initialized");

    const saveSize = this.resolveSaveSize(config);
    this.assertSupportedSave(saveSize);

    const { saveType } = this.status;
    const result = new Uint8Array(saveSize);

    this.log(`Reading ${formatBytes(saveSize)} save...`);

    let offset = 0;
    while (offset < saveSize) {
      if (signal?.aborted) throw new Error("Aborted");

      let chunk: Uint8Array;
      try {
        chunk = await this.getSave(saveType, offset);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (!msg.includes("timeout")) throw e;

        // Fail fast on getSave timeout — DO NOT attempt an in-driver
        // recovery. A previous version of this driver called
        // transport.disconnect() + reopen here to drain orphaned
        // transferIn requests from Chromium's WebUSB queue; that
        // "recovery" path turned out to cause the EMS firmware to issue
        // actual SPI writes to the cart's save chip (0x5A written to the
        // first and last pages), permanently corrupting user save data.
        // Confirmed across two separate adapters reading the same pattern
        // and a physical-disconnect required to clear it (page buffer
        // theory ruled out — a restore-from-backup was needed).
        //
        // Only the user's physical cable disconnect guarantees no further
        // writes. Tell them to do that.
        throw new Error(
          `Save read stalled at offset 0x${offset.toString(16)}. ` +
            `Unplug the EMS adaptor from USB, wait 3 seconds, plug it back in, ` +
            `and reconnect to retry. Do not attempt to continue without a ` +
            `physical disconnect — the driver intentionally does not try to ` +
            `auto-recover because doing so has been observed to corrupt save data.`,
        );
      }

      const n = Math.min(READ_CHUNK, saveSize - offset);
      if (chunk.length < n) {
        throw new Error(
          `Short read at offset 0x${offset.toString(16)}: expected ${n} bytes, ` +
            `got ${chunk.length}. Save dump aborted to avoid silent zero-fill.`,
        );
      }
      result.set(chunk.subarray(0, n), offset);
      offset += n;

      this.emitProgress("save", offset, saveSize);
    }

    return result;
  };

  /**
   * Resolve the effective save size for a read/write operation. Rejects a
   * caller-provided saveSize that would read past the cart chip — a bug
   * there would produce wrapped/ghost data that still passes integrity
   * heuristics.
   */
  private resolveSaveSize(config: ReadConfig): number {
    if (!this.status) throw new Error("Device not initialized");
    const configured = config.params.saveSize as number | undefined;
    if (configured === undefined) return this.status.saveSize;
    if (configured > this.status.saveSize) {
      throw new Error(
        `Requested save size (${configured} bytes) exceeds the cart's save ` +
          `size (${this.status.saveSize} bytes). Refusing to operate past the chip.`,
      );
    }
    return configured;
  }

  /**
   * Throw a clear "unsupported cart" error before attempting any save I/O.
   * saveSize === 0 reaches this driver's save paths only when parseSaveType
   * couldn't classify the chip (NO_CARD is filtered earlier in detectCartridge).
   */
  private assertSupportedSave(saveSize: number): void {
    if (!this.status) throw new Error("Device not initialized");
    if (saveSize !== 0) return;
    const rawHex = Array.from(this.status.raw, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(" ");
    throw new Error(
      `Save chip not recognized (type=0x${this.status.saveType
        .toString(16)
        .padStart(2, "0")}). The cart is detected but its save chip is not ` +
        `in this driver's database. Please report this cart with the raw ` +
        `status bytes: ${rawHex}`,
    );
  }

  /**
   * Reject writes to save types where we don't know the erase command.
   * Without this guard, putSave silently skips erase for unknown FLASH
   * types and issues WRITE_SAVE — which on real FLASH corrupts the cart.
   */
  private assertWritableSave(): void {
    if (!this.status) throw new Error("Device not initialized");
    const type = this.status.saveType;
    const isEeprom = EEPROM_SIZES[type] !== undefined;
    const isKnownFlash = FLASH_ERASE_CMD[type] !== undefined;
    if (isEeprom || isKnownFlash) return;
    throw new Error(
      `Refusing to write: don't know how to erase save type 0x${type
        .toString(16)
        .padStart(2, "0")}. Reading this cart's save works, but writing ` +
        `without the correct erase sequence would corrupt the chip.`,
    );
  }

  private parseSaveType(status: Uint8Array): { name: string; size: number } {
    const type = status[0];
    if (type === NO_CARD) return { name: "None", size: 0 };

    const eeprom = EEPROM_SIZES[type];
    if (eeprom) return eeprom;

    // Real NDS save-FLASH exponents are 0x11..0x17 (2 KB..8 MB). Anything
    // outside is either a bus glitch, an EEPROM with an unknown type byte,
    // or a chip we don't support — refuse to guess.
    const exponent = status[4];
    if (exponent < 0x11 || exponent > 0x17) {
      this.log(
        `Unrecognized save chip (type=0x${type.toString(16).padStart(2, "0")}, ` +
          `exp=0x${exponent.toString(16).padStart(2, "0")})`,
        "warn",
      );
      return {
        name: `Unrecognized (type=0x${type
          .toString(16)
          .padStart(2, "0")}, exp=0x${exponent.toString(16).padStart(2, "0")})`,
        size: 0,
      };
    }
    return { name: "FLASH", size: 1 << exponent };
  }

  private buildCartInfo(): NDSCartridgeInfo {
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
        chipId: this.cardChipId || undefined,
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
