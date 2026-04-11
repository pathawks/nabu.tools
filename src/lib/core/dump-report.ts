import type { DumpResult, DeviceInfo, CartridgeInfo } from "@/lib/types";
import { hexStr, formatBytes } from "./hashing";

export interface DumpReportContext {
  result: DumpResult;
  deviceInfo: DeviceInfo | null;
  cartInfo: CartridgeInfo | null;
  systemDisplayName: string;
  filename: string;
  durationMs: number;
}

export function generateDumpReport(ctx: DumpReportContext): string {
  const { result, deviceInfo, cartInfo, systemDisplayName, filename, durationMs } = ctx;
  const h = result.hashes;
  const v = result.verification;

  const lines: string[] = [];
  const ln = (s = "") => lines.push(s);
  const field = (label: string, value: string) =>
    lines.push(`  ${label.padEnd(18)} ${value}`);

  ln("= nabu Dump Report =");

  // File Information
  ln();
  ln("== File Information ==");
  field("File Name:", filename);
  field("File Size:", `${formatBytes(h.size)} (${h.size} bytes)`);
  field("CRC32:", hexStr(h.crc32).toLowerCase());
  field("SHA-1:", h.sha1);
  if (h.sha256) field("SHA-256:", h.sha256);

  // General Information
  ln();
  ln("== General Information ==");
  if (deviceInfo) {
    field("Hardware:", `${deviceInfo.deviceName} — ${deviceInfo.hardwareRevision ?? ""}`);
    field("Firmware:", deviceInfo.firmwareVersion);
  }
  field("Software:", "nabu");
  field("Dump Time:", new Date().toISOString());
  const seconds = (durationMs / 1000).toFixed(1);
  const rate = h.size > 0 ? formatBytes(Math.round(h.size / (durationMs / 1000))) + "/s" : "";
  field("Time Elapsed:", `${seconds}s (${rate})`);

  // Dumping Settings
  ln();
  ln("== Dumping Settings ==");
  field("System:", systemDisplayName);
  if (result.rom?.meta) {
    for (const [key, value] of Object.entries(result.rom.meta)) {
      field(`${key}:`, value);
    }
  }

  // Parsed Header Data
  if (cartInfo) {
    ln();
    ln("== Parsed Header Data ==");
    if (cartInfo.title) field("Game Title:", cartInfo.title);
    if (cartInfo.mapper) field("Mapper/MBC:", `${cartInfo.mapper.name} (0x${cartInfo.mapper.id.toString(16).padStart(2, "0")})`);
    if (cartInfo.romSize) field("ROM Size:", formatBytes(cartInfo.romSize));
    if (cartInfo.saveSize) field("Save Size:", `${formatBytes(cartInfo.saveSize)} ${cartInfo.saveType ?? ""}`);
    if (cartInfo.meta) {
      for (const [key, value] of Object.entries(cartInfo.meta)) {
        if (typeof value === "boolean") {
          if (value) field(`${key}:`, "Yes");
        } else if (typeof value === "string" || typeof value === "number") {
          field(`${key}:`, String(value));
        }
      }
    }
  }

  // Database Match
  if (v.matched && v.entry) {
    ln();
    ln("== Database Match ==");
    field("Game Name:", v.entry.name);
    if (v.entry.region) field("Region:", v.entry.region);
    if (v.entry.status) field("Status:", v.entry.status);
  }

  ln();
  return lines.join("\n");
}
