import type { DeviceDef } from "@/lib/core/devices";

/**
 * Build a single-line udev rule for a device. The subsystem match depends on
 * how Chrome accesses the device on Linux:
 *   - WebUSB    → SUBSYSTEM=="usb"        (raw USB via /dev/bus/usb/...)
 *   - WebHID    → KERNEL=="hidraw*"       (hidraw subsystem; ATTRS{} walks
 *                                          up the parent chain for VID/PID)
 *   - Web Serial → SUBSYSTEM=="tty"       (covers ttyUSB* and ttyACM*)
 *
 * `TAG+="uaccess"` asks systemd-logind to grant an ACL to the active console
 * user, which is what we actually want — the desktop user running Chrome.
 * The `+=` operator is cooperative with anything else udev might tag.
 * `MODE="0660"` keeps non-logged-in users out as a floor.
 */
export function buildUdevRule(dev: DeviceDef): string {
  if (dev.vendorId == null || dev.productId == null) return "";
  const v = dev.vendorId.toString(16).padStart(4, "0");
  const p = dev.productId.toString(16).padStart(4, "0");
  const subsystem =
    dev.transport === "webhid"
      ? 'KERNEL=="hidraw*"'
      : dev.transport === "serial"
        ? 'SUBSYSTEM=="tty"'
        : 'SUBSYSTEM=="usb"';
  return `${subsystem}, ATTRS{idVendor}=="${v}", ATTRS{idProduct}=="${p}", TAG+="uaccess", MODE="0660"`;
}

/** Format `vid:pid` as the conventional 4+4 lowercase hex pair. */
export function formatUsbId(dev: DeviceDef): string {
  if (dev.vendorId == null || dev.productId == null) return "";
  const v = dev.vendorId.toString(16).padStart(4, "0");
  const p = dev.productId.toString(16).padStart(4, "0");
  return `${v}:${p}`;
}

/** True on Linux, including ChromeOS (whose userAgentData reports "Chrome OS" but whose navigator.platform contains "Linux"). */
export function isLinuxLike(): boolean {
  const ua = (
    navigator as Navigator & { userAgentData?: { platform: string } }
  ).userAgentData?.platform;
  return /linux/i.test(`${ua ?? ""} ${navigator.platform ?? ""}`);
}
