/**
 * Neoflash SMS4 — device driver for Nintendo DS cartridges.
 *
 * Hardware
 * ========
 * Vendor-specific USB device, VID 0xFFAB PID 0xDD03. Board silkscreen
 * "NEO NDS SMS4 V6G". Main MCU is chip-on-board (epoxy blob) so silicon
 * ID is unrecoverable.
 *
 * Scope
 * =====
 * Save preservation only. detectCartridge reads the cart header (NTR
 * cmd 0x00) and probes the save chip (JEDEC RDID via the SMS4
 * firmware's `60 A0` shortcut). readSave drives the save chip via
 * `60 A2` cart-bus passthrough with the family-appropriate SPI cmd
 * table. ROM dumping and save writing are not implemented in this
 * build.
 *
 * Wire-level model
 * ================
 * Session-open handshake (once, at initialize()):
 *
 *   • Control IN  0xC0 / 0xA3 / wValue=0x0001 / wIndex=0 / wLength=0.
 *     Puts the firmware into "ready for cart commands" state — without
 *     it, bulk transfers go through but the firmware never produces
 *     responses.
 *   • Control IN  0xC0 / 0xA2 / 0x0001 / 0 / wLength=8 — 8-byte
 *     liveness probe.
 *   • clearHalt on both bulk pipes (best-effort) to recover from a
 *     prior aborted run that left an endpoint STALLed.
 *
 * Per cart-bus operation:
 *
 *   1. Bulk OUT on EP2 — 32-byte 0x60 0xA5 packet (NTR cmd at bytes
 *      11..18 BE, response length at bytes 6..9 LE).
 *   2. Bulk OUT on EP2 — Zero-Length Packet. The SMS4 firmware waits
 *      for a ZLP to signal "end of transfer" before processing the
 *      command. Without the ZLP the bulk IN hangs indefinitely.
 *   3. Bulk IN  on EP1 — N bytes of cart response (chunked at 64 KB).
 */

import type {
  DeviceCapability,
  DeviceDriverEvents,
  DeviceInfo,
  DetectSystemResult,
  DumpProgress,
  ReadConfig,
  SystemId,
} from "@/lib/types";
import type { UsbTransport } from "@/lib/transport/usb-transport";
import {
  ENDPOINT,
  HEADER_LEN,
  CHIP_ID_LEN,
  NTR_CMD,
  PROBE_JEDEC_OPCODE,
  PROBE_JEDEC_RESPONSE_LEN,
  STATUS_RESPONSE_LEN,
  SUBCMD,
  VENDOR_CTRL,
  PACKET_LEN,
  buildCartPacket,
  buildSaveReadPacket,
  ntrGetChipId,
  ntrReadHeader,
} from "./sms4-commands";
import {
  type ChipIdentification,
  identifyByJedec,
  parseProbeResponse,
} from "./sms4-chip-database";
import { formatBytes } from "@/lib/core/hashing";
import { MAKER_CODES } from "@/lib/systems/nds/nds-maker-codes";
import {
  parseNDSHeader as parseNDSHeaderShared,
  buildNDSCartInfoFromHeader,
  type CardHeader,
  type NDSCartridgeInfo,
  type NDSDeviceDriver,
} from "@/lib/systems/nds/nds-header";

const parseNDSHeader = (raw: Uint8Array): CardHeader =>
  parseNDSHeaderShared(raw, MAKER_CODES);

/** SMS4 firmware needs ~1 s after a cart reset before the cart will respond. */
const RESET_SETTLE_MS = 1000;

/** Number of attempts to read a CRC-valid header before giving up. */
const HEADER_READ_RETRIES = 3;

/**
 * Bytes per `0x60 0xA2` save-read packet. The firmware handles any length
 * the 32-bit field in the packet can describe; chunk size trades USB-
 * roundtrip overhead (each chunk is bulk-OUT packet + ZLP + bulk-IN = 3
 * transfers, each ~1 ms of WebUSB overhead) against progress-bar
 * granularity and the worst-case "save half-read, then USB error" window.
 * 16 KB is 64 SPI-flash pages and 128 M95 EEPROM pages (page size 128 B),
 * still a multiple of every M95 page size (16 / 32 / 64 / 128).
 */
const SAVE_READ_CHUNK = 16 * 1024;

/**
 * NDS chip ID byte-3 bit 0x40 (= bit 30 of the LE u32) flags a DSi-
 * Enhanced cart that needs 0x1000-byte header reads instead of 0x200.
 */
const CHIP_ID_DSI_4K_HEADER_BIT = 0x40;

const hex = (b: number) => b.toString(16).padStart(2, "0");

export class SMS4Driver implements NDSDeviceDriver {
  readonly id = "SMS4";
  readonly name = "Neoflash SMS4";
  readonly capabilities: DeviceCapability[] = [
    { systemId: "nds_save", operations: ["dump_save"], autoDetect: true },
  ];

  readonly transport: UsbTransport;
  private events: Partial<DeviceDriverEvents> = {};

  /** True after a successful cart reset; cleared when the cart goes away. */
  private cartInited = false;
  /** Last chip-ID hex string we saw, to detect cart swap between detects. */
  private cachedChipId = "";
  /** Cached parsed header for the current chip-ID. */
  private cachedHeader: CardHeader | null = null;
  /** Chip identification (exact match, family inference, or unknown). */
  private cachedSaveChip: ChipIdentification | null = null;

  /**
   * Promise of the currently-in-flight detectCartridge() call, or null
   * if no detect is in progress. Used to dedupe concurrent calls — React
   * Strict Mode double-mounts in dev cause two scanner effects to start
   * detects in parallel; without dedupe the two calls' USB transfers
   * interleave on the same pipes and confuse the cart. Both callers
   * get the same promise and the driver does the work once.
   */
  private inFlightDetect: Promise<NDSCartridgeInfo | null> | null = null;

  constructor(transport: UsbTransport) {
    this.transport = transport;
  }

  async initialize(): Promise<DeviceInfo> {
    // Clear any halt left on EP1 IN / EP2 OUT from a previous failed run
    // — the bulk pipes can be STALLed if the host gave up mid-transfer
    // and the device didn't auto-recover.
    await this.tryClearHalt();

    // Vendor control IN 0xA3 puts the firmware into "ready" state.
    // Without it the device accepts our bulk-OUTs but never produces
    // responses — every bulk IN hangs until the host gives up.
    await this.openSession();
    this.log("Session opened (vendor request 0xA3).");

    // Liveness probe: 8-byte status response. If the device doesn't
    // reply here, there's no point trying any cart op. Status bytes
    // don't carry a firmware-version field — log them as diagnostic,
    // not as a version.
    const status = await this.queryStatus();
    this.log(`Status: ${Array.from(status, hex).join(" ")}`);

    // The real device-version marker is the USB descriptor's bcdDevice.
    // The original Neoflash host software branches behaviour on the
    // threshold `bcdDevice >= 0x1008`, dubbing the two eras "SP2" and
    // "pre-SP2". We surface that classification as the firmwareVersion.
    const bcd = this.transport.getBcdDevice();
    const firmwareVersion =
      bcd === null ? "" : bcd >= 0x1008 ? "SP2" : "pre-SP2";

    return {
      firmwareVersion,
      deviceName: this.name,
      capabilities: this.capabilities,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    const info = await this.detectCartridge("nds_save");
    if (!info) return null;
    return { systemId: "nds_save", cartInfo: info };
  }

  async detectCartridge(systemId: SystemId): Promise<NDSCartridgeInfo | null> {
    // Concurrent-call dedupe: if a detect is already running, both
    // callers share the same promise. The driver does the work once.
    if (this.inFlightDetect) return this.inFlightDetect;

    const promise = (async () => {
      try {
        return await this.detectCartridgeInner();
      } catch (err) {
        // Any USB-level failure (timeout, stall, transferOut error)
        // probably left the cart-bus state machine wedged. Force a full
        // reset on the next attempt so it re-issues 0xF0 + wake-up
        // dummy.
        this.cartInited = false;
        this.cachedHeader = null;
        this.cachedChipId = "";
        // Best-effort cart reset so the next attempt isn't fighting a
        // half-initialized cart.
        try {
          await this.resetCart();
        } catch {
          /* a wedged USB stack will rethrow; the outer catch already
             surfaced the original error. */
        }
        throw err;
      }
    })();

    this.inFlightDetect = promise.finally(() => {
      this.inFlightDetect = null;
    });
    // detectCartridge is allowed to use systemId in the future; reference
    // it now so the linter doesn't strip the param.
    void systemId;
    return promise;
  }

  private async detectCartridgeInner(): Promise<NDSCartridgeInfo | null> {
    // First detect (or after a "no cart" result) — full reset cycle so
    // the cart-bus state machine wakes cleanly.
    if (!this.cartInited) {
      await this.resetCart();
      this.log("Reset done; waking cart with NTR 0x9F dummy...");
      // NTR 0x9F is the canonical NDS wake-up dummy. Real retail carts
      // are documented to need a 0x9F before responding to 0x90.
      await this.sendNtr(NTR_CMD.DUMMY, 0);
      this.log("Dummy done; reading chip ID (NTR 0x90)...");
      this.cartInited = true;
    }

    const chipId = await this.readChipId();
    const chipIdHex = Array.from(chipId, hex).join(" ");
    this.log(`Chip ID: ${chipIdHex || "(empty)"}`);

    if (isNoCart(chipId)) {
      const why =
        chipId.length === 0
          ? "Chip ID response was empty — device firmware did not return any data."
          : chipId.every((b) => b === 0xff)
            ? "Chip ID is all 0xFF — no cart inserted, or cart not making contact."
            : "Chip ID is all zero — device returned empty response.";
      this.log(why);
      this.cachedHeader = null;
      this.cachedChipId = "";
      // Force a full reset on the next attempt — if the cart was
      // hot-swapped, the new cart needs its own wake-up cycle.
      this.cartInited = false;
      return null;
    }

    const isDsiEnhanced = (chipId[3] & CHIP_ID_DSI_4K_HEADER_BIT) !== 0;
    const headerReadLen = isDsiEnhanced ? 0x1000 : 0x200;
    if (isDsiEnhanced) {
      this.log(
        `Chip ID byte 3 bit 0x40 is set — DSi-Enhanced cart, ` +
          `using ${headerReadLen}-byte header read.`,
      );
    }

    if (chipIdHex !== this.cachedChipId) {
      this.cachedHeader = null;
      this.cachedChipId = chipIdHex;
    }

    if (!this.cachedHeader) {
      this.cachedHeader = await this.readAndValidateHeader(headerReadLen);
      // Probe save chip JEDEC after header read. Best-effort: if the probe
      // fails or returns an unrecognized response, we still report the
      // cart info — readSave will throw rather than dump garbage if the
      // chip stayed unknown.
      try {
        const probe = await this.probeJedec();
        const parsed = parseProbeResponse(probe);
        const chip = identifyByJedec(parsed.jedec, parsed.familyCode);
        this.cachedSaveChip = chip;
        const jedecStr = parsed.jedec.map(hex).join(" ").toUpperCase();
        const familyHex = hex(parsed.familyCode);
        if (chip.source === "exact") {
          this.log(
            `Save chip: ${chip.name} (${formatBytes(chip.sizeBytes)}) — ` +
              `JEDEC ${jedecStr}, family 0x${familyHex} [exact match]`,
          );
        } else if (chip.source === "family") {
          this.log(
            `Save chip: ${chip.name} — JEDEC ${jedecStr}, family 0x${familyHex} ` +
              `[inferred from manufacturer + device-type bits; cmd table assumed]`,
          );
        } else if (chip.source === "eeprom-family") {
          // Run wrap-probe to pin down the exact size. Read-only —
          // can't corrupt the chip.
          this.log(
            `Save chip: ${chip.name} — JEDEC ${jedecStr} (M95 family; ` +
              `no JEDEC RDID), family 0x${familyHex}. ` +
              `Running wrap-probe to determine exact size...`,
          );
          const probed = await this.wrapProbeEepromSize(
            chip.cmdTable,
            chip.flag,
          );
          if (probed !== null) {
            this.cachedSaveChip = {
              ...chip,
              source: "wrap-probed",
              sizeBytes: probed,
              name: "M95 EEPROM",
            };
            this.log(
              `Wrap-probe: chip is ${formatBytes(probed)} — confirmed by ` +
                `address aliasing at 0x${(probed - 1).toString(16)}.`,
            );
          } else {
            this.log(
              `Wrap-probe didn't detect aliasing at any standard NDS ` +
                `EEPROM size (512 B / 8 KB / 64 KB). Chip is larger or ` +
                `non-standard — this cart isn't currently dumpable with ` +
                `the SMS4.`,
              "warn",
            );
          }
        } else {
          this.log(
            `Save-chip JEDEC probe: ${jedecStr}, family 0x${familyHex} — ` +
              `chip not recognized by any family template; this cart ` +
              `isn't currently dumpable with the SMS4.`,
            "warn",
          );
        }
        if (!parsed.jedecConsistent) {
          this.log(
            "Save-chip probe: firmware's two JEDEC reads disagreed " +
              "(bytes 0..2 != bytes 5..7) — chip contact may be marginal.",
            "warn",
          );
        }
      } catch (e) {
        this.log(
          `Save-chip JEDEC probe failed: ${(e as Error).message}`,
          "warn",
        );
        this.cachedSaveChip = null;
      }
      if (this.cachedHeader.validHeader) {
        this.log(
          `Card: ${this.cachedHeader.title} ` +
            `[${this.cachedHeader.gameCode}] — ` +
            `${this.cachedHeader.romSizeMiB} MiB ROM ` +
            `(chip ID ${chipIdHex})`,
        );
      } else if (this.cachedHeader.headerAllFF) {
        this.log(
          "Header was all 0xFF — likely a 3DS cart (slot-1 format mismatch) " +
            "or an NDS cart with dirty contacts.",
          "warn",
        );
      } else {
        this.log(
          `Header CRC validation failed after ${HEADER_READ_RETRIES} attempts ` +
            `(chip ID ${chipIdHex}). The cart is detected but its header was ` +
            "not read cleanly.",
          "warn",
        );
      }
    }

    return this.buildCartInfo();
  }

  get cartInfo(): NDSCartridgeInfo | null {
    if (!this.cachedHeader) return null;
    return this.buildCartInfo();
  }

  async readROM(): Promise<Uint8Array> {
    throw new Error(
      "SMS4: ROM dump is not implemented in this build (save preservation only).",
    );
  }

  /**
   * Dump the cart's save chip. Iterates `0x60 0xA2` save-read packets in
   * SAVE_READ_CHUNK chunks until the configured size is read, emitting
   * `onProgress` after each chunk for the scanner UI.
   *
   * Reads ride on the chip's cmd table (READ DATA opcode at byte 1, 0x03
   * for every supported family). The SMS4 firmware drives the chip's SPI
   * lines accordingly and returns the page on bulk-IN; no chip-side state
   * machine is touched, so this is non-destructive.
   *
   * `config.params.saveSizeBytes` (if supplied by the caller) overrides
   * the size auto-detected during `detectCartridge`; otherwise we fall
   * back to `cachedSaveChip.sizeBytes`. If neither path yields a usable
   * size or cmd table, throw before issuing any USB transfers — better
   * than reading 64 KB of 0xFF and writing it to disk.
   */
  async readSave(
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const overrideSize = config?.params?.saveSizeBytes as number | undefined;

    const cmdTable = this.cachedSaveChip?.cmdTable;
    const flag = this.cachedSaveChip?.flag;
    const sizeBytes =
      overrideSize ??
      (this.cachedSaveChip && this.cachedSaveChip.sizeBytes > 0
        ? this.cachedSaveChip.sizeBytes
        : 0);

    if (!cmdTable || cmdTable.length !== 14 || !flag) {
      throw new Error(
        "Cannot read save: no save-chip identified. Auto-detect didn't " +
          "find a recognized chip — this cart isn't currently dumpable " +
          "with the SMS4.",
      );
    }
    if (sizeBytes <= 0) {
      throw new Error(
        "Cannot read save: save-chip size is unknown. Auto-detect couldn't " +
          "determine the size — this cart isn't currently dumpable with " +
          "the SMS4.",
      );
    }

    this.log(
      `Reading ${formatBytes(sizeBytes)} save in ${SAVE_READ_CHUNK}-byte chunks...`,
    );

    const result = new Uint8Array(sizeBytes);
    let offset = 0;
    while (offset < sizeBytes) {
      if (signal?.aborted) throw new Error("Aborted");
      const n = Math.min(SAVE_READ_CHUNK, sizeBytes - offset);
      const chunk = await this.readSavePage(offset, n, cmdTable, flag);
      if (chunk.length < n) {
        throw new Error(
          `Short read at offset 0x${offset.toString(16)}: expected ${n} bytes, ` +
            `got ${chunk.length}. Save dump aborted to avoid silent zero-fill.`,
        );
      }
      result.set(chunk.subarray(0, n), offset);
      offset += n;
      this.emitProgress("save", offset, sizeBytes);
    }

    this.log(`Save read complete: ${offset} bytes.`);
    return result;
  }

  async writeSave(): Promise<void> {
    throw new Error("SMS4: save write is not implemented (read-only build).");
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  // ─── Cart operations ───────────────────────────────────────────────────

  private async resetCart(): Promise<void> {
    this.log("Resetting cart...");
    const pkt = buildCartPacket({
      ntrCmd: new Uint8Array(8),
      responseLen: 0,
      subcmd: SUBCMD.RESET,
    });
    await this.bulkWrite(pkt);
    await sleep(RESET_SETTLE_MS);
  }

  private async readChipId(): Promise<Uint8Array> {
    return this.sendNtr(NTR_CMD.GET_CHIP_ID, CHIP_ID_LEN);
  }

  /**
   * Read `length` bytes from the cart's save chip starting at `address`.
   * Sends a `0x60 0xA2` save-read packet using the supplied chip cmd
   * table; the SMS4 firmware drives the chip's SPI lines accordingly
   * and returns the response on bulk IN.
   */
  private async readSavePage(
    address: number,
    length: number,
    cmdTable: readonly number[],
    flag: 0x07 | 0x0f,
  ): Promise<Uint8Array> {
    const pkt = buildSaveReadPacket({ cmdTable, flag, address, length });
    await this.bulkWrite(pkt);
    return this.bulkRead(length);
  }

  /**
   * Wrap-probe to determine the exact size of an M95-family EEPROM.
   *
   * Mechanism: M95 chips have an SPI address bus only as wide as their
   * actual capacity. Reading at offset `sz - 1` on a chip of exactly
   * `sz` bytes returns chip[sz-1] then bytes that wrap to chip[0..],
   * because higher address bits are ignored. We read 16 bytes at 0 as
   * a "base", then 16 bytes at each candidate `sz - 1` and check
   * whether bytes 1..15 match base[0..14]. The match identifies the
   * exact chip size with high confidence (false-positive odds: 1 in
   * 2^120 if save data is random; even less for sparse 0xFF saves).
   *
   * Pure reads — never writes. Cannot corrupt the chip.
   *
   * Returns the detected size in bytes, or null if no aliasing matched.
   */
  private async wrapProbeEepromSize(
    cmdTable: readonly number[],
    flag: 0x07 | 0x0f,
  ): Promise<number | null> {
    const base = await this.readSavePage(0, 16, cmdTable, flag);
    if (base.length < 16) {
      this.log(
        `Wrap-probe: read at 0 returned only ${base.length} bytes; aborting.`,
        "warn",
      );
      return null;
    }
    // Standard NDS EEPROM sizes: 4 Kbit (512 B), 64 Kbit (8 KB),
    // 512 Kbit (64 KB).
    const candidates = [0x200, 0x2000, 0x10000];
    for (const sz of candidates) {
      const r = await this.readSavePage(sz - 1, 16, cmdTable, flag);
      if (r.length < 16) continue;
      let wraps = true;
      for (let i = 0; i < 15; i++) {
        if (r[i + 1] !== base[i]) {
          wraps = false;
          break;
        }
      }
      if (wraps) return sz;
    }
    return null;
  }

  /**
   * Probe the cart's save chip via the SMS4 firmware's JEDEC RDID
   * shortcut: send a 32-byte packet with opcode `0x60 0xA0` and
   * response length 9, the firmware drives SPI to the save chip's
   * 0x9F (RDID) lines and returns 9 bytes: family code + 3-byte JEDEC
   * ID + flag bit + padding.
   */
  private async probeJedec(): Promise<Uint8Array> {
    const pkt = new Uint8Array(PACKET_LEN);
    pkt[0] = PROBE_JEDEC_OPCODE[0];
    pkt[1] = PROBE_JEDEC_OPCODE[1];
    pkt[6] = PROBE_JEDEC_RESPONSE_LEN & 0xff;
    pkt[7] = (PROBE_JEDEC_RESPONSE_LEN >> 8) & 0xff;
    pkt[8] = (PROBE_JEDEC_RESPONSE_LEN >> 16) & 0xff;
    pkt[9] = (PROBE_JEDEC_RESPONSE_LEN >> 24) & 0xff;
    await this.bulkWrite(pkt);
    return this.bulkRead(PROBE_JEDEC_RESPONSE_LEN);
  }

  /**
   * Read the NDS header. Retries up to HEADER_READ_RETRIES on CRC
   * mismatch — the cart bus can be in a transient state right after
   * the reset+chip-ID sequence; a couple of repeats usually settles
   * it. parseNDSHeader does both the header-CRC at 0x15E and the
   * Nintendo-logo-CRC at 0x15C, so a corrupt read fails validation
   * even if the bytes look plausible.
   *
   * `readLen` is per-cart-class: 0x200 for plain NDS, 0x1000 for DSi
   * carts (the cart firmware buffers the larger response and stalls if
   * we under-request).
   */
  private async readAndValidateHeader(readLen: number): Promise<CardHeader> {
    let parsed: CardHeader = parseNDSHeader(new Uint8Array(HEADER_LEN));
    for (let attempt = 0; attempt < HEADER_READ_RETRIES; attempt++) {
      const bytes = await this.sendNtr(NTR_CMD.READ_HEADER, readLen);
      parsed = parseNDSHeader(bytes);
      if (parsed.validHeader || parsed.headerAllFF) return parsed;
      this.log(
        `Header CRC mismatch on attempt ${attempt + 1}; retrying.`,
        "warn",
      );
    }
    return parsed;
  }

  /**
   * Issue an NDS NTR command (opcode + 7 zero bytes) and read back the
   * cart's response. The response length is encoded into the cart-bus
   * packet so the device firmware knows how many bytes to bulk back.
   */
  private async sendNtr(opcode: number, responseLen: number): Promise<Uint8Array> {
    const ntr =
      opcode === NTR_CMD.GET_CHIP_ID
        ? ntrGetChipId()
        : opcode === NTR_CMD.READ_HEADER
          ? ntrReadHeader()
          : (() => {
              const c = new Uint8Array(8);
              c[0] = opcode;
              return c;
            })();
    const pkt = buildCartPacket({ ntrCmd: ntr, responseLen });
    await this.bulkWrite(pkt);
    if (responseLen === 0) return new Uint8Array(0);
    return this.bulkRead(responseLen);
  }

  // ─── Low-level transport ────────────────────────────────────────────────

  /**
   * Issue the SMS4's "open session" vendor control transfer (0xA3).
   * No data stage — the device just acknowledges. Marks the firmware
   * as ready to accept and respond to cart commands.
   */
  private async openSession(): Promise<void> {
    await this.transport.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "device",
        request: VENDOR_CTRL.OPEN_SESSION,
        value: 0x0001,
        index: 0x0000,
      },
      0,
    );
  }

  /**
   * 8-byte status read via vendor IN control transfer. Used as a device-
   * liveness probe at init.
   */
  private async queryStatus(): Promise<Uint8Array> {
    const data = await this.transport.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "device",
        request: VENDOR_CTRL.QUERY_STATUS,
        value: 0x01,
        index: 0x00,
      },
      STATUS_RESPONSE_LEN,
    );
    if (data.byteLength < STATUS_RESPONSE_LEN) {
      throw new Error(
        `Device did not respond to QueryStatus ` +
          `(got ${data.byteLength} bytes, expected ${STATUS_RESPONSE_LEN}). ` +
          "Check that this is a Neoflash SMS4 (VID 0xFFAB PID 0xDD03), not " +
          "a different device on the same VID/PID.",
      );
    }
    return data;
  }

  /** Best-effort halt clear on both bulk endpoints — see initialize(). */
  private async tryClearHalt(): Promise<void> {
    try {
      await this.transport.clearHalt("in", ENDPOINT.IN);
    } catch {
      /* endpoint not halted, ignore */
    }
    try {
      await this.transport.clearHalt("out", ENDPOINT.OUT);
    } catch {
      /* endpoint not halted, ignore */
    }
  }

  /**
   * Bulk OUT + Zero-Length Packet. The SMS4 firmware uses USB
   * end-of-transfer semantics: after the 32-byte cart packet, it waits
   * for an empty bulk OUT to know the transfer is complete before it
   * processes the command. Without the ZLP, bulk IN hangs indefinitely
   * while the firmware waits for more OUT data that never arrives.
   * This is the single most important non-obvious piece of the wire
   * protocol.
   */
  private async bulkWrite(data: Uint8Array): Promise<void> {
    if (data.length === 0) return;
    await this.transport.send(data);
    await this.transport.send(new Uint8Array(0));
  }

  /** Raw bulk IN. */
  private async bulkRead(length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    return this.transport.receive(length);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private buildCartInfo(): NDSCartridgeInfo {
    const jedecHex = this.cachedSaveChip
      ? this.cachedSaveChip.jedec.map(hex).join(" ")
      : undefined;
    const sizeBytes =
      this.cachedSaveChip && this.cachedSaveChip.sizeBytes > 0
        ? this.cachedSaveChip.sizeBytes
        : undefined;
    return buildNDSCartInfoFromHeader({
      header: this.cachedHeader,
      chipIdHex: this.cachedChipId,
      saveSize: sizeBytes,
      // Save Type cell shows just the kind (EEPROM / FLASH). The detailed
      // chip name + JEDEC + source live in the event log via this.log(...)
      // calls during detect.
      saveType: this.cachedSaveChip?.kind,
      saveJedec: jedecHex,
      saveChipName: this.cachedSaveChip?.name,
      saveChipSource: this.cachedSaveChip?.source,
    });
  }

  private log(
    message: string,
    level: "info" | "warn" | "error" = "info",
  ): void {
    this.events.onLog?.(message, level);
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
      fraction: totalBytes === 0 ? 0 : bytesRead / totalBytes,
    });
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const isNoCart = (id: Uint8Array): boolean =>
  id.length === 0 ||
  id.every((b) => b === 0x00) ||
  id.every((b) => b === 0xff);
