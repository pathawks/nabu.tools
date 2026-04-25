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

  /**
   * Generic sanity checks on a freshly-read save dump. There's no
   * NDS-wide save file format, so we can't verify content — but we
   * CAN catch the three most common dumper bugs without game-specific
   * knowledge:
   *
   *   1. **Size not a standard SPI chip size.** NDS save chips come
   *      in known capacities (4 Kbit / 64 Kbit / 512 Kbit EEPROM and
   *      2/4/8 Mbit FLASH). A dump of any other size points at a
   *      miscounted-chunks bug.
   *   2. **First half byte-identical to second half.** Classic sign
   *      of a stuck high-address line or chip misidentified as twice
   *      its real size — the driver reads each byte twice (once for
   *      the low half, once for the high half that wraps back).
   *   3. **All bytes zero.** A real SPI chip always drives MISO to
   *      some value; an unresponsive chip either times out or returns
   *      all 0xFF (bus pulled high). All-0x00 means the firmware
   *      returned zero-padded response without ever clocking the
   *      chip.
   */
  validateDump(data: Uint8Array): { ok: boolean; warnings: string[] } {
    const warnings: string[] = [];

    const STANDARD_SIZES = new Set([
      512,       // 4 Kbit EEPROM
      8192,      // 64 Kbit EEPROM
      65536,     // 512 Kbit EEPROM
      131072,    // 1 Mbit FLASH
      262144,    // 2 Mbit FLASH
      524288,    // 4 Mbit FLASH
      1048576,   // 8 Mbit FLASH
      16777216,  // 128 Mbit FLASH (rare; e.g. Professional baseball)
    ]);
    if (!STANDARD_SIZES.has(data.length)) {
      warnings.push(
        `Save size ${formatBytes(data.length)} is not a standard NDS save-chip capacity — likely a chunking bug`,
      );
    }

    // Uniform-byte check first. If every byte is the same value, the mirror
    // check below would trivially also fire but with less useful wording;
    // skip it. all-0x00 means the firmware returned zero-padded responses
    // without ever clocking the chip; all-0xFF means the bus was idle.
    if (data.length > 0 && data.every((b) => b === data[0])) {
      if (data[0] === 0) {
        warnings.push(
          "Dump is all zeros — the chip didn't respond; real dumps always contain some non-zero bytes (0xFF for unwritten regions)",
        );
      } else if (data[0] === 0xff) {
        warnings.push(
          "Dump is all 0xFF — the chip is returning idle-bus bytes; save-read command may not be reaching the chip",
        );
      } else {
        warnings.push(
          `Dump is all 0x${data[0].toString(16).padStart(2, "0")} — the chip is stuck, save-read command likely failed`,
        );
      }
      return { ok: false, warnings };
    }

    if (data.length >= 2 && data.length % 2 === 0) {
      const half = data.length >>> 1;
      let mirrored = true;
      for (let i = 0; i < half; i++) {
        if (data[i] !== data[half + i]) {
          mirrored = false;
          break;
        }
      }
      if (mirrored) {
        warnings.push(
          "First half of the dump equals the second half — the chip may be smaller than the detected size (address wraps)",
        );
      }
    }

    return { ok: warnings.length === 0, warnings };
  }
}
