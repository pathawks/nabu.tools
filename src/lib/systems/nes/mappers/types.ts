import type { NesBus } from "../bus";

export type ProgressCb = (bytesRead: number, totalBytes: number) => void;

/**
 * Shared NES mapper interface. Mappers consume a `NesBus`, not a
 * specific device, so the same implementation can be reused across
 * drivers. Drivers that need to override a specific mapper (because
 * their bus can't express something the mapper needs) supply their
 * own `NesMapper` for that ID — the catalog is just a map of ID to
 * implementation.
 */
export interface NesMapper {
  readonly id: number;
  readonly name: string;

  /** Auto-detect CIRAM mirroring. Optional; not all mappers/buses support it. */
  detectMirroring?(bus: NesBus): Promise<string>;

  dumpPrgRom(
    bus: NesBus,
    sizeKB: number,
    onProgress?: ProgressCb,
  ): Promise<Uint8Array>;

  dumpChrRom(
    bus: NesBus,
    sizeKB: number,
    onProgress?: ProgressCb,
  ): Promise<Uint8Array>;

  /**
   * Dump the NES 2.0 miscellaneous-ROM area — the file section appended
   * after CHR (header byte 14 counts it). Only boards that carry one
   * declare this (mapper 413's 8 MiB sample flash); `sizeKB` comes from
   * the mapper def's fixed `miscRomKB`.
   */
  dumpMiscRom?(
    bus: NesBus,
    sizeKB: number,
    onProgress?: ProgressCb,
  ): Promise<Uint8Array>;

  /** Engage SRAM access before a save-RAM dump (where required by the mapper). */
  enableSram?(bus: NesBus): Promise<void>;

  /**
   * Custom save-RAM dump path. Used by mappers where the default
   * read-region-at-$6000 doesn't capture the right banking. When
   * omitted, callers can fall back to `enableSram` + `bus.readCpu`.
   */
  dumpSave?(
    bus: NesBus,
    sramKB: number,
    onProgress?: ProgressCb,
  ): Promise<Uint8Array>;
}
