import { SerialTransport } from "@/lib/transport/serial-transport";
import { HidTransport } from "@/lib/transport/hid-transport";
import { UsbTransport } from "@/lib/transport/usb-transport";
import { GBxCartDriver } from "@/lib/drivers/gbxcart/gbxcart-driver";
import { DEVICE_FILTERS as GBXCART_FILTERS } from "@/lib/drivers/gbxcart/gbxcart-commands";
import { ClusterMDriver } from "@/lib/drivers/clusterm/clusterm-driver";
import {
  DEVICE_FILTERS as CLUSTERM_FILTERS,
  BAUD_RATE as CLUSTERM_BAUD,
} from "@/lib/drivers/clusterm/clusterm-commands";
import { PowerSaveDriver } from "@/lib/drivers/powersave/powersave-driver";
import { DEVICE_FILTERS as POWERSAVE_FILTERS } from "@/lib/drivers/powersave/powersave-commands";
import { PowerSave3DSDriver } from "@/lib/drivers/powersave-3ds/powersave-3ds-driver";
import { DEVICE_FILTERS as POWERSAVE_3DS_FILTERS } from "@/lib/drivers/powersave-3ds/powersave-3ds-commands";
import { InfinityDriver } from "@/lib/drivers/infinity/infinity-driver";
import { DEVICE_FILTERS as INFINITY_FILTERS } from "@/lib/drivers/infinity/infinity-commands";
import { Ps3McaDriver } from "@/lib/drivers/ps3-mca/ps3-mca-driver";
import { DEVICE_FILTERS as PS3_MCA_FILTERS } from "@/lib/drivers/ps3-mca/ps3-mca-commands";
import { SMS4Driver } from "@/lib/drivers/sms4/sms4-driver";
import { DEVICE_FILTERS as SMS4_FILTERS } from "@/lib/drivers/sms4/sms4-commands";
import { InlTransport } from "@/lib/drivers/inl/inl-transport";
import { INLDriver } from "@/lib/drivers/inl/inl-driver";
import { KazzoTransport } from "@/lib/drivers/kazzo/kazzo-transport";
import { KazzoDriver } from "@/lib/drivers/kazzo/kazzo-driver";
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
    createTransport: () => new SerialTransport(GBXCART_FILTERS),
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

  CLUSTERM: {
    createTransport: () => new SerialTransport(CLUSTERM_FILTERS),
    connect: (t, { authorized }) =>
      authorized
        ? (t as SerialTransport).connectWithPort(authorized as SerialPort, {
            baudRate: CLUSTERM_BAUD,
          })
        : (t as SerialTransport).connect({ baudRate: CLUSTERM_BAUD }),
    createDriver: (t) => new ClusterMDriver(t as SerialTransport),
    postInitLog: (info) =>
      `Connected: ${info.deviceName} (fw: ${info.firmwareVersion}, hw rev ${info.hardwareRevision})`,
  },

  INL_RETRO: {
    createTransport: () => new InlTransport(),
    connect: (t, { authorized }) =>
      authorized
        ? (t as InlTransport).connectWithDevice(authorized as USBDevice)
        : (t as InlTransport).connect(),
    createDriver: (t) => new INLDriver(t as InlTransport),
    postInitLog: (info) =>
      `Connected: ${info.deviceName} (fw: ${info.firmwareVersion})`,
  },

  KAZZO: {
    createTransport: () => new KazzoTransport(),
    connect: (t, { authorized }) =>
      authorized
        ? (t as KazzoTransport).connectWithDevice(authorized as USBDevice)
        : (t as KazzoTransport).connect(),
    createDriver: (t) => new KazzoDriver(t as KazzoTransport),
    postInitLog: (info) =>
      `Connected: ${info.deviceName} (fw: ${info.firmwareVersion})`,
  },

  POWERSAVE: {
    createTransport: () => new HidTransport(POWERSAVE_FILTERS),
    connect: (t, { authorized }) =>
      authorized
        ? (t as HidTransport).connectWithDevice(authorized as HIDDevice)
        : (t as HidTransport).connect(),
    createDriver: (t) => new PowerSaveDriver(t as HidTransport),
  },

  POWERSAVE_3DS: {
    createTransport: () => new HidTransport(POWERSAVE_3DS_FILTERS),
    connect: (t, { authorized }) =>
      authorized
        ? (t as HidTransport).connectWithDevice(authorized as HIDDevice)
        : (t as HidTransport).connect(),
    createDriver: (t) => new PowerSave3DSDriver(t as HidTransport),
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

  SMS4: {
    createTransport: () => new UsbTransport(SMS4_FILTERS),
    connect: (t, { authorized }) =>
      authorized
        ? (t as UsbTransport).connectWithDevice(authorized as USBDevice)
        : (t as UsbTransport).connect(),
    createDriver: (t) => new SMS4Driver(t as UsbTransport),
  },
};
