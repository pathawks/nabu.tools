// Lego Dimensions NTAG213 data parsing — UID, vehicle detection, identity

import type { CartridgeInfo } from "@/lib/types";
import { lookupLegoDimensionsName } from "./lego-dimensions-db";

// UID byte positions within the NTAG dump (skipping BCC bytes at 3 and 8)
const UID_POSITIONS = [0, 1, 2, 4, 5, 6, 7] as const;

// Page 0x26 = byte offset 152. Vehicle marker: 00 01 00 00
const VEHICLE_MARKER_OFFSET = 152;

// Page 0x24 = byte offset 144. Vehicle ID stored as little-endian uint16
const VEHICLE_ID_OFFSET = 144;

export interface LegoDimensionsData {
  uid: Uint8Array;
  uidHex: string;
  uidFormatted: string;
  uidValid: boolean;
  isVehicle: boolean;
  vehicleId: number | null;
  characterName: string | null;
}

export function parseLegoDimensionsData(
  buffer: Uint8Array,
): LegoDimensionsData {
  const uid = new Uint8Array(UID_POSITIONS.map((i) => buffer[i]));

  // BCC (Block Check Character) validation
  const expectedBcc0 = 0x88 ^ buffer[0] ^ buffer[1] ^ buffer[2];
  const expectedBcc1 = buffer[4] ^ buffer[5] ^ buffer[6] ^ buffer[7];
  const uidValid = buffer[3] === expectedBcc0 && buffer[8] === expectedBcc1;

  // Vehicle detection: page 0x26 (byte 152) = 00 01 00 00
  const isVehicle =
    buffer[VEHICLE_MARKER_OFFSET] === 0x00 &&
    buffer[VEHICLE_MARKER_OFFSET + 1] === 0x01 &&
    buffer[VEHICLE_MARKER_OFFSET + 2] === 0x00 &&
    buffer[VEHICLE_MARKER_OFFSET + 3] === 0x00;

  let vehicleId: number | null = null;
  let characterName: string | null = null;

  if (isVehicle) {
    // Vehicle ID is plaintext little-endian uint16 at page 0x24 (byte 144)
    vehicleId =
      buffer[VEHICLE_ID_OFFSET] | (buffer[VEHICLE_ID_OFFSET + 1] << 8);
    characterName = lookupLegoDimensionsName(vehicleId, true);
  }
  // Characters are TEA-encrypted at pages 0x24-0x25 — cannot decode without
  // the portal's internal key, so we leave characterName null.

  const uidHex = toHex(uid);
  const uidFormatted = Array.from(uid, (b) =>
    b.toString(16).padStart(2, "0").toUpperCase(),
  ).join(":");

  return {
    uid,
    uidHex,
    uidFormatted,
    uidValid,
    isVehicle,
    vehicleId,
    characterName,
  };
}

export function legoDimensionsToCartridgeInfo(
  parsed: LegoDimensionsData,
  rawData: Uint8Array,
): CartridgeInfo {
  const title = parsed.isVehicle
    ? (parsed.characterName ?? "Vehicle (unknown)")
    : "Character (encrypted)";

  return {
    title,
    romSize: rawData.length,
    rawHeader: rawData.slice(0, 96),
    meta: {
      uid: parsed.uid,
      uidHex: parsed.uidHex,
      uidFormatted: parsed.uidFormatted,
      uidValid: parsed.uidValid,
      isVehicle: parsed.isVehicle,
      ...(parsed.vehicleId != null ? { vehicleId: parsed.vehicleId } : {}),
      ...(parsed.characterName != null
        ? { characterName: parsed.characterName }
        : {}),
    },
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
