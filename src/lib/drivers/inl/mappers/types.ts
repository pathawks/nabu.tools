import type { INLDevice } from "../inl-device";

export interface NesMapper {
  readonly id: number;
  readonly name: string;
  readonly defaultPrgSizes: number[];
  readonly defaultChrSizes: number[];

  /** Detect mirroring from the cartridge hardware. */
  detectMirroring(device: INLDevice): Promise<string>;

  /** Dump PRG-ROM. */
  dumpPrgRom(
    device: INLDevice,
    sizeKB: number,
    onProgress?: (bytesRead: number, totalBytes: number) => void,
  ): Promise<Uint8Array>;

  /** Dump CHR-ROM (returns empty array for CHR-RAM carts). */
  dumpChrRom(
    device: INLDevice,
    sizeKB: number,
    onProgress?: (bytesRead: number, totalBytes: number) => void,
  ): Promise<Uint8Array>;

  /** Enable WRAM/SRAM at $6000-$7FFF before reading save data. */
  enableSram?(device: INLDevice): Promise<void>;
}
