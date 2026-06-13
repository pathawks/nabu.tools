import { describe, it, expect } from "vitest";
import { NESSystemHandler } from "./nes-system-handler";
import { NES_MAPPER_DB } from "./nes-constants";
import { buildNes2Header } from "./nes-header";
import { crc32, hexStr, formatBytes } from "@/lib/core/hashing";

describe("NES config sizing", () => {
  const handler = new NESSystemHandler();

  // Regression guard: the dump-size estimate must match the bytes the dump
  // actually reads. When the user leaves PRG/CHR at their defaults, both the
  // estimate and buildReadConfig have to fall back to the same size — the
  // largest supported, which is what the config fields show. (Previously the
  // estimate fell back to the smallest size and under-reported the dump.)
  it.each(NES_MAPPER_DB.map((m): [string, number] => [m.name, m.id]))(
    "estimate matches the actual read size for %s defaults",
    (_name, id) => {
      const values = { mapper: id };
      const cfg = handler.buildReadConfig(values);
      const actualBytes =
        16 +
        (cfg.params.prgSizeBytes as number) +
        (cfg.params.chrSizeBytes as number) +
        ((cfg.params.miscSizeBytes as number) ?? 0);
      expect(handler.estimateDumpSize(values)).toBe(actualBytes);
    },
  );

  it("defaults to the largest supported size, not the smallest", () => {
    // NROM supports [16, 32] KB PRG and [0, 8] KB CHR; an unset config should
    // estimate the 32 KB + 8 KB read, not the 16 KB + 0 KB minimum.
    expect(handler.estimateDumpSize({ mapper: 0 })).toBe(16 + (32 + 8) * 1024);
  });
});

describe("NES computed-header PRG-RAM declarations (buildOutputFile)", () => {
  const handler = new NESSystemHandler();

  /** Computed 16-byte header for a mapper + save-opt-in combination. */
  function headerFor(values: Parameters<typeof handler.buildReadConfig>[0]) {
    const config = handler.buildReadConfig(values);
    // No verification entry → the computed (not canonical) header path.
    const out = handler.buildOutputFile(new Uint8Array(16), config);
    return out.data.subarray(0, 16);
  }

  it("declares mapper 268's volatile trampoline RAM without any battery", () => {
    const h = headerFor({ mapper: 268 });
    expect(h[6] & 0x02).toBe(0); // no battery bit
    expect(h[10]).toBe(0x07); // 8 KiB volatile work RAM, no NVRAM
    expect(h[11]).toBe(0x0c); // 256 KiB CHR-RAM
  });

  it("declares NVRAM only when the save opt-in is set (MMC3)", () => {
    const withSave = headerFor({ mapper: 4, backupSave: true });
    expect(withSave[6] & 0x02).toBe(0x02);
    expect(withSave[10]).toBe(0x70); // 8 KiB NVRAM, no volatile RAM

    const withoutSave = headerFor({ mapper: 4 });
    expect(withoutSave[6] & 0x02).toBe(0);
    expect(withoutSave[10]).toBe(0x00); // no PRG-RAM declared at all
  });

  it("offers no battery-SRAM opt-in for the battery-less mapper 268", () => {
    const fields = handler.getConfigFields({ mapper: 268 });
    expect(fields.some((f) => f.key === "backupSave")).toBe(false);
    // ...while a battery-capable mapper does get the checkbox.
    const mmc3Fields = handler.getConfigFields({ mapper: 4 });
    expect(mmc3Fields.some((f) => f.key === "backupSave")).toBe(true);
  });

  it("greys out mappers the connected device declares unsupported", () => {
    const fields = handler.getConfigFields({ mapper: 0 }, undefined, {
      systemId: "nes",
      operations: ["dump_rom"],
      autoDetect: true,
      unsupportedMappers: [268],
    });
    const options = fields.find((f) => f.key === "mapper")?.options ?? [];
    const m268 = options.find((o) => o.value === 268);
    expect(m268?.disabled).toBe(true);
    // A disabled mapper's hint is only the reason — no PRG/CHR sizes.
    expect(m268?.hint).toBe("not dumpable with this device");
    // Enabled mappers still show their sizes.
    expect(options.find((o) => o.value === 0)?.hint).toMatch(/PRG:/);
    // Everything else stays selectable...
    expect(options.filter((o) => o.disabled)).toHaveLength(1);
    // ...and with no capability context nothing is greyed at all.
    const bare = handler.getConfigFields({ mapper: 0 });
    expect(
      (bare.find((f) => f.key === "mapper")?.options ?? []).every(
        (o) => !o.disabled,
      ),
    ).toBe(true);
  });
});

describe("NES dump summary (per-section hashes)", () => {
  const handler = new NESSystemHandler();

  /** Build a headered `.nes` file with distinct fill bytes per region. */
  const makeNesFile = (prgBytes: number, chrBytes: number) => {
    const header = buildNes2Header({
      prgBytes,
      chrBytes,
      mapper: 0,
      mirroring: "horizontal",
      battery: false,
    });
    const prg = new Uint8Array(prgBytes).fill(0xa5);
    const chr = new Uint8Array(chrBytes).fill(0x5a);
    const file = new Uint8Array(header.length + prgBytes + chrBytes);
    file.set(header, 0);
    file.set(prg, header.length);
    file.set(chr, header.length + prgBytes);
    return { file, prg, chr };
  };

  it("reports per-section PRG and CHR size + CRC32 from the header", () => {
    const prgBytes = 32 * 1024;
    const chrBytes = 8 * 1024;
    const { file, prg, chr } = makeNesFile(prgBytes, chrBytes);

    const summary = handler.summarizeDump(file);
    expect(summary).not.toBeNull();
    expect(summary!.columns).toEqual(["Section", "Size", "CRC32"]);
    // Size and CRC32 columns are right-aligned.
    expect(summary!.rightAlignColumns).toEqual([1, 2]);
    // No "Combined" row — the completion screen's main hash block covers it.
    expect(summary!.rows).toEqual([
      ["PRG ROM", formatBytes(prgBytes), hexStr(crc32(prg))],
      ["CHR ROM", formatBytes(chrBytes), hexStr(crc32(chr))],
    ]);
  });

  it("adds a Misc ROM row for a NES 2.0 board with a misc-ROM section", () => {
    const prgBytes = 256 * 1024;
    const chrBytes = 256 * 1024;
    const miscBytes = 64 * 1024; // small stand-in for the 8 MiB sample flash
    const header = buildNes2Header({
      prgBytes,
      chrBytes,
      mapper: 413,
      mirroring: "vertical",
      battery: false,
      miscRoms: 1,
    });
    const prg = new Uint8Array(prgBytes).fill(0xa5);
    const chr = new Uint8Array(chrBytes).fill(0x5a);
    const misc = new Uint8Array(miscBytes).fill(0x3c);
    const file = new Uint8Array(
      header.length + prgBytes + chrBytes + miscBytes,
    );
    file.set(header, 0);
    file.set(prg, header.length);
    file.set(chr, header.length + prgBytes);
    file.set(misc, header.length + prgBytes + chrBytes);

    const summary = handler.summarizeDump(file);
    expect(summary).not.toBeNull();
    expect(summary!.rows).toEqual([
      ["PRG ROM", formatBytes(prgBytes), hexStr(crc32(prg))],
      ["CHR ROM", formatBytes(chrBytes), hexStr(crc32(chr))],
      ["Misc ROM", formatBytes(miscBytes), hexStr(crc32(misc))],
    ]);
  });

  it("returns null for a CHR-RAM cart (no CHR ROM to split out)", () => {
    const { file } = makeNesFile(32 * 1024, 0);
    expect(handler.summarizeDump(file)).toBeNull();
  });

  it("returns null when the header sizes don't cover the file", () => {
    const { file } = makeNesFile(32 * 1024, 8 * 1024);
    // Drop the last CHR byte: declared sizes no longer add up to the file.
    expect(handler.summarizeDump(file.subarray(0, file.length - 1))).toBeNull();
  });

  it("returns null for a non-NES header", () => {
    expect(handler.summarizeDump(new Uint8Array(40))).toBeNull();
  });
});

describe("NES buildOutputFile canonical-header handling", () => {
  const handler = new NESSystemHandler();
  const config = handler.buildReadConfig({
    mapper: 0,
    prgSizeKB: 32,
    chrSizeKB: 8,
  });
  const raw = new Uint8Array(32 * 1024 + 8 * 1024);

  /** A matched verification carrying the given canonical header bytes. */
  const matchedWith = (header: number[]) => ({
    matched: true as const,
    confidence: "exact" as const,
    entry: { name: "Test Entry", status: "verified" as const, header },
  });

  it("emits the verified canonical header byte-for-byte, no warnings", () => {
    // A soft field (PAL TV system → byte 12 = 1) the cart can't self-report:
    // its survival proves the canonical header was used verbatim.
    const canonical = Array.from(
      buildNes2Header({
        prgBytes: 32 * 1024,
        chrBytes: 8 * 1024,
        mapper: 0,
        mirroring: "horizontal",
        battery: false,
        tvSystem: "pal",
      }),
    );

    const out = handler.buildOutputFile(raw, config, matchedWith(canonical));
    expect(Array.from(out.data.subarray(0, 16))).toEqual(canonical);
    expect(out.data[12]).toBe(1);
    expect(out.meta?.Source).toBe("No-Intro canonical header");
    expect(out.warnings ?? []).toEqual([]);
  });

  it("warns but still emits a canonical header that sets the trainer flag", () => {
    const canonical = Array.from(
      buildNes2Header({
        prgBytes: 32 * 1024,
        chrBytes: 8 * 1024,
        mapper: 0,
        mirroring: "horizontal",
        battery: false,
      }),
    );
    canonical[6] |= 0x04; // spurious trainer flag

    const out = handler.buildOutputFile(raw, config, matchedWith(canonical));
    // Trainer bit preserved verbatim — we never rewrite verified bytes.
    expect(out.data[6] & 0x04).toBe(0x04);
    expect(out.meta?.Source).toBe("No-Intro canonical header");
    expect(out.warnings?.some((w) => /trainer/i.test(w))).toBe(true);
  });

  it("warns but still emits a canonical header whose sizes don't fit the dump", () => {
    // Declares 16 KB PRG + 16 KB CHR = 32 KB, but the dump is 40 KB.
    const canonical = Array.from(
      buildNes2Header({
        prgBytes: 16 * 1024,
        chrBytes: 16 * 1024,
        mapper: 0,
        mirroring: "horizontal",
        battery: false,
      }),
    );

    const out = handler.buildOutputFile(raw, config, matchedWith(canonical));
    expect(out.data[4]).toBe(1); // 16 KB PRG declared — emitted verbatim
    expect(out.meta?.Source).toBe("No-Intro canonical header");
    expect(out.warnings?.some((w) => /PRG\+CHR/.test(w))).toBe(true);
  });

  it("uses a computed header with no warnings when nothing matched", () => {
    const out = handler.buildOutputFile(raw, config, {
      matched: false,
      confidence: "none",
    });
    expect(out.meta?.Source).toBe("computed");
    expect(out.warnings ?? []).toEqual([]);
  });

  it("report meta carries the editable header fields, labelled", () => {
    const meta = handler.buildOutputFile(raw, config).meta;
    expect(meta?.["Region/Timing"]).toBe("NTSC");
    expect(meta?.["Console type"]).toBe("NES / Famicom");
    expect(meta?.Mirroring).toBe("Horizontal");
    expect(meta?.Expansion).toBe("Unspecified");
    expect(meta?.Submapper).toBe("0");
  });
});

describe("NES header editor (getHeaderFields / applyHeaderOverrides)", () => {
  const handler = new NESSystemHandler();

  /** A computed-header NROM file (32 KB PRG + 8 KB CHR), patterned content. */
  const nromFile = () => {
    const config = handler.buildReadConfig({
      mapper: 0,
      prgSizeKB: 32,
      chrSizeKB: 8,
    });
    const raw = new Uint8Array(32 * 1024 + 8 * 1024).map((_, i) => (i * 3) & 0xff);
    return handler.buildOutputFile(raw, config).data;
  };

  const byKey = (fields: ReturnType<typeof handler.getHeaderFields>) =>
    Object.fromEntries(fields.map((f) => [f.key, f]));

  it("getHeaderFields reflects the header's defaults", () => {
    const f = byKey(handler.getHeaderFields(nromFile(), {}));
    expect(f.tvSystem.value).toBe("ntsc");
    expect(f.consoleType.value).toBe(0);
    expect(f.mirroring.value).toBe("horizontal");
    expect(f.expansionDevice.value).toBe(0);
    expect(f.submapper.value).toBe(0);
  });

  it("getHeaderFields lets overrides win over the parsed defaults", () => {
    const f = byKey(
      handler.getHeaderFields(nromFile(), { tvSystem: "pal", submapper: 7 }),
    );
    expect(f.tvSystem.value).toBe("pal");
    expect(f.submapper.value).toBe(7);
    expect(f.mirroring.value).toBe("horizontal"); // untouched default
  });

  it("notes mapper-controlled mirroring in the field help text", () => {
    // MMC1 (mapper 1) controls mirroring at runtime.
    const config = handler.buildReadConfig({
      mapper: 1,
      prgSizeKB: 32,
      chrSizeKB: 8,
    });
    const raw = new Uint8Array(32 * 1024 + 8 * 1024);
    const file = handler.buildOutputFile(raw, config).data;
    const f = byKey(handler.getHeaderFields(file, {}));
    expect(f.mirroring.helpText).toMatch(/runtime/i);
  });

  it("applyHeaderOverrides rewrites the header, leaving content and section hashes intact", () => {
    const file = nromFile();
    const before = handler.summarizeDump(file);

    const edited = handler.applyHeaderOverrides(file, {
      tvSystem: "pal",
      mirroring: "vertical",
      expansionDevice: 8,
    });

    // Header reflects the edits.
    expect(edited[12] & 0x03).toBe(1);
    expect(edited[6] & 0x01).toBe(1);
    expect(edited[15] & 0x3f).toBe(8);
    // Content (bytes 16+) is byte-identical, so the section breakdown is too.
    expect(Array.from(edited.subarray(16))).toEqual(
      Array.from(file.subarray(16)),
    );
    expect(handler.summarizeDump(edited)).toEqual(before);
  });

  it("applies cleanly to a CHR-RAM cart (no CHR ROM)", () => {
    const config = handler.buildReadConfig({
      mapper: 2,
      prgSizeKB: 64,
      chrSizeKB: 0,
    });
    const raw = new Uint8Array(64 * 1024);
    const file = handler.buildOutputFile(raw, config).data;

    const edited = handler.applyHeaderOverrides(file, { mirroring: "vertical" });
    expect(edited[6] & 0x01).toBe(1);
    expect(edited.length).toBe(file.length);
    expect(handler.getHeaderFields(file, {})).toHaveLength(5);
  });

  it("headerMeta reflects an edited header (so the report matches the file)", () => {
    const edited = handler.applyHeaderOverrides(nromFile(), {
      tvSystem: "pal",
      mirroring: "vertical",
      expansionDevice: 8,
    });
    const meta = handler.headerMeta(edited);
    expect(meta["Region/Timing"]).toBe("PAL");
    expect(meta.Mirroring).toBe("Vertical");
    expect(meta.Expansion).toBe("Zapper");
  });
});

describe("NES miscellaneous-ROM area (mapper 413)", () => {
  const handler = new NESSystemHandler();

  it("carries the fixed 8 MiB misc section through config, estimate, and header", () => {
    const cfg = handler.buildReadConfig({ mapper: 413 });
    expect(cfg.params.miscSizeBytes).toBe(8192 * 1024);
    expect(cfg.params.mirroring).toBe("vertical");
    expect(handler.estimateDumpSize({ mapper: 413 })).toBe(
      16 + (256 + 256 + 8192) * 1024,
    );
    const out = handler.buildOutputFile(new Uint8Array(16), cfg);
    expect(out.data[14]).toBe(1); // header byte 14: one misc ROM follows CHR
    expect(out.meta?.["Misc ROM"]).toBe("8192 KB");
  });

  it("declares no misc ROM for ordinary mappers", () => {
    const cfg = handler.buildReadConfig({ mapper: 4 });
    expect(cfg.params.miscSizeBytes).toBe(0);
    const out = handler.buildOutputFile(new Uint8Array(16), cfg);
    expect(out.data[14]).toBe(0);
    expect(out.meta?.["Misc ROM"]).toBeUndefined();
  });
});

describe("NES misc-ROM dump analysis (analyzeDump)", () => {
  const handler = new NESSystemHandler();
  const cfg = handler.buildReadConfig({ mapper: 413 });
  const contentBytes = (512 + 8192) * 1024; // PRG + CHR + misc, headerless

  it("flags a miscellaneous ROM that read back as one uniform byte", () => {
    const content = new Uint8Array(contentBytes); // misc = all 0x00
    const notes = handler.analyzeDump(content, cfg);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/miscellaneous ROM/);
    expect(notes[0]).toMatch(/0x00/);
  });

  it("stays quiet for non-uniform misc data", () => {
    const content = new Uint8Array(contentBytes);
    content[512 * 1024 + 12345] = 0xa7; // one byte of variation in misc
    expect(handler.analyzeDump(content, cfg)).toHaveLength(0);
  });

  it("ignores mappers without a misc section", () => {
    const mmc3Cfg = handler.buildReadConfig({ mapper: 4 });
    const content = new Uint8Array(
      (mmc3Cfg.params.prgSizeBytes as number) +
        (mmc3Cfg.params.chrSizeBytes as number),
    );
    expect(handler.analyzeDump(content, mmc3Cfg)).toHaveLength(0);
  });
});
