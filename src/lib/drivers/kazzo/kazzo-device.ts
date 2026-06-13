/**
 * Kazzo — WebUSB device wrapper.
 *
 * Low-level protocol primitives over vendor control transfers. The Kazzo
 * firmware has no dictionary layer — each `bRequest` is the opcode, and
 * wValue / wIndex carry operands directly. Reads buffer a page at a time
 * in firmware (256 B per transfer); larger regions are chunked here.
 *
 * Reimplemented from the documented protocol (see kazzo-opcodes.ts); the
 * reference host is anago's reader_kazzo.c.
 */

import {
  KAZZO_DEVICE_FILTER,
  FLASH_WRITE_REQUESTS,
  READ_PACKET_SIZE,
  REQUEST,
  INDEX,
  VERSION_STRING_SIZE,
  WRITE_XOR_MASK,
} from "./kazzo-opcodes";

/** Progress callback fired at 256-byte page boundaries inside a read. */
export type KazzoProgressCb = (bytesRead: number, totalBytes: number) => void;

export class KazzoDevice {
  private device: USBDevice | null = null;
  private onDisconnect?: () => void;
  private _firmwareVersion: string | null = null;

  get connected(): boolean {
    return this.device?.opened ?? false;
  }

  get productName(): string {
    return this.device?.productName ?? "kazzo";
  }

  /** Firmware version string from FIRMWARE_VERSION, or "unknown" until fetched. */
  get firmwareVersion(): string {
    return this._firmwareVersion ?? "unknown";
  }

  /** Prompt user to select device. */
  async connect(): Promise<void> {
    const device = await navigator.usb!.requestDevice({
      filters: [KAZZO_DEVICE_FILTER],
    });
    await this.openDevice(device);
  }

  /** Reconnect to a previously authorized device. */
  async connectWithDevice(device: USBDevice): Promise<void> {
    await this.openDevice(device);
  }

  private async openDevice(device: USBDevice): Promise<void> {
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);
    this.device = device;
    navigator.usb!.addEventListener("disconnect", this.handleDisconnect);
  }

  async disconnect(): Promise<void> {
    navigator.usb!.removeEventListener("disconnect", this.handleDisconnect);
    if (this.device?.opened) {
      try {
        await this.device.releaseInterface(0);
      } catch {
        /* best-effort */
      }
      try {
        await this.device.close();
      } catch {
        /* best-effort */
      }
    }
    this.device = null;
    this._firmwareVersion = null;
  }

  onDisconnected(handler: () => void): void {
    this.onDisconnect = handler;
  }

  private handleDisconnect = (event: USBConnectionEvent) => {
    if (event.device === this.device) {
      this.device = null;
      this.onDisconnect?.();
    }
  };

  // ─── Raw control transfers ──────────────────────────────────────────────

  /**
   * Hardware safety: nabu is a read-only dumper and must never program a
   * cartridge's flash, firmware, or disk. Refuse every write/erase request
   * the firmware exposes (see FLASH_WRITE_REQUESTS) before it goes out.
   */
  private assertReadOnly(request: number): void {
    if (FLASH_WRITE_REQUESTS.has(request)) {
      throw new Error(
        `Refusing Kazzo flash/firmware-write request ${request}: nabu only ` +
          `reads cartridges and never programs them.`,
      );
    }
  }

  /** Issue a vendor IN control transfer and return the response bytes. */
  async controlIn(
    request: number,
    value: number,
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    this.assertReadOnly(request);
    if (!this.device) throw new Error("Device not connected");

    const result = await this.device.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "device",
        request,
        value: value & 0xffff,
        index: index & 0xffff,
      },
      length,
    );

    if (result.status !== "ok") {
      throw new Error(
        `Kazzo control IN failed (request=${request}, status=${result.status})`,
      );
    }

    if (!result.data) return new Uint8Array(0);
    return new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );
  }

  /**
   * Issue a vendor OUT control transfer. The payload is XORed with
   * {@link WRITE_XOR_MASK} before transmission to work around V-USB losing
   * bits on long runs of 0xFF; the firmware un-masks on receive.
   */
  async controlOut(
    request: number,
    value: number,
    index: number,
    data: Uint8Array,
  ): Promise<void> {
    this.assertReadOnly(request);
    if (!this.device) throw new Error("Device not connected");

    const masked = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      masked[i] = data[i] ^ WRITE_XOR_MASK;
    }

    const result = await this.device.controlTransferOut(
      {
        requestType: "vendor",
        recipient: "device",
        request,
        value: value & 0xffff,
        index: index & 0xffff,
      },
      masked,
    );

    if (result.status !== "ok" || result.bytesWritten !== data.length) {
      throw new Error(
        `Kazzo control OUT failed (request=${request}, status=${result.status}, wrote=${result.bytesWritten}/${data.length})`,
      );
    }
  }

  // ─── Chunked bus-access helpers ─────────────────────────────────────────

  /**
   * Read `length` bytes starting at `address` using `request`, looping
   * 256-byte page transfers. Mirrors reader_kazzo.c's `read_main`. Checks
   * the abort signal and reports progress at each page boundary.
   */
  private async readChunked(
    request: number,
    address: number,
    length: number,
    onProgress?: KazzoProgressCb,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;
    let addr = address;

    while (offset < length) {
      signal?.throwIfAborted();
      const n = Math.min(length - offset, READ_PACKET_SIZE);
      const chunk = await this.controlIn(request, addr, INDEX.IMPLIED, n);
      if (chunk.length !== n) {
        throw new Error(
          `Kazzo short read (got ${chunk.length}, expected ${n} at $${addr.toString(16)})`,
        );
      }
      result.set(chunk, offset);
      offset += n;
      addr += n;
      onProgress?.(offset, length);
    }

    return result;
  }

  // ─── Domain methods ─────────────────────────────────────────────────────

  /** Connectivity handshake. Returns `[value_lo, value_hi, index_lo, index_hi]`. */
  async echo(value: number, index: number): Promise<Uint8Array> {
    return this.controlIn(REQUEST.ECHO, value, index, 4);
  }

  /**
   * Drive PHI2 (the CPU clock) before bus access — the firmware needs it
   * initialized to synthesize read/write cycles. Issued once per dump
   * region by the bus adapter's `setup()`.
   */
  async phi2Init(): Promise<void> {
    await this.controlIn(REQUEST.PHI2_INIT, 0, 0, 1);
  }

  /**
   * Read PRG (CPU bus) starting at `address` for `length` bytes. The
   * firmware synthesizes NES bus cycles per byte; mapper banking is the
   * host's responsibility (poke registers via {@link cpuWrite} first).
   */
  async cpuRead(
    address: number,
    length: number,
    onProgress?: KazzoProgressCb,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.readChunked(REQUEST.CPU_READ, address, length, onProgress, signal);
  }

  /** Read CHR (PPU bus) starting at `address` for `length` bytes. */
  async ppuRead(
    address: number,
    length: number,
    onProgress?: KazzoProgressCb,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.readChunked(REQUEST.PPU_READ, address, length, onProgress, signal);
  }

  /**
   * Write every byte of `bytes` to CPU-bus `address` in a single
   * CPU_WRITE_6502 transfer — the firmware runs one 6502 write cycle per byte
   * at the same address. This is how a serially-loaded register (MMC1's shift
   * register) is clocked atomically: all five shifted bytes ride in one USB
   * transfer instead of five. `controlOut` applies the 0xA5 mask to the whole
   * payload.
   */
  async cpuWriteBytes(address: number, bytes: Uint8Array): Promise<void> {
    await this.controlOut(REQUEST.CPU_WRITE_6502, address, INDEX.IMPLIED, bytes);
  }

  /**
   * Write one byte to the CPU bus at `address` via the firmware's
   * 6502-style write cycle. Used to poke mapper registers (banking,
   * UxROM/MMC3 latches, etc.).
   */
  async cpuWrite(address: number, byte: number): Promise<void> {
    await this.cpuWriteBytes(address, new Uint8Array([byte & 0xff]));
  }

  /** Write one byte to the PPU bus at `address`. */
  async ppuWrite(address: number, byte: number): Promise<void> {
    await this.controlOut(
      REQUEST.PPU_WRITE,
      address,
      INDEX.IMPLIED,
      new Uint8Array([byte & 0xff]),
    );
  }

  /**
   * Query and cache the firmware version string. Returns the same value on
   * subsequent calls; safe to call once at init.
   */
  async fetchFirmwareVersion(): Promise<string> {
    if (this._firmwareVersion !== null) return this._firmwareVersion;

    const bytes = await this.controlIn(
      REQUEST.FIRMWARE_VERSION,
      0,
      0,
      VERSION_STRING_SIZE,
    );
    const nul = bytes.indexOf(0);
    const end = nul === -1 ? bytes.length : nul;
    this._firmwareVersion = new TextDecoder("ascii").decode(
      bytes.subarray(0, end),
    );
    return this._firmwareVersion;
  }

  /**
   * Probe nametable mirroring via the firmware's VRAM A10 check. Returns
   * the 4-bit pattern documented at VRAM_CONNECTION.
   */
  async vramConnection(): Promise<number> {
    const bytes = await this.controlIn(REQUEST.VRAM_CONNECTION, 0, 0, 1);
    return bytes[0] & 0x0f;
  }
}
