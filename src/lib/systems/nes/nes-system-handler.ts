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
import { buildNes2Header, type NesMirroring } from "./nes-header";
import { bytesEqual, isUniformFill } from "./mappers/bank-reliability";

/**
 * The effective PRG/CHR sizes for a config: the user's selection when set,
 * otherwise the mapper's default — the LARGEST supported size (the last
 * entry), which is what the PRG/CHR config fields default to and what
 * `buildReadConfig` reads. Resolving it in one place keeps the size estimate,
 * validation, and the actual dump from diverging.
 */
function resolveSizesKB(
  values: ConfigValues,
  def: ReturnType<typeof getMapperDef>,
): { prgKB: number; chrKB: number } {
  const prgSizes = def?.prgSizesKB ?? [32];
  const chrSizes = def?.chrSizesKB ?? [8];
  return {
    prgKB: (values.prgSizeKB as number) ?? prgSizes[prgSizes.length - 1],
    chrKB: (values.chrSizeKB as number) ?? chrSizes[chrSizes.length - 1],
  };
}

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
        : "Look up your game's mapper and ROM sizes on nescartdb.com",
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
      group: "cartridge",
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
      group: "cartridge",
      order: 2,
      helpText: chrRamOnly
        ? "This mapper uses CHR RAM instead of mask ROM. No CHR data to dump."
        : undefined,
    });

    // Battery SRAM — a single opt-in, off by default. Checking it reads
    // the save alongside the ROM. Mirroring isn't a config field either:
    // it doesn't affect the dumped bytes, and a No-Intro match supplies
    // the header anyway — the case we optimize for.
    if (mapperDef && mapperDef.maxPrgRamKB > 0) {
      fields.push({
        key: "backupSave",
        label: "Back up battery SRAM",
        type: "checkbox",
        value: (currentValues.backupSave as boolean) ?? false,
        group: "save",
        order: 4,
        helpText: `Also read ${mapperDef.maxPrgRamKB}KB of battery-backed SRAM.`,
      });
    }

    return fields;
  }

  estimateDumpSize(values: ConfigValues): number {
    const def = getMapperDef((values.mapper as number) ?? 0);
    const { prgKB, chrKB } = resolveSizesKB(values, def);
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

    const { prgKB: prgSizeKB, chrKB: chrSizeKB } = resolveSizesKB(values, def);

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

    return errors.length > 0
      ? { valid: !errors.some((e) => e.severity === "error"), errors }
      : { valid: true };
  }

  buildReadConfig(values: ConfigValues): ReadConfig {
    const mapper = (values.mapper as number) ?? 0;
    const mapperDef = getMapperDef(mapper);
    const { prgKB: prgSizeKB, chrKB: chrSizeKB } = resolveSizesKB(
      values,
      mapperDef,
    );
    // A single opt-in drives both: flag battery SRAM in the header and read it.
    const backupSave = (values.backupSave as boolean) ?? false;
    return {
      systemId: "nes",
      params: {
        mapper,
        prgSizeBytes: prgSizeKB * 1024,
        chrSizeBytes: chrSizeKB * 1024,
        // Mirroring isn't user-set; default per the mapper. It doesn't
        // affect the dumped bytes, and a No-Intro match restamps the
        // canonical header regardless.
        mirroring:
          mapperDef && mapperDef.mirroring !== "selectable"
            ? mapperDef.mirroring
            : "horizontal",
        battery: backupSave,
        backupSave,
        prgRamSizeBytes:
          backupSave && mapperDef?.maxPrgRamKB
            ? mapperDef.maxPrgRamKB * 1024
            : 0,
      },
    };
  }

  buildOutputFile(
    rawData: Uint8Array,
    config: ReadConfig,
    verification?: VerificationResult,
  ): OutputFile {
    const p = config.params;
    const prgBytes = p.prgSizeBytes as number;
    const chrBytes = p.chrSizeBytes as number;
    const mapper = p.mapper as number;
    const mirroring = p.mirroring as NesMirroring;
    const battery = p.battery as boolean;
    const mapperDef = getMapperDef(mapper);

    // Prefer the canonical No-Intro header byte-for-byte when the dump
    // matched a DAT entry: anything the cart can't self-report (TV
    // system, default expansion device, submapper, etc.) lives in
    // those bytes, and copying them keeps the output bit-identical to
    // the DAT entry. Falls back to a computed header when there's no
    // match.
    const canonicalHeader =
      verification?.matched && verification.entry?.header
        ? verification.entry.header
        : null;

    // CHR-RAM: only present if the cart has no CHR-ROM and the mapper
    // def declares a CHR-RAM size (e.g. mapper 470: 8 KiB).
    const chrRamKB = chrBytes === 0 ? (mapperDef?.chrRamKB ?? 0) : 0;
    // The SRAM opt-in is battery-backed (NVRAM) when set; we declare no
    // PRG-RAM when it's unset. A No-Intro match overrides this regardless.
    const prgNvramKB =
      battery && mapperDef?.maxPrgRamKB ? mapperDef.maxPrgRamKB : 0;

    const header = canonicalHeader
      ? Uint8Array.from(canonicalHeader)
      : buildNes2Header({
          prgBytes,
          chrBytes,
          mapper,
          mirroring,
          battery,
          chrRamKB,
          prgRamKB: 0,
          prgNvramKB,
        });

    const output = new Uint8Array(header.length + rawData.length);
    output.set(header, 0);
    output.set(rawData, header.length);

    // Header form for the report: any "NES 2.0" file has byte 7 bit 3
    // set; iNES 1.0 files leave it clear.
    const isNes2 = (header[7] & 0x0c) === 0x08;

    return {
      data: output,
      filename: `dump_mapper${mapper}.nes`,
      mimeType: "application/octet-stream",
      meta: {
        Format: isNes2 ? "NES 2.0" : "iNES 1.0",
        Source: canonicalHeader ? "No-Intro canonical header" : "computed",
        Mapper: `${mapper}: ${mapperDef?.name ?? "Unknown"}`,
        "PRG ROM": `${prgBytes / 1024} KB`,
        "CHR ROM":
          chrBytes > 0
            ? `${chrBytes / 1024} KB`
            : chrRamKB > 0
              ? `None (${chrRamKB} KB CHR-RAM)`
              : "None",
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

  async verify(
    hashes: VerificationHashes,
    db: VerificationDB | null,
    content?: Uint8Array,
  ): Promise<VerificationResult> {
    if (!db) return { matched: false, confidence: "none" };
    const entry = db.lookup(hashes);
    if (!entry) {
      return {
        matched: false,
        confidence: "none",
        suggestions: [
          "Verify mapper and ROM sizes are correct.",
          "Clean the cartridge contacts and re-dump.",
        ],
      };
    }

    // Content-CRC lookup already hit. If the DAT entry carries the
    // canonical header bytes (and original headered SHA-1), promote
    // to a true "exact" match by re-hashing `header || content` and
    // comparing. This is independent of whatever header form our own
    // output file uses, so we can emit NES 2.0 universally without
    // breaking No-Intro matches.
    if (entry.header && entry.sha1 && content) {
      const headered = new Uint8Array(entry.header.length + content.length);
      headered.set(entry.header, 0);
      headered.set(content, entry.header.length);
      const canonicalSha1 = await sha1Hex(headered);
      if (canonicalSha1 === entry.sha1.toLowerCase()) {
        return { matched: true, entry, confidence: "exact" };
      }
      // CRC32 hit but SHA-1 mismatch — almost certainly a subtly bad
      // dump, since real CRC32 collisions are vanishingly rare. Report
      // it as NOT matched (so the UI/report/log don't show a green
      // "Verified" and the canonical header isn't stamped onto a suspect
      // dump) while still surfacing the CRC near-miss as a suggestion.
      return {
        matched: false,
        entry,
        confidence: "size_match",
        suggestions: [
          "Content CRC32 matched but SHA-1 differs — possible bad dump. Re-seat the cart and try again.",
        ],
      };
    }

    // No header on the entry (e.g. non-headered system), or no content
    // passed in. The CRC32 match alone is treated as exact.
    return { matched: true, entry, confidence: "exact" };
  }

  /**
   * Flag PRG banks that came back byte-identical to bank 0. On marginal
   * bank-switching mappers (notably CPLD/clone MMC3 reproduction carts) a
   * dropped bank-select write leaves the power-on default — bank 0 —
   * mapped, so the bank reads as a verbatim copy of bank 0 rather than
   * its real content. This is mapper-agnostic: it inspects the dumped
   * bytes, not the bank-switch path, so it works for any mapper on any
   * device. Run-to-run the affected banks vary, so re-dumping usually
   * recovers them.
   */
  analyzeDump(content: Uint8Array, config: ReadConfig): string[] {
    const PRG_BANK = 8 * 1024;
    const prgBytes = (config.params.prgSizeBytes as number) ?? 0;
    if (prgBytes <= 0 || prgBytes > content.length) return [];

    const numBanks = Math.floor(prgBytes / PRG_BANK);
    if (numBanks < 2) return [];

    const prg = content.subarray(0, prgBytes);
    const bank0 = prg.subarray(0, PRG_BANK);

    // A uniform bank 0 (all one byte — e.g. open-bus 0xFF or 0x00) makes
    // "identical to bank 0" meaningless: that's a blank/dead read, a
    // different signal. Skip rather than cry wolf. Same predicate the
    // in-dump retry uses — see mappers/bank-reliability.
    if (isUniformFill(bank0)) return [];

    let dup = 0;
    for (let i = 1; i < numBanks; i++) {
      const start = i * PRG_BANK;
      if (bytesEqual(prg.subarray(start, start + PRG_BANK), bank0)) dup++;
    }

    if (dup === 0) return [];
    return [
      `${dup} of ${numBanks} PRG banks (8 KiB) are byte-identical to bank 0 — ` +
        "if unexpected, this can indicate a bank-switch latch failure; re-dumping may recover them.",
    ];
  }
}
