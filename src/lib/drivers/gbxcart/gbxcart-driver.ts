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
import type { SerialTransport } from "@/lib/transport/serial-transport";
import { CMD, VAR, DMG_ACCESS } from "./gbxcart-commands";
import { sendCommand, setVariable, cartWrite } from "./gbxcart-protocol";
// The DeviceDriver.detectSystem() interface requires returning typed CartridgeInfo,
// so we use system-layer header parsers here. These are pure functions (Uint8Array in,
// struct out) with no side effects, making this a contained cross-layer dependency.
import {
  parseGBHeader,
  gbHeaderToCartridgeInfo,
} from "@/lib/systems/gb/gb-header";
import {
  parseGBAHeader,
  gbaHeaderToCartridgeInfo,
} from "@/lib/systems/gba/gba-header";

interface FirmwareInfo {
  pcbVersion: number;
  fwVersion: number;
  cfwId: string;
  deviceName: string;
  expectAck: boolean;
}

export class GBxCartDriver implements DeviceDriver {
  readonly id = "GBXCART";
  readonly name = "GBxCart RW";
  readonly capabilities: DeviceCapability[] = [
    { systemId: "gb", operations: ["dump_rom", "dump_save"], autoDetect: true },
    {
      systemId: "gbc",
      operations: ["dump_rom", "dump_save"],
      autoDetect: true,
    },
    {
      systemId: "gba",
      operations: ["dump_rom", "dump_save"],
      autoDetect: true,
    },
  ];

  transport: SerialTransport;
  private events: Partial<DeviceDriverEvents> = {};
  private fw: FirmwareInfo | null = null;

  constructor(transport: SerialTransport) {
    this.transport = transport;
  }

  async initialize(): Promise<DeviceInfo> {
    // CH340 needs time to settle after port open.
    // After a page refresh, the firmware retains state from the previous
    // session and may have bytes buffered. Flush aggressively.
    await new Promise((r) => setTimeout(r, 300));
    await this.transport.flush();
    // Send a null byte to nudge any pending command to finish,
    // then flush whatever comes back.
    await this.transport.send(new Uint8Array([0x00]));
    await new Promise((r) => setTimeout(r, 200));
    await this.transport.flush();

    // Query PCB version
    await this.transport.send(new Uint8Array([CMD.OFW_PCB_VER]));
    const pcbBuf = await this.transport.receive(1, { timeout: 2000 });
    const pcbVersion = pcbBuf[0];
    this.debug(`PCB version: ${pcbVersion}`);

    // Query original firmware version
    await this.transport.send(new Uint8Array([CMD.OFW_FW_VER]));
    const ofwBuf = await this.transport.receive(1, { timeout: 1000 });
    const ofw = ofwBuf[0];
    this.debug(`OFW version: ${ofw}`);

    let cfwId = "";
    let fwVersion = ofw;
    let deviceName = "GBxCart RW";
    let expectAck = false;

    // Query custom firmware info if available (PCB >= 5, ofw == 0)
    if (pcbVersion >= 5) {
      try {
        await this.transport.send(new Uint8Array([CMD.QUERY_FW_INFO]));
        const sizeBuf = await this.transport.receive(1, { timeout: 500 });
        const infoSize = sizeBuf[0];

        if (infoSize >= 8) {
          const infoBuf = await this.transport.receive(infoSize, {
            timeout: 1000,
          });
          cfwId = String.fromCharCode(infoBuf[0]);
          fwVersion = (infoBuf[1] << 8) | infoBuf[2];
          // pcb from info at byte 3
          // fw_ts at bytes 4-7

          this.debug(`Custom firmware: ${cfwId} v${fwVersion}`);
          expectAck = cfwId === "L" && fwVersion >= 12;

          // Read device name if available
          if (cfwId === "L" && fwVersion >= 12) {
            const nameLen = await this.transport.receive(1, { timeout: 500 });
            if (nameLen[0] > 0) {
              const nameBuf = await this.transport.receive(nameLen[0], {
                timeout: 500,
              });
              deviceName = new TextDecoder().decode(nameBuf);
            }
            // cart_power_ctrl and bootloader_reset
            await this.transport.receive(2, { timeout: 500 });
          }
        }
      } catch {
        this.log("Custom firmware query failed, using OFW mode", "warn");
      }
    }

    this.fw = { pcbVersion, fwVersion, cfwId, deviceName, expectAck };

    // Flush any leftover bytes from firmware info exchange
    await this.transport.flush();

    return {
      firmwareVersion: cfwId ? `${cfwId}${fwVersion}` : `OFW ${fwVersion}`,
      hardwareRevision: `PCB v${pcbVersion}`,
      deviceName,
      capabilities: this.capabilities,
      // TODO: enable hot-swap when we capture cart_power_ctrl and implement
      // CART_PWR_OFF → prompt → CART_PWR_ON. Per FlashGBX hw_GBxCartRW.py:
      //   fw_ver >= 12 → honour cart_power_ctrl byte
      //   else         → pcb_ver in (5, 6)
      // Driver currently discards those bytes at the "cart_power_ctrl and
      // bootloader_reset" line above; hot-swap stays false until the follow-up.
      hotSwap: false,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    if (!this.fw) throw new Error("Not initialized");

    // Try GBA first — 3.3V is safe for all cartridge types
    this.debug("Probing GBA mode (3.3V)...");
    const agbInfo = await this.detectAGB();
    if (agbInfo?.meta?.headerChecksumValid) {
      return { systemId: "gba", cartInfo: agbInfo };
    }

    // Fall back to DMG mode (5V) for GB/GBC
    this.debug("Probing DMG mode (5V)...");
    const dmgInfo = await this.detectDMG();
    if (dmgInfo) {
      const isCGB = dmgInfo.meta?.isCGB === true;
      const systemId = isCGB ? "gbc" : "gb";
      return { systemId, cartInfo: dmgInfo };
    }

    this.log("No cartridge detected", "warn");
    return null;
  }

  async detectCartridge(systemId: SystemId): Promise<CartridgeInfo | null> {
    if (!this.fw) throw new Error("Not initialized");

    if (systemId === "gb" || systemId === "gbc") {
      return this.detectDMG();
    }
    if (systemId === "gba") {
      return this.detectAGB();
    }
    return null;
  }

  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.fw) throw new Error("Not initialized");

    if (config.systemId === "gb" || config.systemId === "gbc") {
      return this.readDMGRom(config, signal);
    }
    if (config.systemId === "gba") {
      return this.readAGBRom(config, signal);
    }
    throw new Error(`Unsupported system: ${config.systemId}`);
  }

  async readSave(
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!this.fw) throw new Error("Not initialized");

    if (config.systemId === "gb" || config.systemId === "gbc") {
      return this.readDMGSave(config, signal);
    }
    throw new Error(`Save reading not yet implemented for ${config.systemId}`);
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("Save writing not yet implemented");
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  // ─── DMG (Game Boy) ─────────────────────────────────────────────────────

  private async setModeDMG(): Promise<void> {
    const ack = this.fw!.expectAck;

    // Match FlashGBX SetMode("DMG") sequence exactly
    await sendCommand(this.transport, CMD.SET_MODE_DMG, ack);
    await sendCommand(this.transport, CMD.SET_VOLTAGE_5V, ack);
    await setVariable(this.transport, VAR.DMG_READ_METHOD, 1, ack);
    await setVariable(this.transport, VAR.CART_MODE, 1, ack);
    await setVariable(this.transport, VAR.DMG_WRITE_CS_PULSE, 0, ack);
    await setVariable(this.transport, VAR.DMG_READ_CS_PULSE, 0, ack);
    await setVariable(this.transport, VAR.ADDRESS, 0, ack);

    // CartPowerOn — FlashGBX re-sends SET_MODE before powering on
    await sendCommand(this.transport, CMD.SET_MODE_DMG, ack);
    await sendCommand(this.transport, CMD.CART_PWR_ON, ack);
    await new Promise((r) => setTimeout(r, 300));
    this.debug("DMG mode set, cart powered on");
  }

  private async detectDMG(): Promise<CartridgeInfo | null> {
    await this.setModeDMG();
    this.debug("Reading DMG cartridge header...");

    const ack = this.fw!.expectAck;

    // Read 0x180 bytes in one shot (FlashGBX reads header as a single transfer)
    const headerSize = 0x180;
    await setVariable(this.transport, VAR.TRANSFER_SIZE, headerSize, ack);
    await setVariable(this.transport, VAR.ADDRESS, 0, ack);
    await setVariable(this.transport, VAR.DMG_ACCESS_MODE, DMG_ACCESS.ROM, ack);
    await this.transport.send(new Uint8Array([CMD.DMG_CART_READ]));
    const headerData = await this.transport.receive(headerSize, {
      timeout: 3000,
    });

    const header = parseGBHeader(headerData);
    if (!header) {
      this.debug("Failed to parse DMG header");
      return null;
    }

    if (!header.headerChecksumValid) {
      this.debug("DMG header checksum invalid");
      return null;
    }

    this.log(
      `${header.title} — ${header.cartTypeName}, ${header.romSize / 1024} KB`,
    );

    const info = gbHeaderToCartridgeInfo(header);
    info.rawHeader = headerData;
    return info;
  }

  private async readDMGRom(
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    await this.setModeDMG();

    const romSize = config.params.romSizeBytes as number;
    const bankSize = 0x4000; // 16 KB
    const bankCount = romSize / bankSize;
    const maxChunk = 0x1000; // 4 KB per read command
    const ack = this.fw!.expectAck;

    // Determine MBC type for bank switching
    const mbcType = (config.params.mbcType as string) ?? "MBC5";

    this.log(`Reading ${romSize / 1024} KB ROM...`);

    // Enable mapper RAM access
    await cartWrite(this.transport, 0x0000, 0x0a, ack);

    const rom = new Uint8Array(romSize);
    let bytesRead = 0;

    for (let bank = 0; bank < bankCount; bank++) {
      if (signal?.aborted) throw new Error("Aborted");

      // Bank switching
      const startAddr = this.selectBankROM(bank);
      await this.applyBankSwitch(bank, mbcType, ack);

      // Read this bank in chunks
      let bankOffset = 0;
      while (bankOffset < bankSize) {
        if (signal?.aborted) throw new Error("Aborted");

        const chunkSize = Math.min(maxChunk, bankSize - bankOffset);
        await setVariable(this.transport, VAR.TRANSFER_SIZE, chunkSize, ack);
        await setVariable(
          this.transport,
          VAR.ADDRESS,
          startAddr + bankOffset,
          ack,
        );
        await setVariable(
          this.transport,
          VAR.DMG_ACCESS_MODE,
          DMG_ACCESS.ROM,
          ack,
        );
        await this.transport.send(new Uint8Array([CMD.DMG_CART_READ]));
        const chunk = await this.transport.receive(chunkSize, {
          timeout: 5000,
        });

        rom.set(chunk, bytesRead);
        bytesRead += chunkSize;
        bankOffset += chunkSize;

        this.emitProgress("rom", bytesRead, romSize);
      }
    }

    this.debug(`ROM read complete: ${bytesRead} bytes`);
    return rom;
  }

  private selectBankROM(bank: number): number {
    // Bank 0 always reads from 0x0000, all others from 0x4000
    if (bank === 0) return 0x0000;
    return 0x4000;
  }

  private async applyBankSwitch(
    bank: number,
    mbcType: string,
    ack: boolean,
  ): Promise<void> {
    if (bank === 0) return; // Bank 0 is always mapped

    switch (mbcType) {
      case "MBC1":
        await cartWrite(this.transport, 0x6000, 0x01, ack); // ROM banking mode
        await cartWrite(this.transport, 0x2000, bank & 0x1f, ack);
        if (bank > 0x1f) {
          await cartWrite(this.transport, 0x4000, (bank >> 5) & 0x03, ack);
        }
        break;

      case "MBC3":
        await cartWrite(this.transport, 0x2100, bank & 0xff, ack);
        break;

      case "MBC5":
        await cartWrite(this.transport, 0x3000, (bank >> 8) & 0xff, ack);
        await cartWrite(this.transport, 0x2100, bank & 0xff, ack);
        break;

      default:
        // Default: write bank to 0x2100
        await cartWrite(this.transport, 0x2100, bank & 0xff, ack);
        break;
    }
  }

  private async readDMGSave(
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    await this.setModeDMG();

    const saveSize = config.params.saveSizeBytes as number;
    if (!saveSize || saveSize <= 0) return new Uint8Array(0);

    const ack = this.fw!.expectAck;
    const maxChunk = 0x1000;

    this.log(`Reading ${saveSize / 1024} KB save...`);

    // Enable SRAM access
    await cartWrite(this.transport, 0x0000, 0x0a, ack);

    const save = new Uint8Array(saveSize);
    let bytesRead = 0;
    const ramBankSize = 0x2000; // 8 KB per RAM bank
    const ramBanks = Math.ceil(saveSize / ramBankSize);

    for (let bank = 0; bank < ramBanks; bank++) {
      if (signal?.aborted) throw new Error("Aborted");

      // Select RAM bank
      await cartWrite(this.transport, 0x4000, bank & 0xff, ack);

      const bankBytes = Math.min(ramBankSize, saveSize - bytesRead);
      let bankOffset = 0;

      while (bankOffset < bankBytes) {
        if (signal?.aborted) throw new Error("Aborted");

        const chunkSize = Math.min(maxChunk, bankBytes - bankOffset);
        await setVariable(this.transport, VAR.TRANSFER_SIZE, chunkSize, ack);
        await setVariable(
          this.transport,
          VAR.ADDRESS,
          0xa000 + bankOffset,
          ack,
        );
        await setVariable(
          this.transport,
          VAR.DMG_ACCESS_MODE,
          DMG_ACCESS.SRAM,
          ack,
        );
        await this.transport.send(new Uint8Array([CMD.DMG_CART_READ]));
        const chunk = await this.transport.receive(chunkSize, {
          timeout: 5000,
        });

        save.set(chunk, bytesRead);
        bytesRead += chunkSize;
        bankOffset += chunkSize;

        this.emitProgress("save", bytesRead, saveSize);
      }
    }

    // Disable SRAM access
    await cartWrite(this.transport, 0x0000, 0x00, ack);

    this.debug(`Save read complete: ${bytesRead} bytes`);
    return save;
  }

  // ─── AGB (GBA) ──────────────────────────────────────────────────────────

  private async setModeAGB(): Promise<void> {
    const ack = this.fw!.expectAck;

    // Configure mode and variables BEFORE power-on (FlashGBX order)
    await sendCommand(this.transport, CMD.SET_MODE_AGB, ack);
    await sendCommand(this.transport, CMD.SET_VOLTAGE_3_3V, ack);
    await sendCommand(this.transport, CMD.DISABLE_PULLUPS, ack);
    await setVariable(this.transport, VAR.AGB_READ_METHOD, 0, ack);
    await setVariable(this.transport, VAR.CART_MODE, 2, ack);
    if (ack) {
      await setVariable(this.transport, VAR.AGB_IRQ_ENABLED, 0, ack);
    }
    await setVariable(this.transport, VAR.ADDRESS, 0, ack);

    // Power on + GBA bus bootup last
    await sendCommand(this.transport, CMD.CART_PWR_ON, ack);
    await new Promise((r) => setTimeout(r, 300));
    await sendCommand(this.transport, CMD.AGB_BOOTUP_SEQUENCE, ack);
    this.debug("AGB mode set, cart powered on");
  }

  private async detectAGB(): Promise<CartridgeInfo | null> {
    await this.setModeAGB();

    const ack = this.fw!.expectAck;

    // Read 0x180 bytes (384) from address 0 in 64-byte chunks
    const chunkSize = 64;
    const headerSize = 0x180;
    const chunks = headerSize / chunkSize;
    await setVariable(this.transport, VAR.TRANSFER_SIZE, chunkSize, ack);
    await setVariable(this.transport, VAR.ADDRESS, 0, ack);
    const headerData = new Uint8Array(headerSize);
    for (let i = 0; i < chunks; i++) {
      await this.transport.send(new Uint8Array([CMD.AGB_CART_READ]));
      const chunk = await this.transport.receive(chunkSize, { timeout: 3000 });
      headerData.set(chunk, i * chunkSize);
    }

    const header = parseGBAHeader(headerData);
    if (!header) {
      this.debug("Failed to parse GBA header");
      return null;
    }

    if (!header.headerChecksumValid) {
      this.debug("GBA header checksum invalid");
    }

    this.log(`${header.title} [${header.gameCode}]`);

    const info = gbaHeaderToCartridgeInfo(header);
    info.rawHeader = headerData;

    // Default to 16 MB — user can override in config form.
    info.romSize = 16 * 1024 * 1024;

    return info;
  }

  // GBA ROM size cannot be reliably detected from the cartridge alone —
  // the header has no size field, and open-bus behavior varies by cart.
  // TODO: look up ROM size by game code in a loaded No-Intro DAT file.

  private async readAGBRom(
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    await this.setModeAGB();

    const romSize = config.params.romSizeBytes as number;
    const transferSize = 0x1000; // 4KB per AGB_CART_READ — matches FlashGBX MAX_BUFFER_READ
    const ack = this.fw!.expectAck;

    this.log(`Reading ${romSize / 1024} KB ROM...`);

    const rom = new Uint8Array(romSize);
    let bytesRead = 0;

    // Set transfer size once; firmware auto-increments address after each read
    await setVariable(this.transport, VAR.TRANSFER_SIZE, transferSize, ack);
    await setVariable(this.transport, VAR.ADDRESS, 0, ack);

    while (bytesRead < romSize) {
      if (signal?.aborted) throw new Error("Aborted");

      // For large reads, re-init address periodically to avoid firmware counter overflow
      // and to allow progress updates at natural boundaries
      if (bytesRead > 0 && bytesRead % 0x10000 === 0) {
        await setVariable(this.transport, VAR.TRANSFER_SIZE, transferSize, ack);
        await setVariable(this.transport, VAR.ADDRESS, bytesRead >> 1, ack);
      }

      await this.transport.send(new Uint8Array([CMD.AGB_CART_READ]));
      const chunk = await this.transport.receive(transferSize, {
        timeout: 5000,
      });

      rom.set(chunk, bytesRead);
      bytesRead += transferSize;

      this.emitProgress("rom", bytesRead, romSize);
    }

    this.debug(`GBA ROM read complete: ${bytesRead} bytes`);
    return rom;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

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

  /** Debug-level logging — goes to browser console only, not the UI event log. */
  private debug(message: string): void {
    console.log(`[gbxcart] ${message}`);
  }
}
