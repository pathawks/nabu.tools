import { describe, it, expect } from "vitest";
import { CMD, crc8, buildFrame } from "./clusterm-commands";
import { ClusterMProtocol } from "./clusterm-protocol";
import { FakeClusterMDevice, HW_STARTED_PAYLOAD } from "./clusterm-test-utils";

/**
 * Wire-protocol coverage against a scripted fake device that parses real
 * frames out of `send()` buffers and queues real response frames, so the
 * tests exercise the exact byte stream the firmware sees and produces.
 *
 * Reference vectors were generated with the CRC/framing algorithm
 * transcribed from the GPL-3.0 famicom-dumper-client (SerialClient.cs)
 * and confirmed against real hardware (fw 3.4.0): the PRG_INIT frame
 * below is byte-for-byte what unlocked the STARTED reply.
 */

describe("crc8 / buildFrame", () => {
  it("produces the hardware-confirmed PRG_INIT frame", () => {
    expect([...buildFrame(CMD.PRG_INIT)]).toEqual([0x46, 0x05, 0x00, 0x00, 0xdc]);
  });

  it("produces the documented read-request frame", () => {
    // PRG read of 8192 bytes at $8000
    expect([
      ...buildFrame(CMD.PRG_READ_REQUEST, [0x00, 0x80, 0x00, 0x20]),
    ]).toEqual([0x46, 0x07, 0x04, 0x00, 0x00, 0x80, 0x00, 0x20, 0xf4]);
  });

  it("validates a whole frame to zero, including the CRC byte", () => {
    const frame = buildFrame(CMD.STARTED, HW_STARTED_PAYLOAD);
    expect(crc8(frame)).toBe(0);
  });

  it("rejects a payload too large for the LE16 length field", () => {
    expect(() =>
      buildFrame(CMD.PRG_WRITE_REQUEST, new Uint8Array(0x10000)),
    ).toThrow(/payload too large/);
  });
});

describe("ClusterMProtocol.init", () => {
  it("parses the hardware STARTED payload", async () => {
    const fake = new FakeClusterMDevice();
    const info = await new ClusterMProtocol(fake.transport).init();
    expect(info).toEqual({
      protocolVersion: 5,
      maxReadPacketSize: 0xffff,
      maxWritePacketSize: 51192,
      firmwareVersion: "3.4.0",
      hardwareVersion: "3.2.0",
    });
  });

  it("retries the probe until the device answers", async () => {
    const fake = new FakeClusterMDevice();
    fake.ignoreNextCommands = 2;
    const info = await new ClusterMProtocol(fake.transport).init();
    expect(info.protocolVersion).toBe(5);
    expect(
      fake.commands.filter((c) => c.command === CMD.PRG_INIT).length,
    ).toBe(3);
  });

  it("parses a short legacy payload by length", async () => {
    const fake = new FakeClusterMDevice();
    // Old firmware: protocol version only.
    fake.startedPayload = [0x03];
    const info = await new ClusterMProtocol(fake.transport).init();
    expect(info.protocolVersion).toBe(3);
    expect(info.firmwareVersion).toBeUndefined();
  });
});

describe("ClusterMProtocol framing", () => {
  it("skips interleaved DEBUG frames", async () => {
    const fake = new FakeClusterMDevice();
    fake.ignoreNextCommands = 1;
    fake.push(CMD.DEBUG, [0xaa, 0xbb]);
    fake.push(CMD.PRG_READ_RESULT, [0x11, 0x22]);
    const protocol = new ClusterMProtocol(fake.transport);
    expect([...(await protocol.readCpuBlock(0x8000, 2))]).toEqual([
      0x11, 0x22,
    ]);
  });

  it("resynchronises past garbage bytes before the magic", async () => {
    const fake = new FakeClusterMDevice();
    fake.ignoreNextCommands = 1;
    fake.pushRaw([0x00, 0x13, 0x37]); // stale non-magic bytes
    fake.push(CMD.PRG_READ_RESULT, [0x11, 0x22]);
    const protocol = new ClusterMProtocol(fake.transport);
    expect([...(await protocol.readCpuBlock(0x8000, 2))]).toEqual([
      0x11, 0x22,
    ]);
  });

  it("rejects a frame with a corrupted CRC", async () => {
    const fake = new FakeClusterMDevice();
    fake.ignoreNextCommands = 1;
    const bad = buildFrame(CMD.PRG_READ_RESULT, [0x01, 0x02]);
    bad[bad.length - 1] ^= 0xff;
    fake.pushRaw(bad);
    const protocol = new ClusterMProtocol(fake.transport);
    await expect(protocol.readCpuBlock(0x8000, 2)).rejects.toThrow(
      /CRC error/,
    );
  });

  it("throws on a short read result instead of shifting the stream", async () => {
    const fake = new FakeClusterMDevice();
    fake.ignoreNextCommands = 1;
    fake.push(CMD.PRG_READ_RESULT, [0x01, 0x02]); // 2 bytes, 4 requested
    const protocol = new ClusterMProtocol(fake.transport);
    await expect(protocol.readCpuBlock(0x8000, 4)).rejects.toThrow(
      /returned 2 bytes, expected 4/,
    );
  });

  it("names commands in unexpected-reply errors", async () => {
    const fake = new FakeClusterMDevice();
    fake.ignoreNextCommands = 1;
    fake.push(CMD.ERROR_OVERFLOW);
    const protocol = new ClusterMProtocol(fake.transport);
    await expect(protocol.writeCpu(0x8000, [0x00])).rejects.toThrow(
      /replied ERROR_OVERFLOW, expected PRG_WRITE_DONE/,
    );
  });

  it("rejects a request whose length can't fit the LE16 field", async () => {
    const protocol = new ClusterMProtocol(new FakeClusterMDevice().transport);
    await expect(protocol.readCpuBlock(0x8000, 0x10000)).rejects.toThrow(
      /out of range/,
    );
  });
});

describe("ClusterMProtocol operations", () => {
  it("reads CPU blocks with LE16 addr/length payloads", async () => {
    const fake = new FakeClusterMDevice();
    const protocol = new ClusterMProtocol(fake.transport);
    const data = await protocol.readCpuBlock(0xc000, 512);
    expect(data.length).toBe(512);
    expect(data[0]).toBe(0xc0);
    const req = fake.commands[0];
    expect(req.command).toBe(CMD.PRG_READ_REQUEST);
    expect([...req.payload]).toEqual([0x00, 0xc0, 0x00, 0x02]);
  });

  it("writes CPU bytes and awaits the done ack", async () => {
    const fake = new FakeClusterMDevice();
    const protocol = new ClusterMProtocol(fake.transport);
    await protocol.writeCpu(0x8000, [0x07]);
    expect(fake.commands[0].command).toBe(CMD.PRG_WRITE_REQUEST);
    expect([...fake.commands[0].payload]).toEqual([0x00, 0x80, 0x01, 0x00, 0x07]);
  });

  it("never shares a send buffer between command frames", async () => {
    // The firmware's parser holds one command slot; frames sharing a CDC
    // packet execute last-frame-wins (comm.c comm_proceed). The fake
    // emulates that, so a pipelined operation would lose its first
    // command here exactly as it does on hardware.
    const fake = new FakeClusterMDevice();
    const protocol = new ClusterMProtocol(fake.transport);
    await protocol.writeCpu(0x8000, [0x05]);
    const data = await protocol.readCpuBlock(0x8000, 64);
    expect(data.length).toBe(64);
    expect(fake.sendBuffers.length).toBe(2);
    expect(fake.commands.map((c) => c.command)).toEqual([
      CMD.PRG_WRITE_REQUEST,
      CMD.PRG_READ_REQUEST,
    ]);
  });

  it("reads the raw mirroring probe", async () => {
    const fake = new FakeClusterMDevice();
    const protocol = new ClusterMProtocol(fake.transport);
    expect(await protocol.getMirroringRaw()).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });
});
