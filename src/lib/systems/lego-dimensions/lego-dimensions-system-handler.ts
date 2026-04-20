import type {
  SystemHandler,
  ConfigValues,
  CartridgeInfo,
  ResolvedConfigField,
  ValidationResult,
  ReadConfig,
  OutputFile,
  VerificationHashes,
  VerificationDB,
  VerificationResult,
} from "@/lib/types";
import { crc32, sha1Hex, sha256Hex } from "@/lib/core/hashing";
import { NTAG213_SIZE } from "@/lib/drivers/toypad/toypad-commands";
import { parseLegoDimensionsData } from "./lego-dimensions-header";

export class LegoDimensionsSystemHandler implements SystemHandler {
  readonly systemId = "lego_dimensions";
  readonly displayName = "Lego Dimensions";
  readonly fileExtension = ".bin";

  getConfigFields(
    _currentValues: ConfigValues,
    _autoDetected?: CartridgeInfo,
  ): ResolvedConfigField[] {
    // No user-configurable fields — everything is auto-detected from the tag
    return [];
  }

  estimateDumpSize(_values: ConfigValues): number {
    return NTAG213_SIZE;
  }

  validate(_values: ConfigValues): ValidationResult {
    return { valid: true };
  }

  buildReadConfig(values: ConfigValues): ReadConfig {
    return {
      systemId: "lego_dimensions",
      params: { uid: values.uid, padIndex: values.padIndex },
    };
  }

  buildOutputFile(rawData: Uint8Array, _config: ReadConfig): OutputFile {
    const parsed = parseLegoDimensionsData(rawData);

    const filename = parsed.isVehicle
      ? `lego_dimensions_${sanitizeFilename(parsed.characterName ?? "vehicle")}_${parsed.uidHex}.bin`
      : `lego_dimensions_character_${parsed.uidHex}.bin`;

    return {
      data: rawData,
      filename,
      mimeType: "application/octet-stream",
      meta: {
        Format: "NTAG213",
        UID: parsed.uidFormatted,
        Type: parsed.isVehicle ? "Vehicle" : "Character",
        ...(parsed.characterName ? { Name: parsed.characterName } : {}),
        ...(parsed.vehicleId != null
          ? { "Vehicle ID": String(parsed.vehicleId) }
          : {}),
      },
    };
  }

  async computeHashes(rawData: Uint8Array): Promise<VerificationHashes> {
    const [sha1, sha256] = await Promise.all([
      sha1Hex(rawData),
      sha256Hex(rawData),
    ]);
    return { crc32: crc32(rawData), sha1, sha256, size: rawData.length };
  }

  verify(
    _hashes: VerificationHashes,
    _db: VerificationDB | null,
  ): VerificationResult {
    // No verification database for Lego Dimensions NFC tags
    return { matched: false, confidence: "none" };
  }
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
