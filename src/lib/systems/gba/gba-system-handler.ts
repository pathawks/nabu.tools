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

// Common GBA ROM sizes
const GBA_ROM_SIZES = [
  1 * 1024 * 1024,   //  1 MB
  2 * 1024 * 1024,   //  2 MB
  4 * 1024 * 1024,   //  4 MB
  8 * 1024 * 1024,   //  8 MB
  16 * 1024 * 1024,  // 16 MB
  32 * 1024 * 1024,  // 32 MB
];

const GBA_SAVE_TYPES = [
  { value: "none", label: "None" },
  { value: "sram_32k", label: "SRAM (32 KB)" },
  { value: "flash_64k", label: "Flash (64 KB)" },
  { value: "flash_128k", label: "Flash (128 KB)" },
  { value: "eeprom_512", label: "EEPROM (512 B)" },
  { value: "eeprom_8k", label: "EEPROM (8 KB)" },
];

const SAVE_TYPE_SIZES: Record<string, number> = {
  none: 0,
  sram_32k: 32 * 1024,
  flash_64k: 64 * 1024,
  flash_128k: 128 * 1024,
  eeprom_512: 512,
  eeprom_8k: 8 * 1024,
};

export class GBASystemHandler implements SystemHandler {
  readonly systemId = "gba" as const;
  readonly displayName = "Game Boy Advance";
  readonly fileExtension = ".gba";

  getConfigFields(
    currentValues: ConfigValues,
    autoDetected?: CartridgeInfo,
  ): ResolvedConfigField[] {
    const fields: ResolvedConfigField[] = [];
    const detected = autoDetected != null;

    // Options first — ROM size and save type
    const romSize = (currentValues.romSizeBytes as number) ?? autoDetected?.romSize ?? 16 * 1024 * 1024;
    fields.push({
      key: "romSizeBytes",
      label: "ROM Size",
      type: "select",
      value: romSize,
      options: GBA_ROM_SIZES.map((s) => ({ value: s, label: formatBytes(s) })),
      group: "options",
      order: 0,
    });

    const saveType = (currentValues.saveType as string) ?? autoDetected?.saveType ?? "none";
    fields.push({
      key: "saveType",
      label: "Save Type",
      type: detected && autoDetected?.saveType ? "readonly" : "select",
      value: saveType,
      autoDetected: detected && autoDetected?.saveType != null,
      options: GBA_SAVE_TYPES,
      group: "options",
      order: 1,
    });

    if (saveType !== "none") {
      fields.push({
        key: "backupSave",
        label: "Backup save data",
        type: "checkbox",
        value: (currentValues.backupSave as boolean) ?? true,
        group: "options",
        order: 2,
        helpText: `${formatBytes(SAVE_TYPE_SIZES[saveType] ?? 0)} ${saveType.replace("_", " ")}`,
      });
    }

    if (detected && autoDetected.title) {
      fields.push({
        key: "title",
        label: "Game Title",
        type: "readonly",
        value: autoDetected.title,
        autoDetected: true,
        group: "cartridge",
        order: 10,
      });
    }

    if (detected && autoDetected.meta?.gameCode) {
      fields.push({
        key: "gameCode",
        label: "Game Code",
        type: "readonly",
        value: autoDetected.meta.gameCode as string,
        autoDetected: true,
        group: "cartridge",
        order: 11,
      });
    }

    return fields;
  }

  validate(values: ConfigValues): ValidationResult {
    const romSize = values.romSizeBytes as number;
    if (!romSize || romSize <= 0) {
      return {
        valid: false,
        errors: [
          { field: "romSizeBytes", message: "ROM size is required.", code: "NO_ROM_SIZE", severity: "error" },
        ],
      };
    }
    return { valid: true };
  }

  buildReadConfig(values: ConfigValues): ReadConfig {
    const saveType = (values.saveType as string) ?? "none";
    return {
      systemId: "gba",
      params: {
        romSizeBytes: values.romSizeBytes as number,
        saveType,
        saveSizeBytes: values.backupSave ? (SAVE_TYPE_SIZES[saveType] ?? 0) : 0,
        backupSave: (values.backupSave as boolean) ?? false,
      },
    };
  }

  buildOutputFile(rawData: Uint8Array, _config: ReadConfig): OutputFile {
    return {
      data: rawData,
      filename: `dump.gba`,
      mimeType: "application/octet-stream",
      meta: {
        Format: "Game Boy Advance",
      },
    };
  }

  async computeHashes(rawData: Uint8Array): Promise<VerificationHashes> {
    const [sha1, sha256] = await Promise.all([sha1Hex(rawData), sha256Hex(rawData)]);
    return { crc32: crc32(rawData), sha1, sha256, size: rawData.length };
  }

  verify(hashes: VerificationHashes, db: VerificationDB | null): VerificationResult {
    if (!db) return { matched: false, confidence: "none" };
    const entry = db.lookup(hashes);
    if (entry) return { matched: true, entry, confidence: "exact" };
    return {
      matched: false,
      confidence: "none",
      suggestions: ["Verify ROM size. GBA ROMs can be auto-detected by reading until 0xFF padding."],
    };
  }
}
