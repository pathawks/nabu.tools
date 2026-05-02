import { SerialTransport } from "@/lib/transport/serial-transport";
import { HidTransport } from "@/lib/transport/hid-transport";
import { UsbTransport } from "@/lib/transport/usb-transport";
import { GBxCartDriver } from "@/lib/drivers/gbxcart/gbxcart-driver";
import { PowerSaveDriver } from "@/lib/drivers/powersave/powersave-driver";
import { DEVICE_FILTERS as POWERSAVE_FILTERS } from "@/lib/drivers/powersave/powersave-commands";
import { InfinityDriver } from "@/lib/drivers/infinity/infinity-driver";
import { DEVICE_FILTERS as INFINITY_FILTERS } from "@/lib/drivers/infinity/infinity-commands";
import { Ps3McaDriver } from "@/lib/drivers/ps3-mca/ps3-mca-driver";
import { DEVICE_FILTERS as PS3_MCA_FILTERS } from "@/lib/drivers/ps3-mca/ps3-mca-commands";
import type {
  DeviceDriver,
  DeviceIdentity,
  DeviceInfo,
  Transport,
} from "@/lib/types";

export type AuthorizedDevice = SerialPort | USBDevice | HIDDevice;

export interface ConnectionEntry {
  createTransport(): Transport;
  connect(
    transport: Transport,
    ctx: { authorized: AuthorizedDevice | null },
  ): Promise<DeviceIdentity>;
  createDriver(transport: Transport): DeviceDriver;
  /** Pre-initialize log line. Default: "Initializing device..." */
  preInitLog?: string;
  /** Post-initialize log line. Default: `Connected: ${info.deviceName}` */
  postInitLog?: (info: DeviceInfo) => string;
}

export const CONNECTION_ENTRIES: Record<string, ConnectionEntry> = {
  GBXCART: {
    createTransport: () => new SerialTransport(),
    connect: (t, { authorized }) =>
      authorized
        ? (t as SerialTransport).connectWithPort(authorized as SerialPort, {
            baudRate: 1_000_000,
          })
        : (t as SerialTransport).connect({ baudRate: 1_000_000 }),
    createDriver: (t) => new GBxCartDriver(t as SerialTransport),
    postInitLog: (info) =>
      `Connected: ${info.deviceName} (fw: ${info.firmwareVersion}, ${info.hardwareRevision})`,
  },

  POWERSAVE: {
    createTransport: () => new HidTransport(POWERSAVE_FILTERS),
    connect: (t, { authorized }) =>
      authorized
        ? (t as HidTransport).connectWithDevice(authorized as HIDDevice)
        : (t as HidTransport).connect(),
    createDriver: (t) => new PowerSaveDriver(t as HidTransport),
  },

  DISNEY_INFINITY: {
    createTransport: () => new HidTransport(INFINITY_FILTERS),
    connect: (t, { authorized }) =>
      authorized
        ? (t as HidTransport).connectWithDevice(authorized as HIDDevice)
        : (t as HidTransport).connect(),
    createDriver: (t) => new InfinityDriver(t as HidTransport),
    preInitLog: "Activating base...",
    postInitLog: (info) =>
      `Connected: ${info.deviceName} (fw: ${info.firmwareVersion})`,
  },

  PS3_MCA: {
    createTransport: () => new UsbTransport(PS3_MCA_FILTERS),
    connect: (t, { authorized }) =>
      authorized
        ? (t as UsbTransport).connectWithDevice(authorized as USBDevice)
        : (t as UsbTransport).connect(),
    createDriver: (t) => new Ps3McaDriver(t as UsbTransport),
  },
};
