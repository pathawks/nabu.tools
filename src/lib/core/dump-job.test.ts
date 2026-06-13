import { describe, it, expect } from "vitest";
import { DumpJobImpl } from "./dump-job";
import type {
  DeviceDriver,
  SystemHandler,
  VerificationHashes,
} from "@/lib/types";

/**
 * The uniform-fill save warning: a save that comes back as a solid
 * 0x00/0xFF block is an electrical failure signature (chip never enabled
 * / unwired region), not data — hardware-found on an MMC3 cart whose
 * save dumped as pure zeros. The job must flag it in the event log.
 */

function makeDriver(saveData: Uint8Array): DeviceDriver {
  return {
    id: "fake",
    name: "Fake",
    capabilities: [],
    initialize: async () => ({
      firmwareVersion: "0",
      deviceName: "Fake",
      capabilities: [],
    }),
    detectSystem: async () => null,
    detectCartridge: async () => null,
    readROM: async () => new Uint8Array([1, 2, 3, 4]),
    readSave: async () => saveData,
    writeSave: async () => {},
    on: () => {},
  };
}

const system: SystemHandler = {
  systemId: "nes",
  displayName: "NES",
  fileExtension: ".nes",
  getConfigFields: () => [],
  validate: () => ({ valid: true }),
  buildReadConfig: () => ({ systemId: "nes", params: {} }),
  buildOutputFile: (data) => ({
    data,
    filename: "dump.nes",
    mimeType: "application/octet-stream",
  }),
  computeHashes: async (): Promise<VerificationHashes> => ({
    crc32: 0,
    sha1: "0",
    size: 4,
  }),
  verify: () => ({ matched: false, confidence: "none" as const }),
};

async function runJob(saveData: Uint8Array): Promise<string[]> {
  const job = new DumpJobImpl(makeDriver(saveData), system, null);
  const warnings: string[] = [];
  job.on("onLog", (msg, level) => {
    if (level === "warn") warnings.push(msg);
  });
  await job.run({ backupSave: true });
  return warnings;
}

describe("DumpJob uniform-fill save warning", () => {
  it("warns when the save is a solid 0x00 block", async () => {
    const warnings = await runJob(new Uint8Array(8192));
    expect(warnings.some((w) => w.includes("uniform 0x00 fill"))).toBe(true);
  });

  it("warns when the save is a solid 0xFF block", async () => {
    const warnings = await runJob(new Uint8Array(8192).fill(0xff));
    expect(warnings.some((w) => w.includes("uniform 0xFF fill"))).toBe(true);
  });

  it("stays quiet for real-looking save data", async () => {
    const save = Uint8Array.from({ length: 8192 }, (_, i) => (i * 7) & 0xff);
    const warnings = await runJob(save);
    expect(warnings).toEqual([]);
  });
});
