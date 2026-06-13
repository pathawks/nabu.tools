import type {
  Transport,
  TransportType,
  TransportConnectOptions,
  TransferOptions,
  TransportEvents,
  DeviceIdentity,
} from "@/lib/types";

export class SerialTransport implements Transport {
  readonly type: TransportType = "serial";
  private readonly filters: SerialPortFilter[];
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private events: Partial<TransportEvents> = {};
  private pendingBytes: Uint8Array[] = [];
  private pendingTotal = 0;

  constructor(filters: SerialPortFilter[]) {
    this.filters = filters;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  async connect(options?: TransportConnectOptions): Promise<DeviceIdentity> {
    const port = await navigator.serial!.requestPort({
      filters: this.filters,
    });
    return this.openPort(port, options);
  }

  /** Connect using a previously-authorized port (no user gesture needed). */
  async connectWithPort(port: SerialPort, options?: TransportConnectOptions): Promise<DeviceIdentity> {
    return this.openPort(port, options);
  }

  private async openPort(port: SerialPort, options?: TransportConnectOptions): Promise<DeviceIdentity> {
    const baudRate = options?.baudRate ?? 1_000_000;

    // Port may already be open after Vite HMR (no full page unload)
    if (!port.readable) {
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none" });
    }

    // Set DTR/RTS — CH340 devices often require these signals
    await port.setSignals({ dataTerminalReady: true, requestToSend: true });

    this.port = port;
    this.reader = port.readable!.getReader();
    this.writer = port.writable!.getWriter();
    this.pendingBytes = [];
    this.pendingTotal = 0;

    // Listen for surprise disconnect
    port.addEventListener("disconnect", this.onSerialDisconnect);

    const info = port.getInfo();
    // Web Serial doesn't expose productName; the vendor:product pair is the
    // most identifying string available.
    const name =
      info.usbVendorId !== undefined && info.usbProductId !== undefined
        ? `${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)}`
        : "Serial Device";
    return {
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
      name,
      transport: "serial",
      raw: port,
    };
  }

  async disconnect(): Promise<void> {
    this.port?.removeEventListener("disconnect", this.onSerialDisconnect);
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
      if (this.writer) {
        await this.writer.close();
        this.writer.releaseLock();
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } catch {
      // Port may already be closed on surprise removal
      this.port = null;
      this.reader = null;
      this.writer = null;
    }
    this.pendingBytes = [];
    this.pendingTotal = 0;
  }

  /**
   * Best-effort teardown for page unload (`Transport.closeNow`). Reloading
   * with an open port can hang Chromium's navigation while it waits on the
   * held serial handle, and the awaits inside `disconnect()` may never
   * resume once the document starts dying. So issue reader-cancel and
   * writer-abort synchronously this tick — the calls Chromium needs to
   * start releasing the handle — then queue releaseLock + port.close()
   * behind a microtask, since the locks aren't free until cancel/abort
   * settle. Every rejection is swallowed. The port object dies with the
   * document either way; this just gets the release calls in as early as
   * possible.
   */
  closeNow(): void {
    const { port, reader, writer } = this;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.pendingBytes = [];
    this.pendingTotal = 0;
    if (!port) return;
    port.removeEventListener("disconnect", this.onSerialDisconnect);
    reader?.cancel().catch(() => {});
    writer?.abort().catch(() => {});
    // Locks may still be held for a microtask or two after cancel/abort;
    // queue the close behind them rather than awaiting.
    Promise.resolve().then(() => {
      try {
        reader?.releaseLock();
        writer?.releaseLock();
      } catch {
        /* still locked — close() below is then a no-op rejection */
      }
      port.close().catch(() => {});
    });
  }

  debug = false;

  async send(data: Uint8Array, _options?: TransferOptions): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    if (this.debug) {
      const hex = [...data].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      console.log(`TX(${data.length}): ${hex}`);
    }
    await this.writer.write(data);
  }

  async receive(length: number, options?: TransferOptions): Promise<Uint8Array> {
    if (!this.reader) throw new Error("Not connected");
    const timeout = options?.timeout ?? 2000;
    const deadline = Date.now() + timeout;

    // Drain from pending buffer first
    while (this.pendingTotal < length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Serial read timeout: got ${this.pendingTotal}/${length} bytes`);
      }

      const result = await Promise.race([
        this.reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), remaining),
        ),
      ]);

      if (result.done || !result.value) {
        const got = this.pendingTotal;
        // The timed-out read() is still pending on the reader; reset it so its
        // late chunk can't land in the next receive(), and drop partial bytes.
        this.pendingBytes = [];
        this.pendingTotal = 0;
        await this.resetReader();
        throw new Error(`Serial read timeout: got ${got}/${length} bytes`);
      }

      this.pendingBytes.push(result.value);
      this.pendingTotal += result.value.length;
    }

    // Assemble exactly `length` bytes from pending
    return this.consume(length);
  }

  /** Reopen the port at a different baud rate (for speed upgrade). */
  async changeBaudRate(baudRate: number): Promise<void> {
    if (!this.port) throw new Error("Not connected");
    const port = this.port;

    // Release locks and close
    if (this.reader) {
      await this.reader.cancel();
      this.reader.releaseLock();
    }
    if (this.writer) {
      await this.writer.close();
      this.writer.releaseLock();
    }
    await port.close();

    // Reopen at new baud rate
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none" });
    this.reader = port.readable!.getReader();
    this.writer = port.writable!.getWriter();
    this.pendingBytes = [];
    this.pendingTotal = 0;
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.events[event] = handler;
  }

  /** Drain any stale bytes from the read buffer. */
  async flush(): Promise<void> {
    this.pendingBytes = [];
    this.pendingTotal = 0;
    await this.resetReader();
  }

  /**
   * Cancel the current reader and acquire a fresh one. The cancel settles any
   * read() still pending on the old reader, so its chunk can't surface in a
   * later receive() and shift the byte stream.
   */
  private async resetReader(): Promise<void> {
    if (!this.port || !this.reader) return;
    try {
      await this.reader.cancel();
      this.reader.releaseLock();
    } catch {
      // Ignore — port may already be gone
    }
    this.reader = this.port.readable!.getReader();
  }

  // A single stable reference so the port's disconnect listener can be
  // removed again on disconnect (and self-removed on surprise removal).
  private onSerialDisconnect = (): void => {
    this.port?.removeEventListener("disconnect", this.onSerialDisconnect);
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.events.onDisconnect?.();
  };

  private consume(length: number): Uint8Array {
    if (this.debug) {
      console.log(`RX(${length}) consuming from ${this.pendingTotal} pending bytes`);
    }
    const result = new Uint8Array(length);
    let offset = 0;

    while (offset < length) {
      const chunk = this.pendingBytes[0];
      const needed = length - offset;

      if (chunk.length <= needed) {
        result.set(chunk, offset);
        offset += chunk.length;
        this.pendingBytes.shift();
        this.pendingTotal -= chunk.length;
      } else {
        result.set(chunk.subarray(0, needed), offset);
        this.pendingBytes[0] = chunk.subarray(needed);
        this.pendingTotal -= needed;
        offset += needed;
      }
    }

    return result;
  }
}
