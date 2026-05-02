/**
 * WebUSB transport for vendor-specific USB devices.
 *
 * Wraps the WebUSB API for devices that expose a vendor-specific interface
 * with bulk endpoints. Supports configurable endpoint numbers and
 * per-transfer endpoint overrides for devices with multiple IN endpoints.
 */

import type {
  Transport,
  TransportEvents,
  TransportConnectOptions,
  TransferOptions,
  DeviceIdentity,
} from "@/lib/types";

interface UsbDeviceFilter {
  vendorId: number;
  productId?: number;
}

export class UsbTransport implements Transport {
  readonly type = "webusb" as const;

  private device: USBDevice | null = null;
  private events: Partial<TransportEvents> = {};
  private endpointIn = 1;
  private endpointOut = 2;
  private readonly filters: UsbDeviceFilter[];

  constructor(
    filters: UsbDeviceFilter[],
    endpointIn?: number,
    endpointOut?: number,
  ) {
    this.filters = filters;
    if (endpointIn !== undefined) this.endpointIn = endpointIn;
    if (endpointOut !== undefined) this.endpointOut = endpointOut;
  }

  get connected(): boolean {
    return this.device?.opened ?? false;
  }

  /** Prompt the user to select a USB device. */
  async connect(_options?: TransportConnectOptions): Promise<DeviceIdentity> {
    if (!navigator.usb) {
      throw new Error(
        "WebUSB is not available. Use Chrome 89+ over HTTPS or localhost.",
      );
    }
    const device = await navigator.usb.requestDevice({
      filters: this.filters,
    });
    return this.openDevice(device);
  }

  /** Reconnect to a previously authorized device (no user gesture needed). */
  async connectWithDevice(device: USBDevice): Promise<DeviceIdentity> {
    return this.openDevice(device);
  }

  private async openDevice(device: USBDevice): Promise<DeviceIdentity> {
    // Device may already be open + claimed after Vite HMR or StrictMode
    // double-mount (no full page unload). Re-claiming throws "Unable to
    // claim interface", so check before each step.
    if (!device.opened) {
      await device.open();
    }
    if (device.configuration?.configurationValue !== 1) {
      await device.selectConfiguration(1);
    }
    if (!device.configuration?.interfaces[0]?.claimed) {
      await device.claimInterface(0);
    }

    this.device = device;

    navigator.usb!.addEventListener("disconnect", this.onDisconnect);

    return {
      vendorId: device.vendorId,
      productId: device.productId,
      name: device.productName ?? "USB Device",
      serial: device.serialNumber,
      transport: "webusb",
      raw: device,
    };
  }

  async disconnect(): Promise<void> {
    navigator.usb!.removeEventListener("disconnect", this.onDisconnect);
    if (this.device?.opened) {
      try {
        await this.device.releaseInterface(0);
      } catch {
        // Best-effort
      }
      try {
        await this.device.close();
      } catch {
        // Best-effort
      }
    }
    this.device = null;
  }

  async send(data: Uint8Array, _options?: TransferOptions): Promise<void> {
    if (!this.device) throw new Error("USB device not connected");
    await this.device.transferOut(
      this.endpointOut,
      data as unknown as BufferSource,
    );
  }

  async receive(
    length: number,
    options?: TransferOptions & { endpointIn?: number },
  ): Promise<Uint8Array> {
    if (!this.device) throw new Error("USB device not connected");

    const ep = options?.endpointIn ?? this.endpointIn;
    const timeout = options?.timeout ?? 5000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.device.transferIn(ep, length),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("USB receive timeout")),
            timeout,
          );
        }),
      ]);

      if (result.data) {
        return new Uint8Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength,
        );
      }
      return new Uint8Array(0);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K],
  ): void {
    this.events[event] = handler;
  }

  private onDisconnect = (event: USBConnectionEvent) => {
    if (event.device === this.device) {
      navigator.usb!.removeEventListener("disconnect", this.onDisconnect);
      this.device = null;
      this.events.onDisconnect?.();
    }
  };
}
