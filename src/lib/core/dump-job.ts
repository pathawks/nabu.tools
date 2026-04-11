import type {
  DeviceDriver,
  SystemHandler,
  DumpJobState,
  DumpJobEvents,
  DumpResult,
  DumpProgress,
  ConfigValues,
  VerificationDB,
} from "@/lib/types";

export class DumpJobImpl {
  state: DumpJobState = "idle";
  driver: DeviceDriver;
  system: SystemHandler;

  private events: Partial<DumpJobEvents> = {};
  private verificationDb: VerificationDB | null;

  constructor(
    driver: DeviceDriver,
    system: SystemHandler,
    verificationDb: VerificationDB | null = null,
  ) {
    this.driver = driver;
    this.system = system;
    this.verificationDb = verificationDb;
  }

  on<K extends keyof DumpJobEvents>(event: K, handler: DumpJobEvents[K]): void {
    this.events[event] = handler;
  }

  async run(values: ConfigValues, signal?: AbortSignal): Promise<DumpResult> {
    const startTime = Date.now();

    try {
      // Validate config
      const validation = this.system.validate(values);
      if (!validation.valid) {
        throw new Error(
          `Invalid configuration: ${validation.errors.map((e) => e.message).join("; ")}`,
        );
      }
      const readConfig = this.system.buildReadConfig(values);

      // Wire up driver progress events
      this.driver.on("onProgress", (p: DumpProgress) => this.events.onProgress?.(p));
      this.driver.on("onLog", (msg: string, level: "info" | "warn" | "error") =>
        this.events.onLog?.(msg, level),
      );

      // Dump ROM
      this.setState("dumping_rom");
      const rawData = await this.driver.readROM(readConfig, signal);

      // Dump save if requested
      let saveFile;
      if (values.backupSave) {
        this.setState("dumping_save");
        const saveData = await this.driver.readSave(readConfig, signal);
        saveFile = {
          data: saveData,
          filename: `dump.sav`,
          mimeType: "application/octet-stream",
        };
      }

      // Hash, verify, then build output (verify may trim the ROM)
      this.setState("hashing");
      const hashes = await this.system.computeHashes(rawData);
      this.log(`CRC32: ${hashes.crc32.toString(16).toUpperCase().padStart(8, "0")}  SHA-1: ${hashes.sha1}`);

      this.setState("verifying");
      const verification = this.system.verify(hashes, this.verificationDb);
      if (verification.matched && verification.entry) {
        this.log(`Verified: ${verification.entry.name}`);
      }

      const outputFile = this.system.buildOutputFile(rawData, readConfig);

      const result: DumpResult = {
        rom: outputFile,
        save: saveFile,
        hashes,
        verification,
        durationMs: Date.now() - startTime,
      };

      this.setState("complete");
      this.events.onComplete?.(result);
      return result;
    } catch (error) {
      if (signal?.aborted) {
        this.setState("aborted");
        this.log("Dump aborted by user", "warn");
      } else {
        this.setState("error");
        this.log(`Error: ${(error as Error).message}`, "error");
        this.events.onError?.(error as Error);
      }
      throw error;
    }
  }

  private setState(state: DumpJobState) {
    this.state = state;
    this.events.onStateChange?.(state);
  }

  private log(message: string, level: "info" | "warn" | "error" = "info") {
    this.events.onLog?.(message, level);
  }
}
