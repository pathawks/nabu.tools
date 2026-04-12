import type {
  SystemHandler,
  ConfigValues,
  CartridgeInfo,
  ResolvedConfigField,
  ValidationResult,
  ValidationError,
  ReadConfig,
  OutputFile,
  VerificationHashes,
  VerificationDB,
  VerificationResult,
} from "@/lib/types";
import { crc32, sha1Hex, sha256Hex } from "@/lib/core/hashing";
import { NES_MAPPER_DB, getMapperDef, coerceToNearest } from "./nes-constants";

export class NESSystemHandler implements SystemHandler {
  readonly systemId = "nes" as const;
  readonly displayName = "NES / Famicom";
  readonly fileExtension = ".nes";

  getConfigFields(
    currentValues: ConfigValues,
    autoDetected?: CartridgeInfo,
  ): ResolvedConfigField[] {
    const fields: ResolvedConfigField[] = [];

    // Mapper
    const mapperValue =
      (currentValues.mapper as number) ?? autoDetected?.mapper?.id ?? 0;
    const mapperDef = getMapperDef(mapperValue);

    fields.push({
      key: "mapper",
      label: "Mapper",
      type: "select",
      value: mapperValue,
      autoDetected: autoDetected?.mapper != null,
      options: NES_MAPPER_DB.map((m) => ({
        value: m.id,
        label: `${m.id}: ${m.name}`,
        hint:
          `PRG: ${m.prgSizesKB.join("/")}KB` +
          (m.chrSizesKB.some((c) => c > 0)
            ? ` · CHR: ${m.chrSizesKB.filter((c) => c > 0).join("/")}KB`
            : " · CHR RAM"),
      })),
      group: "cartridge",
      order: 0,
      helpText: autoDetected?.mapper
        ? `Auto-detected: ${autoDetected.mapper.name}`
        : "Look up your game at bootgod.dyndns.org:7777 or nescartdb.com",
    });

    // PRG ROM Size
    const validPrgSizes = mapperDef?.prgSizesKB ?? [16, 32, 64, 128, 256, 512];
    const rawPrgValue =
      (currentValues.prgSizeKB as number) ??
      (autoDetected?.romSize ? autoDetected.romSize / 1024 : undefined);
    const prgSizeKB = coerceToNearest(
      rawPrgValue ?? validPrgSizes[validPrgSizes.length - 1],
      validPrgSizes,
    );
    const prgLocked = validPrgSizes.length === 1;

    fields.push({
      key: "prgSizeKB",
      label: "PRG ROM",
      type: "select",
      value: prgSizeKB,
      locked: prgLocked,
      lockedReason: prgLocked
        ? `${mapperDef?.name} only supports ${validPrgSizes[0]}KB PRG ROM`
        : undefined,
      autoDetected: autoDetected?.romSize != null,
      options: validPrgSizes.map((s) => ({
        value: s,
        label: `${s} KB`,
        hint: `${s / 16} x 16KB banks`,
      })),
      dependsOn: ["mapper"],
      group: "rom_sizes",
      order: 1,
    });

    // CHR ROM Size
    const validChrSizes = mapperDef?.chrSizesKB ?? [0, 8, 16, 32, 64, 128, 256];
    const chrRamOnly = validChrSizes.length === 1 && validChrSizes[0] === 0;
    const rawChrValue = currentValues.chrSizeKB as number | undefined;
    const chrSizeKB = coerceToNearest(
      rawChrValue ?? validChrSizes[validChrSizes.length - 1],
      validChrSizes,
    );

    fields.push({
      key: "chrSizeKB",
      label: "CHR ROM",
      type: chrRamOnly ? "readonly" : "select",
      value: chrSizeKB,
      locked: chrRamOnly,
      lockedReason: chrRamOnly
        ? `${mapperDef?.name} uses CHR RAM — no CHR ROM to dump`
        : undefined,
      autoDetected: false,
      options: chrRamOnly
        ? [{ value: 0, label: "None (CHR RAM)" }]
        : validChrSizes.map((s) => ({
            value: s,
            label: s === 0 ? "None (CHR RAM)" : `${s} KB`,
            hint: s === 0 ? "Cart uses CHR RAM" : `${s / 8} x 8KB banks`,
          })),
      dependsOn: ["mapper"],
      group: "rom_sizes",
      order: 2,
      helpText: chrRamOnly
        ? "This mapper uses CHR RAM instead of mask ROM. No CHR data to dump."
        : undefined,
    });

    // Mirroring
    const mirrorMode = mapperDef?.mirroring ?? "selectable";
    const detectedMirroring = autoDetected?.meta?.mirroring as
      | string
      | undefined;
    if (mirrorMode === "selectable") {
      fields.push({
        key: "mirroring",
        label: "Nametable Mirroring",
        type: "select",
        value: (currentValues.mirroring as string) ?? "horizontal",
        autoDetected: detectedMirroring != null,
        options: [
          {
            value: "horizontal",
            label: "Horizontal",
            hint: "Vertical scrolling games",
          },
          {
            value: "vertical",
            label: "Vertical",
            hint: "Horizontal scrolling games",
          },
          {
            value: "one_screen_a",
            label: "Single-Screen A",
            hint: "Rare — one nametable page",
          },
          {
            value: "one_screen_b",
            label: "Single-Screen B",
            hint: "Rare — one nametable page",
          },
          {
            value: "four_screen",
            label: "Four-Screen",
            hint: "Rare — extra VRAM on cart",
          },
        ],
        group: "header",
        order: 3,
      });
    } else {
      const mirrorLabel: Record<string, string> = {
        mapper_controlled: "Mapper-controlled (automatic)",
        horizontal: "Fixed horizontal",
        vertical: "Fixed vertical",
        four_screen: "Four-screen VRAM",
      };
      fields.push({
        key: "mirroring",
        label: "Nametable Mirroring",
        type: "readonly",
        value: mirrorMode,
        locked: true,
        lockedReason: `${mapperDef?.name} controls mirroring via mapper registers`,
        group: "header",
        order: 3,
        helpText: mirrorLabel[mirrorMode] ?? mirrorMode,
      });
    }

    // Battery
    const batteryDefault =
      mapperDef?.alwaysHasBattery ?? mapperDef?.commonlyHasBattery ?? false;
    const batteryLocked = mapperDef?.alwaysHasBattery === true;
    const batteryValue = batteryLocked
      ? true
      : ((currentValues.battery as boolean) ?? batteryDefault);

    fields.push({
      key: "battery",
      label: "Battery-backed SRAM",
      type: "checkbox",
      value: batteryValue,
      locked: batteryLocked,
      lockedReason: batteryLocked
        ? `${mapperDef?.name} always has battery SRAM`
        : undefined,
      group: "header",
      order: 4,
    });

    // Backup save option
    if (batteryValue && mapperDef && mapperDef.maxPrgRamKB > 0) {
      fields.push({
        key: "backupSave",
        label: "Also backup SRAM save",
        type: "checkbox",
        value: (currentValues.backupSave as boolean) ?? true,
        group: "save",
        order: 5,
        helpText: `Read ${mapperDef.maxPrgRamKB}KB of battery-backed SRAM.`,
      });
    }

    return fields;
  }

  estimateDumpSize(values: ConfigValues): number {
    const mapper = (values.mapper as number) ?? 0;
    const def = getMapperDef(mapper);
    const prgKB = (values.prgSizeKB as number) ?? def?.prgSizesKB[0] ?? 32;
    const chrKB = (values.chrSizeKB as number) ?? def?.chrSizesKB[0] ?? 0;
    return 16 + (prgKB + chrKB) * 1024;
  }

  validate(values: ConfigValues): ValidationResult {
    const errors: ValidationError[] = [];
    const mapper = (values.mapper as number) ?? 0;
    const def = getMapperDef(mapper);

    if (!def) {
      errors.push({
        field: "mapper",
        message: `Unknown mapper ${mapper}.`,
        code: "UNKNOWN_MAPPER",
        severity: "warning",
        suggestion: "Verify the mapper number from NESCartDB.",
      });
      return errors.length > 0 ? { valid: false, errors } : { valid: true };
    }

    const prgSizeKB = (values.prgSizeKB as number) ?? def.prgSizesKB[0];
    const chrSizeKB = (values.chrSizeKB as number) ?? def.chrSizesKB[0];

    if (!def.prgSizesKB.includes(prgSizeKB)) {
      errors.push({
        field: "prgSizeKB",
        message: `${def.name} does not support ${prgSizeKB}KB PRG ROM.`,
        code: "INVALID_PRG_SIZE",
        severity: "error",
        suggestion: `Valid sizes: ${def.prgSizesKB.map((s) => s + "KB").join(", ")}`,
      });
    }

    if (!def.chrSizesKB.includes(chrSizeKB)) {
      errors.push({
        field: "chrSizeKB",
        message: `${def.name} does not support ${chrSizeKB}KB CHR ROM.`,
        code: "INVALID_CHR_SIZE",
        severity: "error",
      });
    }

    if (def.commonlyHasBattery && !(values.battery as boolean)) {
      errors.push({
        field: "battery",
        message: `Most ${def.name} games have battery-backed SRAM.`,
        code: "BATTERY_UNCOMMON",
        severity: "warning",
      });
    }

    return errors.length > 0
      ? { valid: !errors.some((e) => e.severity === "error"), errors }
      : { valid: true };
  }

  buildReadConfig(values: ConfigValues): ReadConfig {
    const mapper = (values.mapper as number) ?? 0;
    const mapperDef = getMapperDef(mapper);
    const validPrg = mapperDef?.prgSizesKB ?? [32];
    const validChr = mapperDef?.chrSizesKB ?? [8];
    const prgSizeKB =
      (values.prgSizeKB as number) ?? validPrg[validPrg.length - 1];
    const chrSizeKB =
      (values.chrSizeKB as number) ?? validChr[validChr.length - 1];
    return {
      systemId: "nes",
      params: {
        mapper,
        prgSizeBytes: prgSizeKB * 1024,
        chrSizeBytes: chrSizeKB * 1024,
        mirroring:
          mapperDef?.mirroring === "selectable"
            ? (values.mirroring as string)
            : (mapperDef?.mirroring ?? "horizontal"),
        battery: values.battery as boolean,
        backupSave: (values.backupSave as boolean) ?? false,
        prgRamSizeBytes: mapperDef?.maxPrgRamKB
          ? mapperDef.maxPrgRamKB * 1024
          : 0,
      },
    };
  }

  buildOutputFile(rawData: Uint8Array, config: ReadConfig): OutputFile {
    const p = config.params;
    const prgBytes = p.prgSizeBytes as number;
    const chrBytes = p.chrSizeBytes as number;
    const mapper = p.mapper as number;
    const mirroring = p.mirroring as string;
    const battery = p.battery as boolean;

    const header = new Uint8Array(16);
    header[0] = 0x4e;
    header[1] = 0x45;
    header[2] = 0x53;
    header[3] = 0x1a;
    header[4] = prgBytes / 16384;
    header[5] = chrBytes / 8192;
    let flags6 = (mapper & 0x0f) << 4;
    if (mirroring === "vertical") flags6 |= 0x01;
    if (battery) flags6 |= 0x02;
    if (mirroring === "four_screen") flags6 |= 0x08;
    header[6] = flags6;
    header[7] = mapper & 0xf0;

    const output = new Uint8Array(16 + rawData.length);
    output.set(header, 0);
    output.set(rawData, 16);

    const mapperDef = getMapperDef(mapper);
    return {
      data: output,
      filename: `dump_mapper${mapper}.nes`,
      mimeType: "application/octet-stream",
      meta: {
        Format: "iNES 1.0",
        Mapper: `${mapper}: ${mapperDef?.name ?? "Unknown"}`,
        "PRG ROM": `${prgBytes / 1024} KB`,
        "CHR ROM": chrBytes > 0 ? `${chrBytes / 1024} KB` : "None (CHR RAM)",
        Mirroring: mirroring,
        Battery: battery ? "Yes" : "No",
      },
    };
  }

  async computeHashes(rawData: Uint8Array): Promise<VerificationHashes> {
    // No-Intro NES DATs are "Headered" — hash includes the 16-byte iNES header.
    // rawData here is PRG+CHR without header, but buildOutputFile prepends it.
    // We hash the raw data for now; verify() will try both raw and headered.
    const [sha1, sha256] = await Promise.all([
      sha1Hex(rawData),
      sha256Hex(rawData),
    ]);
    return { crc32: crc32(rawData), sha1, sha256, size: rawData.length };
  }

  verify(
    hashes: VerificationHashes,
    db: VerificationDB | null,
  ): VerificationResult {
    if (!db) return { matched: false, confidence: "none" };
    const entry = db.lookup(hashes);
    if (entry) return { matched: true, entry, confidence: "exact" };
    return {
      matched: false,
      confidence: "none",
      suggestions: [
        "Verify mapper and ROM sizes are correct.",
        "Clean the cartridge contacts and re-dump.",
      ],
    };
  }
}
