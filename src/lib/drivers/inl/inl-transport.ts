/**
 * Adapts the INL Retro Programmer's control-transfer device wrapper
 * (`INLDevice`) to the generic `Transport` interface the connection
 * registry threads through.
 *
 * INL speaks its own dictionary protocol over USB control transfers
 * rather than a bulk byte stream, so `send`/`receive` are intentionally
 * unsupported — the driver talks to the underlying `INLDevice` directly
 * (exposed as `.device`) for its `io`/`nes`/`buffer` opcodes.
 */

import type {
  Transport,
  TransportType,
  TransportEvents,
  DeviceIdentity,
} from "@/lib/types";
import { INLDevice } from "./inl-device";

export class InlTransport implements Transport {
  readonly type: TransportType = "webusb";
  readonly device = new INLDevice();

  get connected(): boolean {
    return this.device.connected;
  }

  /** Prompt the user to pick an INL device, then open it. */
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
      "INL transport speaks a control-transfer dictionary protocol, not raw send()",
    );
  }

  receive(): Promise<Uint8Array> {
    throw new Error(
      "INL transport speaks a control-transfer dictionary protocol, not raw receive()",
    );
  }

  private identity(): DeviceIdentity {
    return { name: this.device.productName, transport: "webusb" };
  }
}
