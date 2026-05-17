import { describe, it, expect } from "vitest";
import {
  NoIntroVerificationDB,
  matchesSystemName,
  type NoIntroDat,
  type NoIntroEntry,
} from "./nointro";

function entry(name: string, serial: string): NoIntroEntry {
  return {
    gameName: name,
    romName: `${name}.nds`,
    size: 0,
    crc32: "",
    sha1: "",
    serial,
  };
}

function db(...entries: NoIntroEntry[]): NoIntroVerificationDB {
  const dat: NoIntroDat = {
    systemName: "Test",
    version: "1",
    entries,
  };
  return new NoIntroVerificationDB(dat, "nds_save");
}

describe("NoIntroVerificationDB.lookupBySerial", () => {
  it("returns the retail entry when it is the only one", () => {
    const d = db(entry("Game (USA)", "ABCE"));
    expect(d.lookupBySerial("ABCE")?.name).toBe("Game (USA)");
  });

  it("returns null when no entry matches the serial", () => {
    const d = db(entry("Game (USA)", "ABCE"));
    expect(d.lookupBySerial("ZZZE")).toBeNull();
  });

  it("prefers retail over (Beta) regardless of insertion order", () => {
    const retail = entry("Game (USA)", "ABCE");
    const beta = entry("Game (USA) (Beta)", "ABCE");

    expect(db(retail, beta).lookupBySerial("ABCE")?.name).toBe("Game (USA)");
    expect(db(beta, retail).lookupBySerial("ABCE")?.name).toBe("Game (USA)");
  });

  it.each([
    ["(Proto)", "Game (USA) (Proto)"],
    ["(Prototype)", "Game (USA) (Prototype)"],
    ["(Demo)", "Game (USA) (Demo)"],
    ["(Sample)", "Game (USA) (Sample)"],
    ["(Unl)", "Game (USA) (Unl)"],
    ["(Beta 2)", "Game (USA) (Beta 2)"],
    ["(beta)", "Game (USA) (beta)"], // case-insensitive
  ])("treats %s as prerelease (loses to retail)", (_label, prereleaseName) => {
    const retail = entry("Game (USA)", "ABCE");
    const prerelease = entry(prereleaseName, "ABCE");
    expect(db(prerelease, retail).lookupBySerial("ABCE")?.name).toBe(
      "Game (USA)",
    );
  });

  it("keeps the first retail entry when two retail entries share a serial", () => {
    const a = entry("Game (USA)", "ABCE");
    const b = entry("Game (USA) (Rev 1)", "ABCE");
    expect(db(a, b).lookupBySerial("ABCE")?.name).toBe("Game (USA)");
  });

  it("returns whatever exists when only prerelease entries match", () => {
    const beta = entry("Game (USA) (Beta)", "ABCE");
    expect(db(beta).lookupBySerial("ABCE")?.name).toBe("Game (USA) (Beta)");
  });
});

describe("matchesSystemName", () => {
  it("matches the canonical name exactly", () => {
    expect(matchesSystemName("Nintendo - Nintendo DS", "Nintendo - Nintendo DS"))
      .toBe(true);
  });

  it("matches a parenthesised variant of the canonical name", () => {
    expect(
      matchesSystemName(
        "Nintendo - Nintendo DS (Encrypted)",
        "Nintendo - Nintendo DS",
      ),
    ).toBe(true);
    expect(
      matchesSystemName(
        "Nintendo - Nintendo DS (Decrypted)",
        "Nintendo - Nintendo DS",
      ),
    ).toBe(true);
  });

  it("rejects a different system whose name happens to share a prefix", () => {
    // "3DS" against the bare "DS" alias — would have substring-matched
    // before the boundary anchor.
    expect(matchesSystemName("Nintendo - Nintendo 3DS", "DS")).toBe(false);
    // "Game Boy Color" against the bare "Game Boy" alias — three
    // separate No-Intro DATs (Game Boy, Game Boy Color, Game Boy
    // Advance) all started with "Game Boy".
    expect(matchesSystemName("Nintendo - Game Boy Color", "Game Boy"))
      .toBe(false);
    expect(matchesSystemName("Nintendo - Game Boy Advance", "Game Boy"))
      .toBe(false);
  });

  it("rejects a name that contains the candidate as an internal substring", () => {
    expect(matchesSystemName("Some - Other DS Console", "DS")).toBe(false);
  });

  it("does NOT match a continuation without the paren boundary", () => {
    // "Game Boy Color" does not start with "Game Boy ("; rejected.
    expect(matchesSystemName("Game Boy Color", "Game Boy")).toBe(false);
  });
});
