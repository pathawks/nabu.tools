/**
 * System handler for Nintendo DS / 3DS save files.
 *
 * Used with the EMS NDS Adapter+, which can only read/write saves (not ROMs).
 * The save data arrives via readROM() as the primary output.
 */

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
import { crc32, sha1Hex, sha256Hex, formatBytes } from "@/lib/core/hashing";

export class NDSSaveSystemHandler implements SystemHandler {
  readonly systemId = "nds_save";
  readonly displayName = "NDS / 3DS Save";
  readonly fileExtension = ".sav";

  getConfigFields(
    _currentValues: ConfigValues,
    autoDetected?: CartridgeInfo,
  ): ResolvedConfigField[] {
    const fields: ResolvedConfigField[] = [];

    if (autoDetected?.title) {
      fields.push({
        key: "title",
        label: "Game",
        type: "readonly",
        value: autoDetected.title,
        autoDetected: true,
        group: "cartridge",
        order: 0,
      });
    }

    if (autoDetected?.meta?.gameCode) {
      fields.push({
        key: "gameCode",
        label: "Game Code",
        type: "readonly",
        value: autoDetected.meta.gameCode as string,
        autoDetected: true,
        group: "cartridge",
        order: 1,
      });
    }

    if (autoDetected?.saveType) {
      fields.push({
        key: "saveType",
        label: "Save Type",
        type: "readonly",
        value: autoDetected.saveType,
        autoDetected: true,
        group: "cartridge",
        order: 2,
      });
    }

    if (autoDetected?.saveSize) {
      fields.push({
        key: "saveSizeDisplay",
        label: "Save Size",
        type: "readonly",
        value: formatBytes(autoDetected.saveSize),
        autoDetected: true,
        group: "cartridge",
        order: 3,
      });
    }

    return fields;
  }

  validate(_values: ConfigValues): ValidationResult {
    return { valid: true };
  }

  buildReadConfig(values: ConfigValues): ReadConfig {
    return {
      systemId: "nds_save",
      params: {
        saveSize: values.saveSizeBytes as number | undefined,
        title: values.title as string | undefined,
        gameCode: values.gameCode as string | undefined,
      },
    };
  }

  buildOutputFile(rawData: Uint8Array, config: ReadConfig): OutputFile {
    const title = config.params.title as string | undefined;
    const gameCode = config.params.gameCode as string | undefined;
    const basename = (title ?? gameCode ?? "nds_save")
      .replace(/[^a-zA-Z0-9_ -]/g, "")
      .trim()
      .replace(/\s+/g, "_");

    return {
      data: rawData,
      filename: `${basename}.sav`,
      mimeType: "application/octet-stream",
      meta: {
        Format: "NDS Save",
        ...(title ? { Title: title } : {}),
        ...(gameCode ? { "Game Code": gameCode } : {}),
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
    // No verification database for save files
    return { matched: false, confidence: "none" };
  }
}
