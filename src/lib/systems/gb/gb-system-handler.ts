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

export class GBSystemHandler implements SystemHandler {
  readonly systemId: string;
  readonly displayName: string;
  readonly fileExtension: string;

  constructor(variant: "gb" | "gbc" = "gb") {
    this.systemId = variant;
    this.displayName = variant === "gbc" ? "Game Boy Color" : "Game Boy";
    this.fileExtension = variant === "gbc" ? ".gbc" : ".gb";
  }

  getConfigFields(
    currentValues: ConfigValues,
    autoDetected?: CartridgeInfo,
  ): ResolvedConfigField[] {
    const fields: ResolvedConfigField[] = [];
    const detected = autoDetected != null;

    // Options first — ROM size and save
    const romSize = (currentValues.romSizeBytes as number) ?? autoDetected?.romSize ?? 32768;
    fields.push({
      key: "romSizeBytes",
      label: "ROM Size",
      type: "select",
      value: romSize,
      autoDetected: detected,
      options: [32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 4194304].map((s) => ({
        value: s,
        label: formatBytes(s),
      })),
      group: "options",
      order: 0,
    });

    const hasSave = autoDetected?.saveSize ? autoDetected.saveSize > 0 : false;
    const saveSize = autoDetected?.saveSize ?? 0;

    if (hasSave) {
      fields.push({
        key: "backupSave",
        label: "Backup save data",
        type: "checkbox",
        value: (currentValues.backupSave as boolean) ?? true,
        group: "options",
        order: 1,
        helpText: `${formatBytes(saveSize)} ${autoDetected?.saveType ?? "SRAM"}`,
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

    if (detected && autoDetected.mapper) {
      fields.push({
        key: "mbc",
        label: "Cart Type",
        type: "readonly",
        value: `${autoDetected.mapper.name}`,
        autoDetected: true,
        group: "cartridge",
        order: 11,
        helpText: autoDetected.meta?.cartTypeName as string | undefined,
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
    return {
      systemId: this.systemId,
      params: {
        romSizeBytes: values.romSizeBytes as number,
        saveSizeBytes: values.backupSave ? (values.saveSizeBytes as number ?? 0) : 0,
        backupSave: values.backupSave as boolean ?? false,
        mbcType: values.mbcType as string | undefined,
      },
    };
  }

  buildOutputFile(rawData: Uint8Array, _config: ReadConfig): OutputFile {
    // GB/GBC ROMs are raw — no header to prepend
    return {
      data: rawData,
      filename: `dump${this.fileExtension}`,
      mimeType: "application/octet-stream",
      meta: {
        Format: this.displayName,
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
      suggestions: ["Clean the cartridge contacts and re-dump."],
    };
  }
}
