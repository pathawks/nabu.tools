import { describe, it, expect } from "vitest";
import {
  decodeSpiCapacityByte,
  identifyByJedec,
  KNOWN_JEDEC_MANUFACTURERS,
  parseProbeResponse,
  SAVE_CHIPS,
} from "./sms4-chip-database";

describe("decodeSpiCapacityByte", () => {
  it("decodes the documented Numonyx capacity ladder", () => {
    expect(decodeSpiCapacityByte(0x11)).toBe(128 * 1024);
    expect(decodeSpiCapacityByte(0x12)).toBe(256 * 1024);
    expect(decodeSpiCapacityByte(0x13)).toBe(512 * 1024);
    expect(decodeSpiCapacityByte(0x14)).toBe(1024 * 1024);
    expect(decodeSpiCapacityByte(0x15)).toBe(2 * 1024 * 1024);
    expect(decodeSpiCapacityByte(0x16)).toBe(4 * 1024 * 1024);
    expect(decodeSpiCapacityByte(0x17)).toBe(8 * 1024 * 1024);
    expect(decodeSpiCapacityByte(0x18)).toBe(16 * 1024 * 1024);
  });

  it("returns 0 below 0x11 — there's no NDS save chip that small", () => {
    expect(decodeSpiCapacityByte(0x00)).toBe(0);
    expect(decodeSpiCapacityByte(0x10)).toBe(0);
  });

  it("returns 0 above 0x18 — beyond that range 1<<n overflows JS's 32-bit shift", () => {
    expect(decodeSpiCapacityByte(0x19)).toBe(0);
    expect(decodeSpiCapacityByte(0xff)).toBe(0);
  });
});

describe("identifyByJedec — exact match", () => {
  it("identifies M25P80 by full JEDEC ID", () => {
    const result = identifyByJedec([0x20, 0x20, 0x14], 0x03);
    expect(result.source).toBe("exact");
    expect(result.name).toBe("M25P80");
    expect(result.kind).toBe("FLASH");
    expect(result.sizeBytes).toBe(1024 * 1024);
  });

  it("identifies a M45PE family chip by exact JEDEC ID", () => {
    const result = identifyByJedec([0x20, 0x40, 0x13], 0x03);
    expect(result.source).toBe("exact");
    expect(result.name).toBe("M45PE40");
    expect(result.sizeBytes).toBe(512 * 1024);
  });

  it("identifies an LE25FW chip by exact JEDEC ID", () => {
    const result = identifyByJedec([0x62, 0x11, 0x00], 0x03);
    expect(result.source).toBe("exact");
    expect(result.name).toBe("LE25FW403");
    expect(result.flag).toBe(0x0f);
  });
});

describe("identifyByJedec — family fallback", () => {
  it("falls back to generic Numonyx for an undocumented device-type 0x50", () => {
    // 0x20 0x50 0x12 isn't in SAVE_CHIPS, but manufacturer 0x20 + a
    // capacity-decodable byte 2 should match the generic Numonyx family.
    const result = identifyByJedec([0x20, 0x50, 0x12], 0x03);
    expect(result.source).toBe("family");
    expect(result.kind).toBe("FLASH");
    expect(result.sizeBytes).toBe(256 * 1024);
    expect(result.flag).toBe(0x07);
  });
});

describe("identifyByJedec — EEPROM family from family-code byte", () => {
  it("classifies family-code 0x01 as a tiny M95 EEPROM (size pending wrap-probe)", () => {
    const result = identifyByJedec([0xff, 0xff, 0xff], 0x01);
    expect(result.source).toBe("eeprom-family");
    expect(result.kind).toBe("EEPROM");
    expect(result.sizeBytes).toBe(0);
  });

  it("classifies family-code 0x02 as a medium M95 EEPROM (size pending wrap-probe)", () => {
    const result = identifyByJedec([0xff, 0xff, 0xff], 0x02);
    expect(result.source).toBe("eeprom-family");
    expect(result.kind).toBe("EEPROM");
    expect(result.sizeBytes).toBe(0);
  });
});

describe("identifyByJedec — unknown fallback", () => {
  it("returns 'unknown' when neither JEDEC nor family code matches anything", () => {
    const result = identifyByJedec([0xff, 0xff, 0xff], 0x00);
    expect(result.source).toBe("unknown");
    expect(result.kind).toBe("FLASH");
    expect(result.sizeBytes).toBe(0);
  });
});

describe("parseProbeResponse", () => {
  it("extracts JEDEC + familyCode and reports consistency when the two reads agree", () => {
    // 9-byte response: bytes 0..2 JEDEC, 3..4 padding, 5..7 JEDEC repeat, 8 family.
    const raw = new Uint8Array([0x20, 0x50, 0x12, 0x00, 0x00, 0x20, 0x50, 0x12, 0x03]);
    const parsed = parseProbeResponse(raw);
    expect(parsed.jedec).toEqual([0x20, 0x50, 0x12]);
    expect(parsed.familyCode).toBe(0x03);
    expect(parsed.jedecConsistent).toBe(true);
  });

  it("flags inconsistency when the two firmware JEDEC reads disagree", () => {
    const raw = new Uint8Array([0x20, 0x50, 0x12, 0x00, 0x00, 0x20, 0x50, 0x13, 0x03]);
    const parsed = parseProbeResponse(raw);
    expect(parsed.jedecConsistent).toBe(false);
  });

  it("sources jedec from the second read (bytes 5..7), not the first", () => {
    // On DS carts with an infrared transceiver sharing the auxiliary-SPI
    // bus, the IR module corrupts the firmware's first JEDEC RDID read
    // but not the second — the firmware's inter-transaction CS handling
    // quiets the IR chip before the re-read. Observed on a Sanyo
    // LE25FW403 IR-equipped cart returning `4f 80 00 01 00 62 11 00 03`:
    // bytes 0..2 garbage, bytes 5..7 the real `62 11 00`.
    const raw = new Uint8Array([0x4f, 0x80, 0x00, 0x01, 0x00, 0x62, 0x11, 0x00, 0x03]);
    const parsed = parseProbeResponse(raw);
    expect(parsed.jedec).toEqual([0x62, 0x11, 0x00]);
    expect(parsed.familyCode).toBe(0x03);
    expect(parsed.jedecConsistent).toBe(false);
  });

  it("doesn't crash on a short response — missing bytes read as 0", () => {
    const parsed = parseProbeResponse(new Uint8Array([0x20, 0x50, 0x12]));
    expect(parsed.jedec).toEqual([0x00, 0x00, 0x00]);
    expect(parsed.familyCode).toBe(0);
    expect(parsed.jedecConsistent).toBe(false);
  });
});

describe("KNOWN_JEDEC_MANUFACTURERS", () => {
  it("includes the manufacturers actually present in SAVE_CHIPS", () => {
    const mfrsInDb = new Set(
      SAVE_CHIPS.filter((c) => c.jedecId).map((c) => c.jedecId![0]),
    );
    for (const m of mfrsInDb) {
      expect(KNOWN_JEDEC_MANUFACTURERS.has(m)).toBe(true);
    }
  });
});

describe("parseProbeResponse → identifyByJedec end-to-end", () => {
  it("identifies an IR-cart probe response as the real Sanyo chip", () => {
    // Full pipeline: a Pokémon HG/SS-class cart's `60 A0` response goes
    // through parseProbeResponse → identifyByJedec → "LE25FW403", not
    // "Unknown chip from the IR-module garbage in bytes 0..2".
    const raw = new Uint8Array([0x4f, 0x80, 0x00, 0x01, 0x00, 0x62, 0x11, 0x00, 0x03]);
    const parsed = parseProbeResponse(raw);
    const chip = identifyByJedec(parsed.jedec, parsed.familyCode);
    expect(chip.source).toBe("exact");
    expect(chip.name).toBe("LE25FW403");
    expect(chip.kind).toBe("FLASH");
    expect(chip.sizeBytes).toBe(512 * 1024);
    expect(chip.flag).toBe(0x0f);
  });
});

describe("SAVE_CHIPS table sanity", () => {
  it("every entry has a 14-byte cmdTable", () => {
    for (const c of SAVE_CHIPS) {
      expect(c.cmdTable.length).toBe(14);
    }
  });

  it("every FLASH entry has a 3-byte JEDEC ID; M95 EEPROMs do not", () => {
    for (const c of SAVE_CHIPS) {
      if (c.name.startsWith("M95")) {
        expect(c.jedecId).toBeUndefined();
      } else {
        expect(c.jedecId?.length).toBe(3);
      }
    }
  });
});
