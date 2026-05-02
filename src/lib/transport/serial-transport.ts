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
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private events: Partial<TransportEvents> = {};
  private pendingBytes: Uint8Array[] = [];
  private pendingTotal = 0;

  get connected(): boolean {
    return this.port !== null;
  }

  async connect(options?: TransportConnectOptions): Promise<DeviceIdentity> {
    const port = await navigator.serial!.requestPort({
      filters: [{ usbVendorId: 0x1a86, usbProductId: 0x7523 }],
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
    port.addEventListener("disconnect", () => {
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.events.onDisconnect?.();
    });

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
        throw new Error(`Serial read timeout: got ${this.pendingTotal}/${length} bytes`);
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
    // Cancel the current reader and get a fresh one to drain the serial buffer
    if (!this.port || !this.reader) return;
    try {
      await this.reader.cancel();
      this.reader.releaseLock();
    } catch {
      // Ignore
    }
    this.reader = this.port.readable!.getReader();
  }

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
