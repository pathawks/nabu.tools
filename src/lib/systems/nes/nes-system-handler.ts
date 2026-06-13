import type {
  SystemHandler,
  ConfigValues,
  CartridgeInfo,
  DeviceCapability,
  ResolvedConfigField,
  ValidationResult,
  ValidationError,
  ReadConfig,
  OutputFile,
  VerificationHashes,
  VerificationDB,
  VerificationResult,
  DumpSummary,
  DumpSummaryCell,
  ConfigOption,
} from "@/lib/types";
import {
  crc32,
  sha1Hex,
  sha256Hex,
  hexStr,
  formatBytes,
} from "@/lib/core/hashing";
import {
  NES_MAPPER_DB,
  getMapperDef,
  coerceToNearest,
  NES_TIMING_OPTIONS,
  NES_CONSOLE_TYPE_OPTIONS,
  NES_MIRRORING_OPTIONS,
  NES_EXPANSION_DEVICE_OPTIONS,
  NES_SUBMAPPER_OPTIONS,
} from "./nes-constants";
import {
  buildNes2Header,
  parseEditableHeaderFields,
  applyEditableHeaderFields,
  type NesMirroring,
  type EditableHeaderFields,
} from "./nes-header";
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

/**
 * Read the PRG/CHR ROM region sizes (in bytes) from a 16-byte iNES / NES 2.0
 * header, plus the offset at which ROM data begins. Returns null for a
 * non-NES header or the NES 2.0 exponent-multiplier size form — our dumps
 * never emit the latter, and decoding it here would add untested complexity
 * for no cartridge in scope.
 */
function parseNesRomLayout(
  data: Uint8Array,
): { dataStart: number; prgBytes: number; chrBytes: number } | null {
  // Magic "NES\x1A".
  if (
    data.length < 16 ||
    data[0] !== 0x4e ||
    data[1] !== 0x45 ||
    data[2] !== 0x53 ||
    data[3] !== 0x1a
  )
    return null;

  const isNes2 = (data[7] & 0x0c) === 0x08;
  const prgMsb = isNes2 ? data[9] & 0x0f : 0;
  const chrMsb = isNes2 ? (data[9] >> 4) & 0x0f : 0;
  // A 0xF MSB nibble selects the NES 2.0 exponent-multiplier size form — a
  // valid encoding we don't implement (no cart in scope reaches the sizes
  // that need it). Bail rather than mis-read the bytes as a linear size.
  if (prgMsb === 0x0f || chrMsb === 0x0f) return null;

  // A trainer (flags6 bit 2) inserts 512 bytes between header and PRG.
  const trainer = (data[6] & 0x04) !== 0 ? 512 : 0;
  return {
    dataStart: 16 + trainer,
    prgBytes: ((prgMsb << 8) | data[4]) * 16384,
    chrBytes: ((chrMsb << 8) | data[5]) * 8192,
  };
}

/**
 * Sanity-check a verified No-Intro canonical header we're about to emit
 * verbatim against the dump it will wrap. The match was verified by SHA-1
 * over `header || content`, so the header IS the verified canonical form —
 * we emit it as-is regardless. But a header that can't describe the bytes
 * we're attaching (a trainer flag a cart dump can never satisfy, or PRG/CHR
 * sizes that don't sum to the content) is a malformed DAT entry worth
 * flagging. Returns human-readable warnings; an empty array means it checks
 * out. These can only fire on a genuinely corrupt entry — a well-formed
 * canonical header always describes the content that verified against it.
 */
function canonicalHeaderWarnings(
  header: Uint8Array,
  contentLength: number,
): string[] {
  const warnings: string[] = [];

  if ((header[6] & 0x04) !== 0) {
    warnings.push(
      "Verified No-Intro header sets the trainer flag, but a cartridge dump never contains a trainer. " +
        "Emitting it as verified — the DAT entry's header looks malformed.",
    );
  }

  const layout = parseNesRomLayout(header);
  if (!layout) {
    warnings.push(
      "Verified No-Intro header's PRG/CHR size fields couldn't be parsed. " +
        "Emitting it as verified — the DAT entry's header looks malformed.",
    );
  } else if (layout.prgBytes + layout.chrBytes !== contentLength) {
    warnings.push(
      `Verified No-Intro header declares ${formatBytes(layout.prgBytes + layout.chrBytes)} of PRG+CHR, ` +
        `but the dump is ${formatBytes(contentLength)}. Emitting it as verified — the DAT entry's header looks malformed.`,
    );
  }

  return warnings;
}

/**
 * Human-readable display values for the editable NES 2.0 header fields, read
 * back from a header's bytes and labelled via the curated option lists. Shared
 * by buildOutputFile (initial dump) and the post-dump header editor (after an
 * edit) so the dump report always documents the header that was actually
 * emitted — not a value baked in from the original config. Unknown raw values
 * (e.g. an expansion device outside the curated shortlist) fall back to their
 * number.
 */
function nesHeaderMeta(header: Uint8Array): Record<string, string> {
  const f = parseEditableHeaderFields(header);
  const labelFor = (options: ConfigOption[], value: string | number) =>
    options.find((o) => o.value === value)?.label ?? String(value);
  return {
    "Region/Timing": labelFor(NES_TIMING_OPTIONS, f.tvSystem),
    "Console type": labelFor(NES_CONSOLE_TYPE_OPTIONS, f.consoleType),
    Mirroring: labelFor(NES_MIRRORING_OPTIONS, f.mirroring),
    Expansion: labelFor(NES_EXPANSION_DEVICE_OPTIONS, f.expansionDevice),
    Submapper: labelFor(NES_SUBMAPPER_OPTIONS, f.submapper),
  };
}

export class NESSystemHandler implements SystemHandler {
  readonly systemId = "nes" as const;
  readonly displayName = "NES / Famicom";
  readonly fileExtension = ".nes";

  getConfigFields(
    currentValues: ConfigValues,
    autoDetected?: CartridgeInfo,
    capability?: DeviceCapability,
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
      options: NES_MAPPER_DB.map((m) => {
        // Greyed out when the connected device declares it can't drive
        // this mapper (the driver also pre-flight-rejects it at dump time).
        const disabled =
          capability?.unsupportedMappers?.includes(m.id) ?? false;
        return {
          value: m.id,
          label: `${m.id}: ${m.name}`,
          // A disabled mapper can't be dumped here, so its sizes are
          // irrelevant noise — show only why it's unavailable.
          hint: disabled
            ? "not dumpable with this device"
            : `PRG: ${m.prgSizesKB.join("/")}KB` +
              (m.chrSizesKB.some((c) => c > 0)
                ? ` · CHR: ${m.chrSizesKB.filter((c) => c > 0).join("/")}KB`
                : " · CHR RAM") +
              (m.miscRomKB ? ` · Misc ROM: ${m.miscRomKB / 1024}MB` : ""),
          disabled,
        };
      }),
      group: "cartridge",
      order: 0,
      helpText: autoDetected?.mapper
        ? `Auto-detected: ${autoDetected.mapper.name}`
        : "Look up your game's mapper and ROM sizes on nescartdb.com",
      warning: mapperDef?.warning,
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
      autoDetected: false,
      options: chrRamOnly
        ? [{ value: 0, label: "CHR-RAM" }]
        : validChrSizes.map((s) => ({
            value: s,
            label: s === 0 ? "CHR-RAM" : `${s} KB`,
            hint: s === 0 ? "Cart uses CHR RAM" : `${s / 8} x 8KB banks`,
          })),
      dependsOn: ["mapper"],
      group: "cartridge",
      order: 2,
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
    return 16 + (prgKB + chrKB + (def?.miscRomKB ?? 0)) * 1024;
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
        // Fixed per board (never user-selectable); 0 for all but
        // mapper 413's sample flash.
        miscSizeBytes: (mapperDef?.miscRomKB ?? 0) * 1024,
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
    const miscBytes = (p.miscSizeBytes as number) ?? 0;
    const mapper = p.mapper as number;
    const mirroring = p.mirroring as NesMirroring;
    const battery = p.battery as boolean;
    const mapperDef = getMapperDef(mapper);

    // Prefer the canonical No-Intro header byte-for-byte when the dump
    // matched a DAT entry: anything the cart can't self-report (TV
    // system, default expansion device, submapper, etc.) lives in those
    // bytes, and the match is verified by SHA-1 over `header || content`
    // (see verify()), so emitting it keeps the output bit-identical to the
    // verified entry. We emit it as-is even if the header looks unusual —
    // an inconsistent header is flagged via canonicalHeaderWarnings below,
    // never rewritten. Falls back to a computed header when there's no
    // match.
    const canonicalHeader =
      verification?.matched && verification.entry?.header
        ? verification.entry.header
        : null;

    // CHR-RAM: only present if the cart has no CHR-ROM and the mapper
    // def declares a CHR-RAM size (e.g. mapper 470: 8 KiB).
    const chrRamKB = chrBytes === 0 ? (mapperDef?.chrRamKB ?? 0) : 0;
    // PRG-RAM, two independent declarations mirroring the two DB fields:
    // volatile work RAM (`prgRamKB`, byte 10 low nibble) is a property of
    // the board and is declared whether or not a save was read — carts
    // like the mapper 268 multicarts need it for games to boot in
    // emulators; battery NVRAM (`maxPrgRamKB`, high nibble) is declared
    // only when the save opt-in is set. A No-Intro match overrides all of
    // this regardless.
    const prgRamKB = mapperDef?.prgRamKB ?? 0;
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
          prgRamKB,
          prgNvramKB,
          miscRoms: miscBytes > 0 ? 1 : 0,
        });

    const output = new Uint8Array(header.length + rawData.length);
    output.set(header, 0);
    output.set(rawData, header.length);

    // Header form for the report: any "NES 2.0" file has byte 7 bit 3
    // set; iNES 1.0 files leave it clear.
    const isNes2 = (header[7] & 0x0c) === 0x08;

    // Emitted the verified canonical header? Flag it if it can't describe
    // the bytes we just attached (corrupt DAT entry) — without rewriting it.
    const warnings = canonicalHeader
      ? canonicalHeaderWarnings(header, rawData.length)
      : [];

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
        ...(miscBytes > 0 ? { "Misc ROM": `${miscBytes / 1024} KB` } : {}),
        // Region/timing, console, mirroring, expansion device and submapper —
        // read from the header we actually emit, so the report stays truthful
        // even after the user edits them on the completion screen.
        ...nesHeaderMeta(header),
        Battery: battery ? "Yes" : "No",
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async computeHashes(rawData: Uint8Array): Promise<VerificationHashes> {
    // No-Intro NES DATs are "Headered" — hash includes the 16-byte iNES header.
    // rawData here is the headerless content in NES 2.0 file order —
    // PRG+CHR, plus the miscellaneous-ROM area when the board has one
    // (mapper 413) — and buildOutputFile prepends the header. DAT entries
    // hash the whole headered file, so misc data belongs in the content
    // hash; verify() reconstructs header+content for the exact match.
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
   * Per-section breakdown of a finished dump: the PRG ROM, the CHR ROM, and
   * (for NES 2.0 boards that carry one) the miscellaneous-ROM section, each
   * with its size and CRC32 — the chip-level view NESCartDB / No-Intro list.
   * The combined size + hashes already appear in the completion screen's main
   * hash block, so they aren't repeated here. `rawData` is the output `.nes`
   * file (16-byte header + PRG + CHR [+ misc]), so its iNES header is
   * authoritative for where each region starts.
   *
   * Returns null when there's nothing to break down: a malformed header, a
   * CHR-RAM cart with no CHR ROM (PRG would just equal the whole ROM), or a
   * header whose declared sizes don't add up to the file — in which case any
   * split would be a guess.
   */
  summarizeDump(rawData: Uint8Array): DumpSummary | null {
    const layout = parseNesRomLayout(rawData);
    if (!layout) return null;
    const { dataStart, prgBytes, chrBytes } = layout;

    // No CHR ROM means the cart uses CHR-RAM (which we don't dump), so the
    // file is PRG only — a single PRG row would just restate the combined ROM
    // shown above. Nothing to add.
    if (chrBytes <= 0) return null;

    // A NES 2.0 board may append a miscellaneous-ROM section after CHR
    // (header byte 14 counts it; mapper 413's 8 MiB sample flash is the one
    // such board) — whatever trails PRG+CHR is that section.
    const isNes2 = (rawData[7] & 0x0c) === 0x08;
    const trailing = rawData.length - (dataStart + prgBytes + chrBytes);
    const miscBytes = isNes2 && (rawData[14] & 0x03) > 0 ? trailing : 0;

    // The declared regions must exactly cover the file (after accounting for
    // any misc section); if they don't, the header disagrees with the dumped
    // bytes and any split would mislead.
    if (dataStart + prgBytes + chrBytes + miscBytes !== rawData.length) {
      return null;
    }

    const prg = rawData.subarray(dataStart, dataStart + prgBytes);
    const chr = rawData.subarray(
      dataStart + prgBytes,
      dataStart + prgBytes + chrBytes,
    );

    const sectionRow = (
      label: string,
      bytes: Uint8Array,
    ): DumpSummaryCell[] => [
      label,
      formatBytes(bytes.length),
      hexStr(crc32(bytes)),
    ];

    const rows = [sectionRow("PRG ROM", prg), sectionRow("CHR ROM", chr)];
    if (miscBytes > 0) {
      rows.push(
        sectionRow("Misc ROM", rawData.subarray(dataStart + prgBytes + chrBytes)),
      );
    }

    return {
      title: "ROM sections",
      columns: ["Section", "Size", "CRC32"],
      monoColumns: [1, 2],
      rightAlignColumns: [1, 2],
      rows,
    };
  }

  /**
   * Editable NES 2.0 header fields for an unverified dump — region/timing,
   * console type, mirroring, default expansion device, submapper. Each value
   * defaults to whatever the produced header already carries (the sensible
   * defaults `buildOutputFile` baked in), overlaid with the user's edits.
   * `file` is the output `.nes` bytes; only its 16-byte header is read.
   */
  getHeaderFields(file: Uint8Array, overrides: ConfigValues): ResolvedConfigField[] {
    if (file.length < 16) return [];
    const parsed = parseEditableHeaderFields(file);

    // Mapper number from the header — only to note runtime-controlled mirroring.
    const mapper = (file[6] >> 4) | (file[7] & 0xf0) | ((file[8] & 0x0f) << 8);
    const mapperControlsMirroring =
      getMapperDef(mapper)?.mirroring === "mapper_controlled";

    const value = (key: string, fallback: string | number) =>
      overrides[key] ?? fallback;

    return [
      {
        key: "tvSystem",
        label: "Region / Timing",
        type: "select",
        value: value("tvSystem", parsed.tvSystem),
        options: NES_TIMING_OPTIONS,
        group: "header",
        order: 0,
      },
      {
        key: "consoleType",
        label: "Console type",
        type: "select",
        value: value("consoleType", parsed.consoleType),
        options: NES_CONSOLE_TYPE_OPTIONS,
        group: "header",
        order: 1,
      },
      {
        key: "mirroring",
        label: "Mirroring",
        type: "select",
        value: value("mirroring", parsed.mirroring),
        options: NES_MIRRORING_OPTIONS,
        group: "header",
        order: 2,
        helpText: mapperControlsMirroring
          ? "This mapper sets mirroring at runtime; the header value is informational."
          : undefined,
      },
      {
        key: "expansionDevice",
        label: "Default expansion device",
        type: "select",
        value: value("expansionDevice", parsed.expansionDevice),
        options: NES_EXPANSION_DEVICE_OPTIONS,
        group: "header",
        order: 3,
      },
      {
        key: "submapper",
        label: "Submapper",
        type: "select",
        value: value("submapper", parsed.submapper),
        options: NES_SUBMAPPER_OPTIONS,
        group: "header",
        order: 4,
      },
    ];
  }

  /**
   * Apply header-field overrides to a finished dump, rewriting only the header
   * bytes the editor exposes and leaving the PRG/CHR content (and its hashes)
   * untouched. Unset fields keep the file's current values.
   */
  applyHeaderOverrides(file: Uint8Array, overrides: ConfigValues): Uint8Array {
    const fields: Partial<EditableHeaderFields> = {};
    if (overrides.tvSystem !== undefined)
      fields.tvSystem = overrides.tvSystem as EditableHeaderFields["tvSystem"];
    if (overrides.consoleType !== undefined)
      fields.consoleType = overrides.consoleType as number;
    if (overrides.mirroring !== undefined)
      fields.mirroring = overrides.mirroring as NesMirroring;
    if (overrides.expansionDevice !== undefined)
      fields.expansionDevice = overrides.expansionDevice as number;
    if (overrides.submapper !== undefined)
      fields.submapper = overrides.submapper as number;
    return applyEditableHeaderFields(file, fields);
  }

  /**
   * Human-readable display values for the editable header fields of a finished
   * dump, keyed for the report's "Dumping Settings" section. The wizard merges
   * this over the output's original meta after a header edit so the saved
   * report matches the saved bytes.
   */
  headerMeta(file: Uint8Array): Record<string, string> {
    if (file.length < 16) return {};
    return nesHeaderMeta(file);
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
    const notes = this.analyzeMiscRom(content, config);

    const PRG_BANK = 8 * 1024;
    const prgBytes = (config.params.prgSizeBytes as number) ?? 0;
    if (prgBytes <= 0 || prgBytes > content.length) return notes;

    const numBanks = Math.floor(prgBytes / PRG_BANK);
    if (numBanks < 2) return notes;

    const prg = content.subarray(0, prgBytes);
    const bank0 = prg.subarray(0, PRG_BANK);

    // A uniform bank 0 (all one byte — e.g. open-bus 0xFF or 0x00) makes
    // "identical to bank 0" meaningless: that's a blank/dead read, a
    // different signal. Skip rather than cry wolf. Same predicate the
    // in-dump retry uses — see mappers/bank-reliability.
    if (isUniformFill(bank0)) return notes;

    let dup = 0;
    for (let i = 1; i < numBanks; i++) {
      const start = i * PRG_BANK;
      if (bytesEqual(prg.subarray(start, start + PRG_BANK), bank0)) dup++;
    }

    if (dup === 0) return notes;
    return [
      ...notes,
      `${dup} of ${numBanks} PRG banks (8 KiB) are byte-identical to bank 0 — ` +
        "if unexpected, this can indicate a bank-switch latch failure; re-dumping may recover them.",
    ];
  }

  /**
   * Flag a miscellaneous-ROM area that came back as one uniform byte.
   * The in-dump port probe (see mappers/batmap) cannot tell a dead
   * data port from genuinely uniform stream data — both satisfy its
   * overlap check — so this is the post-dump half of that trade-off:
   * the one board we dump misc ROM from carries minutes of speech, and
   * a whole section of a single byte value is a dead/misread port, not
   * plausible content. Trailing erased-flash fill is normal; an entire
   * uniform section is the signal.
   */
  private analyzeMiscRom(content: Uint8Array, config: ReadConfig): string[] {
    const prgBytes = (config.params.prgSizeBytes as number) ?? 0;
    const chrBytes = (config.params.chrSizeBytes as number) ?? 0;
    const miscBytes = (config.params.miscSizeBytes as number) ?? 0;
    const start = prgBytes + chrBytes;
    if (miscBytes <= 0 || start + miscBytes > content.length) return [];

    const misc = content.subarray(start, start + miscBytes);
    if (!isUniformFill(misc)) return [];
    return [
      `The ${miscBytes / 1024} KB miscellaneous ROM read back as a single ` +
        `repeated byte (0x${misc[0].toString(16).padStart(2, "0").toUpperCase()}) — ` +
        "that is a dead or misread data port, not plausible sample data; re-seat the cart and re-dump.",
    ];
  }
}
