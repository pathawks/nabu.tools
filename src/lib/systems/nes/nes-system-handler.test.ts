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
