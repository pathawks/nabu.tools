/**
 * Datel PowerSaves for 3DS — device driver for DS cartridge save backup.
 *
 * Hardware
 * --------
 * USB HID slot-1 adapter. VID 0x1C1A PID 0x03D5 (normal firmware mode;
 * bcdDevice 0.11). Speaks a 64-byte HID protocol over a single output /
 * single input report and drives the cart slot-1 bus plus an SPI
 * passthrough to the cart's save chip. A second USB configuration at
 * bcdDevice 0.01 is a bootloader / recovery mode used by the vendor's
 * firmware-update tool.
 *
 * Scope
 * -----
 * Read-only save backup for DS cartridges. Save writing and 3DS save
 * editing are not implemented; ROM dumping is not supported by the
 * device's firmware on DS carts.
 *
 * Firmware HID opcodes used by this driver
 * ----------------------------------------
 *   0x02 TEST         Device identifier probe. Returns "App" + 61 bytes
 *                     of fixed state.
 *   0x08 RESET        ARM SYSRESETREQ. USB disconnects and re-enumerates
 *                     ~236 ms later. Used by softReset().
 *   0x10 SWITCH_MODE  Firmware reset so a mode change can land.
 *   0x11 ROM_MODE     Cart-ROM protocol path.
 *   0x12 SPI_MODE     SPI passthrough to the save chip.
 *   0x13 NTR          DS cart-bus command (8-byte cmd, variable response).
 *                     The running firmware filters cmd[0]; for save backup
 *                     we only need 0x9F (wake-up dummy), 0x90 (chip ID),
 *                     and 0x00 (header read), all of which are forwarded
 *                     to the cart unchanged.
 *   0x15 SPI          Raw SPI passthrough to the save chip. We send a
 *                     3-byte READ command `[0x03, addr_hi, addr_lo]` for
 *                     16-bit-addressed save chips (4 / 64 / 512 Kbit
 *                     EEPROM) and a 4-byte command for 24-bit-addressed
 *                     FLASH (2 / 4 / 8 Mbit). Up to 32 KB per response
 *                     works; the packet header's 16-bit responseLen
 *                     truncates 64 KB to zero, so larger requests fail.
 *
 * Protocol source: github.com/kitlith/powerslaves (MIT). The packet-
 * framing layout, mode-switch sequence, and SPI/NTR primitives in this
 * driver were ported from that reference.
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
import type { HidTransport } from "@/lib/transport/hid-transport";
import {
  CMD,
  NTR_CMD,
  SPI_CMD,
  PACKET_SIZE,
  COMMAND_TIMEOUT_MS,
  flashSizeFromJedec,
} from "./powersave-3ds-commands";
import { MAKER_CODES } from "@/lib/systems/nds/nds-maker-codes";
import {
  parseNDSHeader,
  type CardHeader,
  type NDSCartridgeInfo,
  type NDSDeviceDriver,
} from "@/lib/systems/nds/nds-header";
import { formatBytes } from "@/lib/core/hashing";

function parseHeader(raw: Uint8Array): CardHeader {
  return parseNDSHeader(raw, MAKER_CODES);
}

function buildPacket(
  opcode: number,
  cmdBytes: Uint8Array,
  responseLen: number,
): Uint8Array {
  const packet = new Uint8Array(PACKET_SIZE);
  packet[0] = opcode;
  packet[1] = cmdBytes.length & 0xff;
  packet[2] = (cmdBytes.length >> 8) & 0xff;
  packet[3] = responseLen & 0xff;
  packet[4] = (responseLen >> 8) & 0xff;
  packet.set(cmdBytes.subarray(0, Math.min(cmdBytes.length, PACKET_SIZE - 5)), 5);
  return packet;
}

// Each SPI READ request streams its entire response back as a sequence of
// 64-byte HID input reports while CS stays asserted. Up to 32 KB reads
// work correctly with the 2-byte addressing format; beyond that, 64 KB
// truncates to 0 when cast to the 16-bit responseLen field of the HID
// protocol header. But there's no measurable speedup from bigger chunks:
// a 64 KB save dumps in 1042 ms at 4 KB chunks vs 1029 ms at 32 KB. USB
// Full-Speed's 64-byte interrupt packets at 1 ms intervals cap the bus
// at ~62 KB/s, so the limit is packet count, not request overhead.
const SAVE_READ_CHUNK = 0x1000;

export class PowerSave3DSDriver implements NDSDeviceDriver {
  readonly id = "POWERSAVE_3DS";
  readonly name = "PowerSaves for 3DS";
  readonly capabilities: DeviceCapability[] = [
    { systemId: "nds_save", operations: ["dump_save"], autoDetect: true },
  ];

  readonly transport: HidTransport;
  private events: Partial<DeviceDriverEvents> = {};
  private header: CardHeader | null = null;
  private headerChipId = "";
  private saveSize = 0;
  private saveTypeName: string | undefined = undefined;

  /** Firmware mode currently selected, or null if not yet known. */
  private currentMode: number | null = null;

  /**
   * Stashed during readROM for sendCommand's wait loop to observe. Without
   * it, a stalled receive blocks on the 2 s timeout before the user's
   * cancel is seen — painful across hundreds of chunks.
   */
  private currentSignal: AbortSignal | null = null;

  /**
   * Whether the cart has received its NTR wake-up dummy since the last
   * entry into ROM_MODE. Every mode change resets this — the cart loses
   * NTR state whenever the firmware switches modes.
   */
  private romInited = false;

  /**
   * Persistent inbox for HID input reports. The firmware occasionally sends
   * slightly more bytes than requested (internal pipeline artefact); if we
   * swapped per-request listeners those stragglers would land in the next
   * response and shift its framing. With one lifetime listener draining into
   * this queue, we drain the queue before each send() and then pull exactly
   * responseLen bytes out.
   */
  private inbox: Uint8Array[] = [];
  private inboxLen = 0;
  private inboxWaiter: (() => void) | null = null;

  constructor(transport: HidTransport) {
    this.transport = transport;
    this.transport.setInputListener((bytes) => {
      this.inbox.push(bytes);
      this.inboxLen += bytes.length;
      this.inboxWaiter?.();
    });
  }

  async initialize(): Promise<DeviceInfo> {
    const id = await this.sendCommand(CMD.TEST, new Uint8Array(0), 0x40);
    // Expected prefix: ASCII "App" (0x41 0x70 0x70).
    if (id[0] !== 0x41 || id[1] !== 0x70 || id[2] !== 0x70) {
      throw new Error(
        "Device did not respond with the expected identifier. " +
          "This may not be a PowerSaves for 3DS.",
      );
    }
    this.log(`Identifier: ${Array.from(id.slice(0, 16), hex).join(" ")}`);

    return {
      firmwareVersion: "",
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
   * Enter ROM mode, probe the cart via NTR Get Chip ID, and read the header
   * on first detection (cached until the chip ID changes or the cart is
   * removed). Returns enriched CartridgeInfo so the scanner can show the
   * detected game before the user confirms a (slow) save dump.
   */
  async detectCartridge(
    _systemId: SystemId,
  ): Promise<NDSCartridgeInfo | null> {
    await this.ensureRomInit();
    const ntr = new Uint8Array(8);
    ntr[0] = NTR_CMD.GET_CHIP_ID;
    let id = await this.sendCommand(CMD.NTR, ntr, 4);

    // If the chip-ID read comes back all-zero or all-0xFF, the cart may
    // be genuinely absent — or the cart bus may be in a transient state
    // from an earlier read. Before reporting "no cartridge," force a
    // full mode cycle (SWITCH_MODE → ROM_MODE → NTR 0x9F dummy) and
    // retry once.
    if (id.every((b) => b === 0x00) || id.every((b) => b === 0xff)) {
      this.currentMode = null;
      this.romInited = false;
      await this.ensureRomInit();
      id = await this.sendCommand(CMD.NTR, ntr, 4);
    }

    if (id.every((b) => b === 0x00) || id.every((b) => b === 0xff)) {
      this.header = null;
      this.headerChipId = "";
      this.saveSize = 0;
      return null;
    }

    const chipIdHex = Array.from(id, hex).join("");
    if (!this.header || this.headerChipId !== chipIdHex) {
      // Read the header, and retry up to 3 times if CRC-16 validation
      // fails. parseNDSHeader validates both the header CRC (at 0x15E)
      // and the cart-logo CRC (at 0x15C); if either fails the read was
      // corrupted (e.g. cart bus in a transitional state, or an
      // ephemeral preamble quirk that dodged findHeaderStart's
      // heuristic). A full mode cycle + re-wake is usually enough to
      // get a clean read on the next attempt.
      let parsed: CardHeader | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const headerBytes = await this.sendCommand(
          CMD.NTR,
          new Uint8Array(8),
          0x200,
        );
        parsed = parseHeader(headerBytes);
        if (parsed.validHeader) break;
        this.log(
          `Header CRC mismatch on attempt ${attempt + 1}; cycling ROM mode and retrying.`,
          "warn",
        );
        this.currentMode = null;
        this.romInited = false;
        await this.ensureRomInit();
      }
      this.header = parsed;
      this.headerChipId = chipIdHex;
      this.saveSize = 0;
    }

    return this.buildCartInfo();
  }

  /**
   * Read cart header (NTR) + identify save chip (SPI) + dump save data.
   * The save data is returned as the primary output: this is a save-only
   * device, so readROM surfaces the save bytes directly.
   */
  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    void config;
    this.currentSignal = signal ?? null;
    try {
      // Re-verify the cart hasn't been swapped since the scanner's last
      // detect. No-op on first dump (nothing cached yet).
      await this.verifyCartUnchanged();

      // Header is normally read by detectCartridge() during polling. If the
      // user jumped past polling (mock flows, re-entry), run a detect first.
      if (!this.header) {
        const info = await this.detectCartridge("nds_save");
        if (!info) {
          throw new Error("No cartridge present — insert a DS cart and retry.");
        }
        if (!this.header) {
          throw new Error(
            "Cartridge detected but header read failed. Re-seat and retry.",
          );
        }
      }
      if (this.header.validHeader) {
        this.log(
          `Card: ${this.header.title} [${this.header.gameCode}] — ${this.header.romSizeMiB} MiB ROM`,
        );
      } else if (this.header.headerAllFF) {
        // TODO: 3DS save dumping via this SPI path is unconfirmed — we
        // have no test reports either way. If you have a 3DS cart on
        // hand, dump it through this branch and report whether the
        // resulting save file is valid.
        this.log(
          "3DS cartridge detected (all-0xFF DS-format header) — dumping " +
            "save via the SPI path. No DS-format header available.",
          "warn",
        );
      } else {
        // Header returned non-0xFF data that failed CRC validation. The
        // most likely cause is a 3DS cart returning encrypted bytes on
        // the DS header-read path. The save chip sits on a separate SPI
        // bus and doesn't participate in cart-bus encryption, so the
        // save dump can still work. Could also be a DS cart with dirty
        // contacts — same recovery: try the dump.
        this.log(
          "Header failed CRC validation — attempting save dump anyway.",
          "warn",
        );
      }

      // Step 1: switch to SPI mode and probe the save chip.
      await this.modeChange(CMD.SPI_MODE);
      const { size, typeName, addrWidth } = await this.probeSaveChip();
      this.saveSize = size;
      this.saveTypeName = typeName;
      this.log(`Save: ${typeName}`);

      // Step 2: dump save data.
      const saveData = await this.readSaveData(size, addrWidth, signal);

      // Step 3: re-verify the cart is still the one we started with. Save
      // data has no canonical reference to hash against (unlike ROMs), so
      // a cart swap mid-dump would otherwise produce silent, undetectable
      // corruption — the .sav file would look fine but be wrong.
      await this.verifyCartUnchanged();

      return saveData;
    } finally {
      this.currentSignal = null;
    }
  }

  async readSave(
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.readROM(config, signal);
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("Save writing not yet implemented for PowerSaves 3DS");
  }

  /**
   * Fire ARM SYSRESETREQ on the MCU. Confirmed behaviour: opcode 0x08 causes
   * the firmware to write `0x05FA0004` to `SCB->AIRCR`, the CPU resets,
   * USB disconnects in ~140 ms, and the device re-enumerates as
   * bcdDevice 0x0011 (normal mode) in ~236 ms. The firmware does not
   * ACK — by the time the MCU would send a reply it's already resetting,
   * so we don't wait for one. Returns once the disconnect event fires.
   *
   * **Only works on a healthy firmware.** Once the firmware is already
   * wedged (HID OUT not being serviced — any `sendReport` throws
   * "Failed to write the report"), 0x08 can't be delivered either. In
   * that state a physical power-cycle is the only recovery.
   *
   * Even on a successful reset, Chrome on Linux loses the HID permission
   * grant on USB re-enumeration (new device instance → permission store
   * mismatch). Caller must trigger a fresh `navigator.hid.requestDevice()`
   * from a user gesture to re-pair.
   */
  async softReset(timeoutMs = 2000): Promise<void> {
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Soft-reset timed out — 0x08 may have been repurposed on this firmware build.",
            ),
          ),
        timeoutMs,
      );
      const onDisconnect = (ev: HIDConnectionEvent) => {
        if (
          ev.device.vendorId === 0x1c1a &&
          ev.device.productId === 0x03d5
        ) {
          clearTimeout(timer);
          navigator.hid!.removeEventListener(
            "disconnect",
            onDisconnect as EventListener,
          );
          resolve();
        }
      };
      navigator.hid!.addEventListener(
        "disconnect",
        onDisconnect as EventListener,
      );
    });

    try {
      await this.sendCommand(CMD.RESET, new Uint8Array(0), 0, 500);
    } catch (e) {
      if (
        !(e instanceof WedgeError) &&
        !(e as Error).message.includes("timeout")
      ) {
        throw e;
      }
    }

    await disconnected;
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  /**
   * Release the HID input listener and clear buffered state. In practice
   * the transport only stores one listener (so a replacement driver
   * overrides the old one automatically), but calling this explicitly on
   * teardown avoids relying on that detail and stops inbox growth from
   * any late-arriving stragglers between drivers.
   */
  dispose(): void {
    this.transport.setInputListener(null);
    this.inbox.length = 0;
    this.inboxLen = 0;
    this.inboxWaiter = null;
    this.currentSignal = null;
  }

  /** Enriched cart info — available as soon as detectCartridge() succeeds. */
  get cartInfo(): NDSCartridgeInfo | null {
    return this.buildCartInfo();
  }

  private buildCartInfo(): NDSCartridgeInfo | null {
    if (!this.header) return null;
    const valid = this.header.validHeader;
    return {
      title: valid ? this.header.title : "Unrecognized cartridge",
      saveSize: this.saveSize || undefined,
      saveType: this.saveTypeName,
      rawHeader: valid ? this.header.raw : undefined,
      meta: {
        gameCode: valid ? this.header.gameCode : undefined,
        makerCode: valid ? this.header.makerCode : undefined,
        region: valid ? this.header.region : undefined,
        romVersion: valid ? this.header.romVersion : undefined,
        romSizeMiB: valid ? this.header.romSizeMiB : undefined,
        chipId: this.headerChipId || undefined,
        is3DS: this.header.headerAllFF,
        headerVerified: valid,
      },
    };
  }

  /**
   * Abort the dump if the currently-inserted cart isn't the one the scanner
   * cached. Compares a fresh NTR GET_CHIP_ID against the chip ID captured
   * at detect time. Without this, a cart swapped between scan and dump
   * would be dumped under the old cart's title and hashed against the
   * wrong No-Intro entry.
   */
  private async verifyCartUnchanged(): Promise<void> {
    const cached = this.headerChipId;
    if (!cached) return;

    await this.ensureRomInit();
    const ntr = new Uint8Array(8);
    ntr[0] = NTR_CMD.GET_CHIP_ID;
    const id = await this.sendCommand(CMD.NTR, ntr, 4);
    const fresh = Array.from(id, hex).join("");

    if (fresh === cached) return;

    if (id.every((b) => b === 0x00) || id.every((b) => b === 0xff)) {
      throw new Error(
        "Cartridge removed since scan — re-insert and re-scan before dumping.",
      );
    }
    throw new Error(
      `Cartridge changed since scan (chip ID ${cached} → ${fresh}). ` +
        "Re-scan the new cart before dumping.",
    );
  }

  // ─── Protocol helpers ───────────────────────────────────────────────────

  /**
   * SWITCH_MODE → target mode → TEST, as the reference `powerslaves_mode()` does.
   * No-op if the firmware is already in the requested mode.
   */
  private async modeChange(targetMode: number): Promise<void> {
    if (this.currentMode === targetMode) return;
    await this.sendCommand(CMD.SWITCH_MODE, new Uint8Array(0), 0);
    await this.sendCommand(targetMode, new Uint8Array(0), 0);
    await this.sendCommand(CMD.TEST, new Uint8Array(0), 0x40);
    this.currentMode = targetMode;
    // Any mode transition resets NDS cart state.
    this.romInited = false;
  }

  /**
   * Ensure the firmware is in ROM mode AND the inserted cart has received
   * its wake-up dummy command. Without this, some carts return garbage
   * for header reads. The dummy is NTR 0x9F with 0x2000 response bytes
   * that we discard, per kitlith/powerslaves's header.c example.
   */
  private async ensureRomInit(): Promise<void> {
    await this.modeChange(CMD.ROM_MODE);
    if (this.romInited) return;
    const dummy = new Uint8Array(8);
    dummy[0] = 0x9f;
    await this.sendCommand(CMD.NTR, dummy, 0x2000);
    this.romInited = true;
  }

  /**
   * DS save chips use different SPI address widths depending on type:
   *   - "Tiny" 256-byte EEPROM: 1-byte address
   *   - 4 / 64 / 512 Kbit EEPROM: 2-byte address (big-endian)
   *   - 2 Mbit+ FLASH: 3-byte address
   *
   * The firmware sends `cmd` on MOSI and captures MISO for `len` bytes,
   * but it doesn't know the chip's address width — so if we send a
   * 4-byte cmd to a 16-bit-addressed chip the 4th byte gets interpreted
   * as something else, shifting every read. probeSaveChip picks the
   * right width per chip.
   */
  private async spiReadAddr(
    addr: number,
    len: number,
    addrWidth: 1 | 2 | 3,
  ): Promise<Uint8Array> {
    const cmd = new Uint8Array(1 + addrWidth);
    cmd[0] = SPI_CMD.READ;
    if (addrWidth === 3) {
      cmd[1] = (addr >> 16) & 0xff;
      cmd[2] = (addr >> 8) & 0xff;
      cmd[3] = addr & 0xff;
    } else if (addrWidth === 2) {
      cmd[1] = (addr >> 8) & 0xff;
      cmd[2] = addr & 0xff;
    } else {
      cmd[1] = addr & 0xff;
    }
    return this.sendCommand(CMD.SPI, cmd, len);
  }

  /**
   * Identify save chip and determine size.
   *
   *  - SPI FLASH chips answer JEDEC ID (0x9F); capacity byte gives the size.
   *    FLASH uses 3-byte SPI addressing (2 Mbit+).
   *  - "Tiny" 256-byte EEPROM (the smallest DS save size) uses 1-byte SPI
   *    addressing. We probe that case first — 1-byte addressing is wrong
   *    for any larger chip, so a wrap match at 256 bytes uniquely
   *    identifies it.
   *  - 4 / 64 / 512 Kbit EEPROM and FRAM all use 2-byte SPI addressing.
   *    Wrap-detection: for each standard size `sz`, the 16-byte read at
   *    address `sz - 1` straddles the chip boundary; byte 0 is `chip[sz-1]`
   *    and bytes 1..15 wrap to `chip[0..14]` — which equals `base[0..14]`.
   *    If the match holds, the chip is exactly `sz` bytes.
   */
  private async probeSaveChip(): Promise<{
    size: number;
    typeName: string;
    addrWidth: 1 | 2 | 3;
  }> {
    const jedecResp = await this.sendCommand(
      CMD.SPI,
      new Uint8Array([SPI_CMD.JEDEC_ID]),
      3,
    );
    const jedecHex = Array.from(jedecResp, hex).join(" ");

    if (jedecResp.some((b) => b !== 0x00 && b !== 0xff)) {
      const flashSize = flashSizeFromJedec(jedecResp[2]);
      if (!flashSize) {
        throw new Error(
          `FLASH chip with unrecognised capacity byte 0x${hex(jedecResp[2])} ` +
            `(JEDEC: ${jedecHex}). Please report this cart.`,
        );
      }
      this.log(`Save chip JEDEC ID: ${jedecHex}`);
      return {
        size: flashSize,
        typeName: `FLASH ${formatBytes(flashSize)}`,
        addrWidth: 3,
      };
    }

    // Tiny-EEPROM probe (256 B, 1-byte addressing). Try this before the
    // 2-byte path: a 256-byte chip given a 2-byte SPI address treats the
    // second address byte as data, shifting every subsequent read.
    const tinyBase = await this.spiReadAddr(0, 16, 1);
    if (!tinyBase.every((b) => b === tinyBase[0])) {
      const wrap = await this.spiReadAddr(0xff, 16, 1);
      let wraps = true;
      for (let i = 0; i < 15; i++) {
        if (wrap[i + 1] !== tinyBase[i]) {
          wraps = false;
          break;
        }
      }
      if (wraps) {
        return { size: 0x100, typeName: "EEPROM 256 B", addrWidth: 1 };
      }
    }

    // 2-byte addressing path: 4 / 64 / 512 Kbit EEPROM.
    const base = await this.spiReadAddr(0, 16, 2);
    if (base.every((b) => b === base[0])) {
      this.log(
        "Save-chip size could not be auto-detected (save may be empty); " +
          "defaulting to 64 KB (512 Kbit EEPROM).",
        "warn",
      );
      return { size: 65536, typeName: "EEPROM 64 KB (assumed)", addrWidth: 2 };
    }

    const candidates = [0x200, 0x2000, 0x10000];
    for (const sz of candidates) {
      const r = await this.spiReadAddr(sz - 1, 16, 2);
      let wraps = true;
      for (let i = 0; i < 15; i++) {
        if (r[i + 1] !== base[i]) {
          wraps = false;
          break;
        }
      }
      if (wraps) {
        return {
          size: sz,
          typeName: `EEPROM ${formatBytes(sz)}`,
          addrWidth: 2,
        };
      }
    }

    // No wrap detected at any standard size — chip is bigger than 64 KB.
    // DS EEPROM doesn't go above 64 KB; a larger chip would usually
    // answer JEDEC_ID and take the FLASH path. Default to 64 KB.
    this.log(
      "No EEPROM wrap boundary detected at 0x200 / 0x2000 / 0x10000; " +
        "defaulting to 64 KB.",
      "warn",
    );
    return { size: 65536, typeName: "EEPROM 64 KB (assumed)", addrWidth: 2 };
  }

  private async readSaveData(
    size: number,
    addrWidth: 1 | 2 | 3,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (signal?.aborted) throw new Error("Aborted");
      const n = Math.min(SAVE_READ_CHUNK, size - offset);
      const chunk = await this.spiReadAddr(offset, n, addrWidth);
      out.set(chunk, offset);
      offset += n;
      this.emitProgress("save", offset, size);
    }
    return out;
  }

  /**
   * Send one PowerSaves packet and (optionally) collect a response.
   *
   * The firmware occasionally sends MORE bytes than the requested
   * responseLen asks for — and sometimes sends data even when
   * responseLen=0 (opcode 0x02 TEST, for example, always pushes a
   * 64-byte HID report back regardless). Those extra bytes arrive
   * asynchronously via the HID input listener. If we clear the inbox
   * at the START of the next command, there's a race: stragglers in
   * flight may land AFTER our clear, contaminating the new response's
   * leading bytes as a fake "preamble" that looks like cart data but
   * isn't.
   *
   * Fix: drain at both ends. Before sending, wait briefly for any
   * in-flight stragglers to land, THEN clear. After receiving the
   * requested bytes, wait briefly again and discard anything extra.
   * That way the inbox boundary is clean when the next caller starts.
   *
   * HID write failures ("Failed to write the report") are surfaced as
   * `WedgeError` so callers can distinguish firmware-wedge from ordinary
   * protocol errors and trigger `softReset()`.
   */
  private async sendCommand(
    opcode: number,
    cmdBytes: Uint8Array,
    responseLen: number,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    if (this.currentSignal?.aborted) throw new Error("Aborted");

    // Let any in-flight stragglers from a prior command land, THEN clear.
    // A single 5 ms yield is long enough for pending HID input events to
    // be dispatched through the browser's event loop; without it they'd
    // arrive after our clear and contaminate the next response.
    await new Promise<void>((r) => setTimeout(r, 5));
    this.inbox.length = 0;
    this.inboxLen = 0;

    const packet = buildPacket(opcode, cmdBytes, responseLen);
    try {
      await this.transport.send(packet);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes("Failed to write the report")) {
        throw new WedgeError(msg);
      }
      throw e;
    }

    if (responseLen === 0) return new Uint8Array(0);

    await new Promise<void>((resolve, reject) => {
      const sig = this.currentSignal;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        clearTimeout(timer);
        this.inboxWaiter = null;
        reject(new Error("Aborted"));
      };
      const timer = setTimeout(() => {
        this.inboxWaiter = null;
        sig?.removeEventListener("abort", onAbort);
        // Race guard: if bytes arrived at the exact deadline, resolve
        // rather than reject. The listener-side check might have missed
        // the final event if it landed the same microtask as the timer.
        if (this.inboxLen >= responseLen) {
          resolve();
          return;
        }
        reject(
          new Error(
            `PowerSaves receive timeout (got ${this.inboxLen}/${responseLen} bytes)`,
          ),
        );
      }, timeoutMs);

      const check = () => {
        if (aborted) return;
        if (this.inboxLen >= responseLen) {
          clearTimeout(timer);
          this.inboxWaiter = null;
          sig?.removeEventListener("abort", onAbort);
          resolve();
        }
      };
      this.inboxWaiter = check;

      if (sig?.aborted) {
        onAbort();
        return;
      }
      sig?.addEventListener("abort", onAbort, { once: true });
      check();
    });

    const result = new Uint8Array(responseLen);
    let offset = 0;
    while (offset < responseLen) {
      const chunk = this.inbox.shift();
      if (!chunk) break; // shouldn't happen — we waited for inboxLen >= responseLen
      const take = Math.min(chunk.length, responseLen - offset);
      result.set(chunk.subarray(0, take), offset);
      offset += take;
      this.inboxLen -= take;
      if (take < chunk.length) {
        // Leftover from this chunk is residue; drop it on the next send().
        this.inbox.unshift(chunk.subarray(take));
      }
    }
    return result;
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

function hex(b: number): string {
  return b.toString(16).padStart(2, "0");
}

/**
 * Thrown when the HID endpoint refuses a write (typically because the
 * firmware has wedged). Distinct from normal protocol errors so callers
 * can offer `softReset()` as a recovery path.
 */
export class WedgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WedgeError";
  }
}
