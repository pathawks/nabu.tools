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
import { parseAmiiboData } from "./amiibo-header";

export class AmiiboSystemHandler implements SystemHandler {
  readonly systemId = "amiibo";
  readonly displayName = "Amiibo";
  readonly fileExtension = ".bin";

  getConfigFields(
    _currentValues: ConfigValues,
    _autoDetected?: CartridgeInfo,
  ): ResolvedConfigField[] {
    // No user-configurable fields — everything is auto-detected from the tag
    return [];
  }

  validate(_values: ConfigValues): ValidationResult {
    return { valid: true };
  }

  buildReadConfig(values: ConfigValues): ReadConfig {
    return {
      systemId: "amiibo",
      params: { uid: values.uid },
    };
  }

  buildOutputFile(rawData: Uint8Array, _config: ReadConfig): OutputFile {
    const parsed = parseAmiiboData(rawData);
    const uidHex = parsed.uidHex;
    return {
      data: rawData,
      filename: `amiibo_${uidHex}.bin`,
      mimeType: "application/octet-stream",
      meta: {
        Format: "NTAG215",
        UID: parsed.uidFormatted,
        ...(parsed.modelInfo
          ? {
              Series: parsed.modelInfo.seriesName,
              Type: parsed.modelInfo.figureTypeName,
              "Amiibo ID": parsed.modelInfo.amiiboId,
            }
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
    // No verification database for Amiibo — the double-read validation
    // during readROM is our integrity check
    return { matched: false, confidence: "none" };
  }
}
