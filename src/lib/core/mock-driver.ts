import type {
  DeviceDriver,
  DeviceDriverEvents,
  Transport,
  DeviceCapability,
  DeviceInfo,
  CartridgeInfo,
  ReadConfig,
  DumpProgress,
  SystemId,
  DetectSystemResult,
} from "@/lib/types";

/**
 * Mock driver for development and testing.
 * Simulates device communication with deterministic pseudo-random data.
 * Enable via ?mock=true query parameter.
 */
export class MockDriver implements DeviceDriver {
  readonly id = "MOCK";
  readonly name = "Mock Device";
  readonly transport: Transport;
  readonly capabilities: DeviceCapability[] = [
    { systemId: "gb", operations: ["dump_rom", "dump_save"], autoDetect: true },
    { systemId: "gbc", operations: ["dump_rom", "dump_save"], autoDetect: true },
    { systemId: "gba", operations: ["dump_rom", "dump_save"], autoDetect: true },
  ];

  private events: Partial<DeviceDriverEvents> = {};

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async initialize(): Promise<DeviceInfo> {
    this.log("Mock device initialized");
    return {
      firmwareVersion: "mock-1.0",
      deviceName: "Mock Device",
      capabilities: this.capabilities,
      hotSwap: true,
    };
  }

  async detectSystem(): Promise<DetectSystemResult | null> {
    this.log("Mock: auto-detecting system");
    const cartInfo = await this.detectCartridge("gb");
    if (cartInfo) return { systemId: "gb", cartInfo };
    return null;
  }

  async detectCartridge(systemId: SystemId): Promise<CartridgeInfo | null> {
    this.log(`Mock: detecting ${systemId} cartridge`);
    if (systemId === "gb" || systemId === "gbc") {
      return {
        title: "POKEMON BLUE",
        mapper: { id: 3, name: "MBC3" },
        romSize: 1024 * 1024,
        saveSize: 32768,
        saveType: "SRAM",
      };
    }
    if (systemId === "gba") {
      return {
        title: "POKEMON EMER",
        mapper: { id: 0, name: "None" },
        romSize: 16 * 1024 * 1024,
        saveSize: 131072,
        saveType: "Flash",
      };
    }
    return null;
  }

  async readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const totalBytes = (config.params.prgSizeBytes as number) ??
      (config.params.romSizeBytes as number) ?? 32768;
    return this.mockTransfer(totalBytes, "rom", signal);
  }

  async readSave(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array> {
    const totalBytes = (config.params.saveSizeBytes as number) ?? 8192;
    return this.mockTransfer(totalBytes, "save", signal);
  }

  async writeSave(
    _data: Uint8Array,
    _config: ReadConfig,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.log("Mock: write save (no-op)");
  }

  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void {
    this.events[event] = handler;
  }

  private async mockTransfer(
    totalBytes: number,
    phase: DumpProgress["phase"],
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const data = new Uint8Array(totalBytes);
    const chunkSize = 4096;
    const totalChunks = Math.ceil(totalBytes / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      if (signal?.aborted) throw new Error("Aborted");
      await new Promise((r) => setTimeout(r, 15));
      const offset = i * chunkSize;
      const end = Math.min(offset + chunkSize, totalBytes);
      for (let j = offset; j < end; j++) {
        data[j] = (j * 7 + 0x5a + (j >> 8) * 13) & 0xff;
      }
      this.events.onProgress?.({
        phase,
        bytesRead: end,
        totalBytes,
        fraction: (i + 1) / totalChunks,
      });
    }
    return data;
  }

  private log(message: string) {
    this.events.onLog?.(message, "info");
  }
}
