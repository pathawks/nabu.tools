import { describe, it, expect } from "vitest";
import type { SerialTransport } from "@/lib/transport/serial-transport";
import { CMD } from "./clusterm-commands";
import { ClusterMDriver, decodeMirroring } from "./clusterm-driver";
import { ClusterMNesBus } from "./clusterm-bus";
import { ClusterMProtocol } from "./clusterm-protocol";
import { FakeClusterMDevice } from "./clusterm-test-utils";

function makeDriver(fake: FakeClusterMDevice): ClusterMDriver {
  return new ClusterMDriver(fake.transport as SerialTransport);
}

describe("decodeMirroring", () => {
  it.each([
    [[false, false, true, true], "horizontal"],
    [[false, true, false, true], "vertical"],
    [[false, false, false, false], "one_screen_a"],
    [[true, true, true, true], "one_screen_b"],
    [[true, false, false, true], "unknown"],
  ])("decodes %j as %s", (raw, expected) => {
    expect(decodeMirroring(raw as boolean[])).toBe(expected);
  });

  it("decodes the 1-byte legacy reply", () => {
    expect(decodeMirroring([true])).toBe("vertical");
    expect(decodeMirroring([false])).toBe("horizontal");
  });
});

describe("ClusterMDriver.initialize", () => {
  it("reports firmware and hardware versions from the handshake", async () => {
    const fake = new FakeClusterMDevice();
    const info = await makeDriver(fake).initialize();
    expect(info.firmwareVersion).toBe("3.4.0");
    expect(info.hardwareRevision).toBe("3.2.0");
    expect(info.deviceName).toBe("ClusterM Famicom Dumper/Writer");
  });
});

describe("ClusterMDriver.detectSystem", () => {
  it("describes mirroring in summary, never title", async () => {
    const fake = new FakeClusterMDevice();
    fake.mirroringRaw = [0, 1, 0, 1];
    const result = await makeDriver(fake).detectSystem();
    expect(result?.systemId).toBe("nes");
    expect(result?.cartInfo.title).toBeUndefined();
    expect(result?.cartInfo.summary).toBe(
      "NES cartridge (mirroring: vertical)",
    );
    expect(result?.cartInfo.meta).toEqual({ mirroring: "vertical" });
  });

  it("survives a probe failure with mirroring unknown", async () => {
    const fake = new FakeClusterMDevice();
    fake.ignoreNextCommands = 1; // mirroring request gets no reply → timeout
    const result = await makeDriver(fake).detectSystem();
    expect(result?.cartInfo.summary).toBe(
      "NES cartridge (mirroring: unknown)",
    );
  });
});

describe("ClusterMDriver.readROM", () => {
  it("dumps NROM as PRG followed by CHR and resets on the way out", async () => {
    const fake = new FakeClusterMDevice();
    fake.cpuRead = () => 0x42;
    fake.ppuRead = () => 0x99;
    const rom = await makeDriver(fake).readROM({
      systemId: "nes",
      params: { mapper: 0, prgSizeBytes: 32768, chrSizeBytes: 8192 },
    });
    expect(rom.length).toBe(32768 + 8192);
    expect(rom[0]).toBe(0x42);
    expect(rom[32768]).toBe(0x99);
    // Exit invariant: the device is left in power-on state.
    expect(fake.commands.at(-1)?.command).toBe(CMD.RESET);
  });

  it("rejects mappers outside the shared catalog", async () => {
    const fake = new FakeClusterMDevice();
    await expect(
      makeDriver(fake).readROM({ systemId: "nes", params: { mapper: 5 } }),
    ).rejects.toThrow(/Unsupported mapper: 5/);
  });

  it("refuses mapper 413 (BATMAP): its sample flash can't be paced here", async () => {
    const fake = new FakeClusterMDevice();
    await expect(
      makeDriver(fake).readROM({ systemId: "nes", params: { mapper: 413 } }),
    ).rejects.toThrow(/BATMAP|cannot be fully dumped/i);
  });

  it("advertises mapper 413 as unsupported so the UI greys it out", async () => {
    const info = await makeDriver(new FakeClusterMDevice()).initialize();
    expect(info.capabilities?.[0]?.unsupportedMappers).toContain(413);
  });

  it("still resets the cart when a dump aborts mid-read", async () => {
    const fake = new FakeClusterMDevice();
    const controller = new AbortController();
    // Abort from the device side after two 8 KiB chunks have been served,
    // so the bus's per-chunk signal check is what interrupts the dump.
    let served = 0;
    fake.cpuRead = () => {
      if (++served === 16384) controller.abort();
      return 0x42;
    };
    await expect(
      makeDriver(fake).readROM(
        {
          systemId: "nes",
          params: { mapper: 0, prgSizeBytes: 32768, chrSizeBytes: 8192 },
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fake.commands.at(-1)?.command).toBe(CMD.RESET);
    // The abort landed mid-PRG: only the two served chunks went out.
    const reads = fake.commands.filter(
      (c) => c.command === CMD.PRG_READ_REQUEST,
    );
    expect(reads.length).toBe(2);
  });
});

describe("ClusterMDriver.readSave", () => {
  it("reads the $6000 window through the default path", async () => {
    const fake = new FakeClusterMDevice();
    fake.cpuRead = (addr) => (addr >= 0x6000 && addr < 0x8000 ? 0x5a : 0x00);
    const save = await makeDriver(fake).readSave({
      systemId: "nes",
      params: { mapper: 0, prgRamSizeBytes: 8192 },
    });
    expect(save.length).toBe(8192);
    expect(save[0]).toBe(0x5a);
    const read = fake.commands.find(
      (c) => c.command === CMD.PRG_READ_REQUEST,
    );
    expect([...(read?.payload ?? [])].slice(0, 2)).toEqual([0x00, 0x60]);
    expect(fake.commands.at(-1)?.command).toBe(CMD.RESET);
  });

  it("throws when there is no SRAM to read", async () => {
    const fake = new FakeClusterMDevice();
    await expect(
      makeDriver(fake).readSave({
        systemId: "nes",
        params: { mapper: 0, prgRamSizeBytes: 0 },
      }),
    ).rejects.toThrow(/No SRAM to read/);
  });
});

describe("ClusterMNesBus", () => {
  it("chunks large reads and reports progress", async () => {
    const fake = new FakeClusterMDevice();
    const bus = new ClusterMNesBus(new ClusterMProtocol(fake.transport));
    const ticks: number[] = [];
    const data = await bus.readCpu(0x8000, 32768, (read) => ticks.push(read));
    expect(data.length).toBe(32768);
    expect(ticks).toEqual([8192, 16384, 24576, 32768]);
    const reads = fake.commands.map((c) => c.payload[0] | (c.payload[1] << 8));
    expect(reads).toEqual([0x8000, 0xa000, 0xc000, 0xe000]);
  });

  it("aborts between chunks", async () => {
    const fake = new FakeClusterMDevice();
    const controller = new AbortController();
    const bus = new ClusterMNesBus(
      new ClusterMProtocol(fake.transport),
      controller.signal,
    );
    await expect(
      bus.readCpu(0x8000, 32768, (read) => {
        if (read >= 16384) controller.abort();
      }),
    ).rejects.toThrow();
    expect(fake.commands.length).toBe(2); // chunks completed before the abort
  });

  it("does not advertise the mapper-413 paced SPI read", () => {
    // Stock firmware pauses the read stream every 64 bytes for a CDC
    // buffer flush, and every pause can inject spurious SPI clocks
    // (hardware-established 2026-06-13) — so a trustworthy paced read
    // is impossible without firmware help. The capability must stay
    // absent so mapper 413's misc dump throws its clear error instead
    // of producing a sheared 8 MiB file.
    const bus = new ClusterMNesBus(new ClusterMProtocol(new FakeClusterMDevice().transport));
    expect((bus as { readSpiDataPort?: unknown }).readSpiDataPort).toBeUndefined();
  });

  it("issues the fused latch+read as two sequential commands", async () => {
    // The firmware drops the first of two frames sharing a send buffer
    // (single command slot — see clusterm-protocol.ts), so the fused
    // capability must be sequential ops; the free-running M2 keeps the
    // inner latch alive across the gap.
    const fake = new FakeClusterMDevice();
    const bus = new ClusterMNesBus(new ClusterMProtocol(fake.transport));
    const data = await bus.readCpuBankLatched(0x8000, 7, 0x8000, 2048);
    expect(data.length).toBe(2048);
    expect(fake.sendBuffers.length).toBe(2);
    expect(fake.commands.map((c) => c.command)).toEqual([
      CMD.PRG_WRITE_REQUEST,
      CMD.PRG_READ_REQUEST,
    ]);
    expect([...fake.commands[0].payload]).toEqual([0x00, 0x80, 0x01, 0x00, 0x07]);
  });
});
