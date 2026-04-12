import { useState, useCallback, useEffect, useRef } from "react";
import { MockDriver } from "@/lib/core/mock-driver";
import { DEVICES, type DeviceDef } from "@/lib/core/devices";
import { SerialTransport } from "@/lib/transport/serial-transport";
import { HidTransport } from "@/lib/transport/hid-transport";
import { UsbTransport } from "@/lib/transport/usb-transport";
import { GBxCartDriver } from "@/lib/drivers/gbxcart/gbxcart-driver";
import { PowerSaveDriver } from "@/lib/drivers/powersave/powersave-driver";
import { DEVICE_FILTERS } from "@/lib/drivers/powersave/powersave-commands";
import { EMSNDSDriver } from "@/lib/drivers/ems-nds/ems-nds-driver";
import { EMS_NDS_FILTER } from "@/lib/drivers/ems-nds/ems-nds-commands";
import type { DeviceDriver, DeviceInfo, Transport } from "@/lib/types";

// ─── Device probing ──────────────────────────────────────────────────────

/** Check all browser device APIs for previously-authorized, currently-connected devices. */
async function probeAvailableDevices(): Promise<Set<string>> {
  const available = new Set<string>();
  const entries = Object.entries(DEVICES);

  try {
    const ports = (await navigator.serial?.getPorts()) ?? [];
    for (const port of ports) {
      const info = port.getInfo();
      for (const [id, dev] of entries) {
        if (
          dev.transport === "serial" &&
          info.usbVendorId === dev.vendorId &&
          info.usbProductId === dev.productId
        )
          available.add(id);
      }
    }
  } catch {
    /* API unavailable */
  }

  try {
    const devices = (await navigator.usb?.getDevices()) ?? [];
    for (const d of devices) {
      for (const [id, dev] of entries) {
        if (
          dev.transport === "webusb" &&
          d.vendorId === dev.vendorId &&
          d.productId === dev.productId
        )
          available.add(id);
      }
    }
  } catch {
    /* API unavailable */
  }

  try {
    const devices = (await navigator.hid?.getDevices()) ?? [];
    for (const d of devices) {
      for (const [id, dev] of entries) {
        if (
          dev.transport === "webhid" &&
          d.vendorId === dev.vendorId &&
          d.productId === dev.productId
        )
          available.add(id);
      }
    }
  } catch {
    /* API unavailable */
  }

  return available;
}

/** Find a previously-authorized native device/port for a given DeviceDef. */
async function findAuthorized(
  dev: DeviceDef,
): Promise<SerialPort | USBDevice | HIDDevice | null> {
  switch (dev.transport) {
    case "serial": {
      const ports = (await navigator.serial?.getPorts()) ?? [];
      return (
        ports.find((p) => {
          const info = p.getInfo();
          return (
            info.usbVendorId === dev.vendorId &&
            info.usbProductId === dev.productId
          );
        }) ?? null
      );
    }
    case "webusb": {
      const devices = (await navigator.usb?.getDevices()) ?? [];
      return (
        devices.find(
          (d) => d.vendorId === dev.vendorId && d.productId === dev.productId,
        ) ?? null
      );
    }
    case "webhid": {
      const devices = (await navigator.hid?.getDevices()) ?? [];
      return (
        devices.find(
          (d) => d.vendorId === dev.vendorId && d.productId === dev.productId,
        ) ?? null
      );
    }
    default:
      return null;
  }
}

type LogFn = (msg: string, level?: "info" | "warn" | "error") => void;

interface UseConnectionOptions {
  log: LogFn;
  onReady: (driver: DeviceDriver, info: DeviceInfo) => void;
}

export function useConnection({ log, onReady }: UseConnectionOptions) {
  const [connected, setConnected] = useState(false);
  const [driver, setDriver] = useState<DeviceDriver | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [availableDevices, setAvailableDevices] = useState<Set<string>>(
    new Set(),
  );

  const driverRef = useRef<DeviceDriver | null>(null);
  const lastDeviceIdRef = useRef<string | null>(null);
  const handleConnectRef = useRef<((id: string) => Promise<void>) | null>(null);

  // Keep ref in sync for cleanup handler
  useEffect(() => {
    driverRef.current = driver;
  }, [driver]);

  // Close transport on page unload/refresh
  useEffect(() => {
    const cleanup = () => {
      try {
        driverRef.current?.transport?.disconnect();
      } catch {
        // Best-effort — page is unloading
      }
    };
    window.addEventListener("beforeunload", cleanup);
    return () => window.removeEventListener("beforeunload", cleanup);
  }, []);

  // ─── Probe for available devices ──────────────────────────────────────

  useEffect(() => {
    const reprobe = () =>
      probeAvailableDevices().then((available) => {
        setAvailableDevices(available);
        // Auto-reconnect when the last-used device reappears (e.g. cart swap)
        const lastId = lastDeviceIdRef.current;
        if (lastId && available.has(lastId) && !driverRef.current) {
          handleConnectRef.current?.(lastId);
        }
      });
    reprobe();

    const usb = navigator.usb;
    const hid = navigator.hid;
    const serial = navigator.serial;
    usb?.addEventListener("connect", reprobe);
    usb?.addEventListener("disconnect", reprobe);
    hid?.addEventListener("connect", reprobe);
    hid?.addEventListener("disconnect", reprobe);
    serial?.addEventListener("connect", reprobe);
    serial?.addEventListener("disconnect", reprobe);
    return () => {
      usb?.removeEventListener("connect", reprobe);
      usb?.removeEventListener("disconnect", reprobe);
      hid?.removeEventListener("connect", reprobe);
      hid?.removeEventListener("disconnect", reprobe);
      serial?.removeEventListener("connect", reprobe);
      serial?.removeEventListener("disconnect", reprobe);
    };
  }, []);

  const handleDisconnect = useCallback(async () => {
    if (driver?.transport?.connected) {
      try {
        await driver.transport.disconnect();
      } catch (e) {
        const msg = (e as Error).message;
        if (!msg.includes("closed")) {
          log(`Disconnect warning: ${msg}`, "warn");
        }
      }
    }
    setDriver(null);
    setDeviceInfo(null);
    setConnected(false);
    setConnectError(null);
    log("Disconnected");
    // Re-probe so the connect screen shows current availability
    probeAvailableDevices().then(setAvailableDevices);
  }, [driver, log]);

  /** Shared post-connect: set state and notify caller. */
  const finishConnect = useCallback(
    (drv: DeviceDriver, info: DeviceInfo, deviceId?: string) => {
      if (deviceId) lastDeviceIdRef.current = deviceId;
      setDriver(drv);
      setDeviceInfo(info);
      setConnected(true);
      onReady(drv, info);
    },
    [onReady],
  );

  // ─── Auto-reconnect on page load ──────────────────────────────────────

  const autoConnectAttempted = useRef(false);
  useEffect(() => {
    if (autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;

    // Try serial (GBxCart)
    navigator.serial?.getPorts().then(async (ports) => {
      if (ports.length !== 1) return;

      log("Reconnecting to serial port...");
      try {
        const transport = new SerialTransport();
        const identity = await transport.connectWithPort(ports[0], {
          baudRate: 1_000_000,
        });
        log(
          `Serial port opened: ${identity.vendorId?.toString(16)}:${identity.productId?.toString(16)}`,
        );

        transport.on("onDisconnect", () => {
          log("Device disconnected", "warn");
          handleDisconnect();
        });

        const gbxDriver = new GBxCartDriver(transport);
        gbxDriver.on("onLog", (msg, level) => log(msg, level));

        log("Initializing device...");
        const info = await gbxDriver.initialize();
        log(
          `Connected: ${info.deviceName} (fw: ${info.firmwareVersion}, ${info.hardwareRevision})`,
        );
        finishConnect(gbxDriver, info, "GBXCART");
      } catch (e) {
        log(`Auto-reconnect failed: ${(e as Error).message}`, "warn");
      }
    });

    // Try WebUSB (EMS NDS Adapter)
    navigator.usb?.getDevices().then(async (devices) => {
      const emsDev = devices.find(
        (d) =>
          d.vendorId === EMS_NDS_FILTER.vendorId &&
          d.productId === EMS_NDS_FILTER.productId,
      );
      if (emsDev) {
        log("Reconnecting to USB device...");
        try {
          const transport = new UsbTransport([EMS_NDS_FILTER]);
          await transport.connectWithDevice(emsDev);

          transport.on("onDisconnect", () => {
            log("Device disconnected", "warn");
            handleDisconnect();
          });

          const emsDriver = new EMSNDSDriver(transport);
          emsDriver.on("onLog", (msg, level) => log(msg, level));

          const info = await emsDriver.initialize();
          log(`Connected: ${info.deviceName} (fw: ${info.firmwareVersion})`);
          finishConnect(emsDriver, info, "EMS_NDS");
        } catch (e) {
          log(`Auto-reconnect failed: ${(e as Error).message}`, "warn");
        }
      }
    });

    // Try HID (PowerSave Portal)
    navigator.hid?.getDevices().then(async (devices) => {
      const psDevice = devices.find((d) =>
        DEVICE_FILTERS.some(
          (f) => f.vendorId === d.vendorId && f.productId === d.productId,
        ),
      );
      if (psDevice) {
        log("Reconnecting to HID device...");
        try {
          const transport = new HidTransport(DEVICE_FILTERS);
          const identity = await transport.connectWithDevice(psDevice);
          log(`HID device opened: ${identity.name}`);

          transport.on("onDisconnect", () => {
            log("Device disconnected", "warn");
            handleDisconnect();
          });

          const psDriver = new PowerSaveDriver(transport);
          psDriver.on("onLog", (msg, level) => log(msg, level));

          const info = await psDriver.initialize();
          log(`Connected: ${info.deviceName}`);
          finishConnect(psDriver, info, "POWERSAVE");
        } catch (e) {
          log(`Auto-reconnect failed: ${(e as Error).message}`, "warn");
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Manual connect ────────────────────────────────────────────────────

  const handleConnect = useCallback(
    async (deviceId: string) => {
      const dev = DEVICES[deviceId];
      if (!dev) return;
      setConnectError(null);

      const apiAvailable: Record<string, boolean> = {
        serial: !!navigator.serial,
        webusb: !!navigator.usb,
        webhid: !!navigator.hid,
      };
      if (!apiAvailable[dev.transport]) {
        setConnectError(
          `${dev.transport} API is not available. Use Chrome or Edge.`,
        );
        return;
      }

      try {
        const authorized = await findAuthorized(dev);

        switch (deviceId) {
          case "GBXCART": {
            const transport = new SerialTransport();
            if (authorized) {
              log("Connecting...");
              await transport.connectWithPort(authorized as SerialPort, {
                baudRate: 1_000_000,
              });
            } else {
              log("Requesting serial port...");
              await transport.connect({ baudRate: 1_000_000 });
            }

            transport.on("onDisconnect", () => {
              log("Device disconnected", "warn");
              handleDisconnect();
            });

            const gbxDriver = new GBxCartDriver(transport);
            gbxDriver.on("onLog", (msg, level) => log(msg, level));

            log("Initializing device...");
            const info = await gbxDriver.initialize();
            log(
              `Connected: ${info.deviceName} (fw: ${info.firmwareVersion}, ${info.hardwareRevision})`,
            );
            finishConnect(gbxDriver, info, deviceId);
            break;
          }

          case "POWERSAVE": {
            const transport = new HidTransport(DEVICE_FILTERS);
            if (authorized) {
              log("Connecting...");
              await transport.connectWithDevice(authorized as HIDDevice);
            } else {
              log("Requesting HID device...");
              await transport.connect();
            }

            transport.on("onDisconnect", () => {
              log("Device disconnected", "warn");
              handleDisconnect();
            });

            const psDriver = new PowerSaveDriver(transport);
            psDriver.on("onLog", (msg, level) => log(msg, level));

            const info = await psDriver.initialize();
            log(`Connected: ${info.deviceName}`);
            finishConnect(psDriver, info, deviceId);
            break;
          }

          case "EMS_NDS": {
            const transport = new UsbTransport([EMS_NDS_FILTER]);
            if (authorized) {
              log("Connecting...");
              await transport.connectWithDevice(authorized as USBDevice);
            } else {
              log("Requesting USB device...");
              await transport.connect();
            }

            transport.on("onDisconnect", () => {
              log("Device disconnected", "warn");
              handleDisconnect();
            });

            const emsDriver = new EMSNDSDriver(transport);
            emsDriver.on("onLog", (msg, level) => log(msg, level));

            log("Initializing device...");
            const emsInfo = await emsDriver.initialize();
            log(
              `Connected: ${emsInfo.deviceName} (fw: ${emsInfo.firmwareVersion})`,
            );
            finishConnect(emsDriver, emsInfo, deviceId);
            break;
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (
          msg.includes("No port selected") ||
          msg.includes("No device selected")
        ) {
          log("Selection cancelled", "warn");
        } else {
          setConnectError(msg);
          log(`Connection error: ${msg}`, "error");
        }
      }
    },
    [log, handleDisconnect, finishConnect],
  );

  // Keep ref in sync so the probe effect can trigger reconnection
  useEffect(() => {
    handleConnectRef.current = handleConnect;
  }, [handleConnect]);

  const handleMockConnect = useCallback(async () => {
    log("Connecting to mock device...");
    setConnectError(null);
    const mockTransport = {
      type: "serial" as const,
      connected: true,
      connect: async () => ({ name: "Mock", transport: "serial" as const }),
      disconnect: async () => {},
      send: async () => {},
      receive: async () => new Uint8Array(0),
      on: () => {},
    } satisfies Transport;

    const mockDriver = new MockDriver(mockTransport);
    const info = await mockDriver.initialize();
    log(`Connected: ${info.deviceName} (fw: ${info.firmwareVersion})`);
    finishConnect(mockDriver, info);
  }, [log, finishConnect]);

  return {
    connected,
    driver,
    deviceInfo,
    connectError,
    availableDevices,
    handleConnect,
    handleMockConnect,
    handleDisconnect,
  };
}
