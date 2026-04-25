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

  /**
   * Expose the underlying USBDevice so drivers can run out-of-band probes
   * (e.g. sibling-protocol detection on shared VID/PID) without relying on
   * `navigator.usb.getDevices().find(...)`, which can pick the wrong device
   * when multiple matching units are paired.
   */
  getDevice(): USBDevice | null {
    return this.device;
  }

  /** Prompt the user to select a USB device. */
  async connect(_options?: TransportConnectOptions): Promise<DeviceIdentity> {
    const device = await navigator.usb!.requestDevice({
      filters: this.filters,
    });
    return this.openDevice(device);
  }

  /** Reconnect to a previously authorized device (no user gesture needed). */
  async connectWithDevice(device: USBDevice): Promise<DeviceIdentity> {
    return this.openDevice(device);
  }

  private async openDevice(device: USBDevice): Promise<DeviceIdentity> {
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);

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
    const result = await Promise.race([
      this.device.transferIn(ep, length),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("USB receive timeout")), timeout),
      ),
    ]);

    if (result.data) {
      return new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
    }
    return new Uint8Array(0);
  }

  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K],
  ): void {
    this.events[event] = handler;
  }

  private onDisconnect = (event: USBConnectionEvent) => {
    if (event.device === this.device) {
      this.device = null;
      this.events.onDisconnect?.();
    }
  };
}
