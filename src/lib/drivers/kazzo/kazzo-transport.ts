/**
 * Adapts the Kazzo control-transfer device wrapper (`KazzoDevice`) to the
 * generic `Transport` interface the connection registry threads through.
 *
 * Kazzo speaks its own vendor-request protocol over USB control transfers
 * rather than a bulk byte stream, so `send`/`receive` are intentionally
 * unsupported — the driver talks to the underlying `KazzoDevice` directly
 * (exposed as `.device`) for its read/write requests.
 */

import type {
  Transport,
  TransportType,
  TransportEvents,
  DeviceIdentity,
} from "@/lib/types";
import { KazzoDevice } from "./kazzo-device";

export class KazzoTransport implements Transport {
  readonly type: TransportType = "webusb";
  readonly device = new KazzoDevice();

  get connected(): boolean {
    return this.device.connected;
  }

  /** Prompt the user to pick a Kazzo device, then open it. */
  async connect(): Promise<DeviceIdentity> {
    await this.device.connect();
    return this.identity();
  }

  /** Reopen a previously authorized device (page-load reconnect). */
  async connectWithDevice(usb: USBDevice): Promise<DeviceIdentity> {
    await this.device.connectWithDevice(usb);
    return this.identity();
  }

  disconnect(): Promise<void> {
    return this.device.disconnect();
  }

  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K],
  ): void {
    if (event === "onDisconnect") {
      this.device.onDisconnected(handler as () => void);
    }
  }

  send(): Promise<void> {
    throw new Error(
      "Kazzo transport speaks a control-transfer protocol, not raw send()",
    );
  }

  receive(): Promise<Uint8Array> {
    throw new Error(
      "Kazzo transport speaks a control-transfer protocol, not raw receive()",
    );
  }

  private identity(): DeviceIdentity {
    return { name: this.device.productName, transport: "webusb" };
  }
}
