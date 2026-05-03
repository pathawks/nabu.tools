import { useState, useCallback, useEffect, useRef } from "react";
import { MockDriver } from "@/lib/core/mock-driver";
import { DEVICES, type DeviceDef } from "@/lib/core/devices";
import { CONNECTION_ENTRIES } from "@/lib/core/connection-registry";
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

const TRANSPORT_LABEL: Record<string, string> = {
  serial: "serial port",
  webhid: "HID device",
  webusb: "USB device",
};

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
        driverRef.current?.dispose?.();
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
    if (driver) {
      try {
        driver.dispose?.();
      } catch (e) {
        log(`Driver dispose warning: ${(e as Error).message}`, "warn");
      }
    }
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
      // Set the ref synchronously so reprobe() can't race us into a duplicate
      // connection before React commits the driver state update.
      driverRef.current = drv;
      setDriver(drv);
      setDeviceInfo(info);
      setConnected(true);
      onReady(drv, info);
    },
    [onReady],
  );

  /**
   * Connect to a registered device.
   *
   * Three race-guard checkpoints (pre-I/O, post-findAuthorized, post-open)
   * make it safe to call concurrently from auto-reconnect probes and the
   * manual handleConnect path: whichever call publishes a driver first wins,
   * and any later caller observes driverRef.current and bails — closing its
   * transport on the rare 3-way tie so we don't leak a port.
   *
   * `auto: true` requires a previously-authorized device and never prompts
   * the user (page-load reconnect has no user gesture to spend).
   *
   * Returns true if this call published a driver, false otherwise.
   */
  const connectDevice = useCallback(
    async (deviceId: string, opts: { auto: boolean }): Promise<boolean> => {
      if (driverRef.current) return false;

      const entry = CONNECTION_ENTRIES[deviceId];
      const dev = DEVICES[deviceId];
      if (!entry || !dev) return false;

      const authorized = await findAuthorized(dev);
      if (opts.auto && !authorized) return false;
      if (driverRef.current) return false;

      const transport = entry.createTransport();
      const transportLabel = TRANSPORT_LABEL[dev.transport] ?? dev.transport;
      log(
        opts.auto || authorized
          ? "Connecting..."
          : `Requesting ${transportLabel}...`,
      );

      try {
        const identity = await entry.connect(transport, { authorized });

        if (driverRef.current) {
          await transport.disconnect().catch(() => {});
          return false;
        }

        log(`Opened ${transportLabel}: ${identity.name}`);

        transport.on("onDisconnect", () => {
          log("Device disconnected", "warn");
          handleDisconnect();
        });

        const drv = entry.createDriver(transport);
        drv.on("onLog", (msg, level) => log(msg, level));

        log(entry.preInitLog ?? "Initializing device...");
        const info = await drv.initialize();

        // Final race check — another path may have published its driver
        // while we were awaiting initialize().
        if (driverRef.current) {
          await transport.disconnect().catch(() => {});
          return false;
        }

        log(entry.postInitLog?.(info) ?? `Connected: ${info.deviceName}`);
        finishConnect(drv, info, deviceId);
        return true;
      } catch (e) {
        // entry.connect or drv.initialize threw — close the transport so we
        // don't leak an open serial port / claimed USB interface / opened
        // HID device, then propagate.
        await transport.disconnect().catch(() => {});
        throw e;
      }
    },
    [log, handleDisconnect, finishConnect],
  );

  // ─── Auto-reconnect on page load ──────────────────────────────────────

  const autoConnectAttempted = useRef(false);
  useEffect(() => {
    if (autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;

    (async () => {
      for (const id of Object.keys(CONNECTION_ENTRIES)) {
        try {
          if (await connectDevice(id, { auto: true })) return;
        } catch (e) {
          log(`Auto-reconnect failed: ${(e as Error).message}`, "warn");
        }
      }
    })();
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
        await connectDevice(deviceId, { auto: false });
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
    [log, connectDevice],
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
