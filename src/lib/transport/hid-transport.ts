import type {
  Transport,
  TransportType,
  TransportConnectOptions,
  TransferOptions,
  TransportEvents,
  DeviceIdentity,
} from "@/lib/types";

const DEFAULT_REPORT_ID = 0x00;

export class HidTransport implements Transport {
  readonly type: TransportType = "webhid";
  private device: HIDDevice | null = null;
  private events: Partial<TransportEvents> = {};
  private responseResolve: ((data: Uint8Array) => void) | null = null;
  private inputListener:
    | ((data: Uint8Array, reportId: number) => void)
    | null = null;
  private readonly filters: HIDDeviceFilter[];

  constructor(filters: HIDDeviceFilter[]) {
    this.filters = filters;
  }

  /** Register a listener for every input report, including unsolicited ones. */
  setInputListener(
    listener: ((data: Uint8Array, reportId: number) => void) | null,
  ): void {
    this.inputListener = listener;
  }

  get connected(): boolean {
    return this.device !== null && this.device.opened;
  }

  async connect(_options?: TransportConnectOptions): Promise<DeviceIdentity> {
    if (!navigator.hid) {
      throw new Error(
        "WebHID is not available. Use Chrome 89+ over HTTPS or localhost.",
      );
    }

    const devices = await navigator.hid.requestDevice({
      filters: this.filters,
    });
    if (devices.length === 0) throw new Error("No device selected.");

    return this.openDevice(devices[0]);
  }

  /** Connect using a previously-authorized device (no user gesture needed). */
  async connectWithDevice(device: HIDDevice): Promise<DeviceIdentity> {
    return this.openDevice(device);
  }

  private async openDevice(device: HIDDevice): Promise<DeviceIdentity> {
    if (!device.opened) {
      await device.open();
    }

    this.device = device;
    device.addEventListener("inputreport", this.onInputReport);

    navigator.hid!.addEventListener("disconnect", ((e: HIDConnectionEvent) => {
      if (e.device === this.device) {
        this.device = null;
        this.events.onDisconnect?.();
      }
    }) as EventListener);

    return {
      vendorId: device.vendorId,
      productId: device.productId,
      name: device.productName || "HID Device",
      transport: "webhid",
      raw: device,
    };
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      try {
        await this.device.close();
      } catch {
        // Device may already be closed on surprise removal
      }
      this.device = null;
    }
    this.responseResolve = null;
    this.inputListener = null;
  }

  async send(data: Uint8Array, _options?: TransferOptions): Promise<void> {
    return this.sendReport(DEFAULT_REPORT_ID, data);
  }

  /**
   * Send an HID output report with an explicit report ID. Drivers that talk
   * to devices using non-zero report IDs (e.g. Switch Pro Controller) should
   * use this; `send()` defaults to report ID 0.
   */
  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    if (!this.device) throw new Error("Not connected");
    await this.device.sendReport(reportId, data as unknown as BufferSource);
  }

  async receive(
    _length: number,
    options?: TransferOptions,
  ): Promise<Uint8Array> {
    if (!this.device) throw new Error("Not connected");
    const timeout = options?.timeout ?? 2000;

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseResolve = null;
        reject(new Error("HID receive timeout"));
      }, timeout);

      this.responseResolve = (data) => {
        clearTimeout(timer);
        resolve(data);
      };
    });
  }

  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K],
  ): void {
    this.events[event] = handler;
  }

  private onInputReport = (event: Event): void => {
    const { data, reportId } = event as unknown as HIDInputReportEvent;
    const bytes = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    this.inputListener?.(bytes, reportId);
    if (this.responseResolve) {
      const resolve = this.responseResolve;
      this.responseResolve = null;
      resolve(bytes);
    }
  };
}
