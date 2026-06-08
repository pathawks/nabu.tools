import { describe, it, expect } from "vitest";
import { NESSystemHandler } from "./nes-system-handler";
import { NES_MAPPER_DB } from "./nes-constants";

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
        (cfg.params.chrSizeBytes as number);
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
