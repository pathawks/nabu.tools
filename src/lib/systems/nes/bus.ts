/**
 * Generic NES cart-bus interface. Drivers implement this once; mappers
 * consume it instead of being bound to a specific device class. See
 * `src/lib/systems/nes/mappers/` for the shared mapper catalog that
 * uses it.
 */

/**
 * Progress signal fired at chunk boundaries inside `readCpu` / `readPpu`.
 * Drivers throttle this upstream before the UI sees it.
 */
export type BusProgressCb = (bytesRead: number, totalBytes: number) => void;

export interface NesBus {
  /**
   * Drive the cart bus into a known starting state — voltage rails,
   * pullups, mode-select, whatever the driver needs before any
   * read/write. Drivers re-issue this at the start of every dump.
   */
  setup(): Promise<void>;

  /**
   * Write `value` (low 8 bits) to CPU-bus address `addr` ($0000–$FFFF).
   * Used both for mapper register writes ($5000-style outer-bank
   * selects, $8000-style UxROM bank latches, MMC1 shift-register
   * writes one bit at a time, etc.) and for SRAM stores when supported.
   */
  writeCpu(addr: number, value: number): Promise<void>;

  /**
   * Read `length` bytes from CPU bus starting at `addr`. Drivers
   * handle chunking, /ROMSEL timing, and any per-chunk ACK protocol
   * internally. Mappers must have set the cart into the right state
   * (correct bank selected, SRAM enabled, etc.) before calling. The
   * optional `onProgress` callback fires at each internal chunk
   * boundary so callers can drive a progress bar even on a single
   * large read.
   */
  readCpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array>;

  /**
   * Read `length` bytes from PPU bus starting at PPU `addr`
   * ($0000–$1FFF). Optional — a driver whose firmware only exposes
   * mapper-specific CHR readers (rather than a generic PPU-bus
   * primitive) omits this. Mappers that dump CHR-ROM check for its
   * presence and throw a clear error pointing the driver author at the
   * override mechanism (supply a driver-specific `dumpChrRom`).
   */
  readPpu?(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array>;

  /**
   * Read one CHR-ROM bank selected by latching `selectValue` into the
   * cart's $8000-space register (the discrete bus-conflict mappers — CNROM,
   * Color Dreams, GxROM). `bank0` is PRG bank 0, the source of the
   * bus-conflict gate byte. Optional — a device supplies this when its
   * firmware fuses the bank-select write and the CHR read into one
   * operation, so it can't expose a standalone `readPpu`. Mappers reach it
   * through the shared `readLatchedChrBank` helper, which falls back to
   * `selectBank` + `readPpu` when it's absent — the same optional-capability
   * shape as `readPpu` and `writeSerialRegister`.
   */
  readChrBankLatched?(
    selectValue: number,
    bank0: Uint8Array,
    length: number,
  ): Promise<Uint8Array>;

  /**
   * Atomically load a serially-shifted mapper register: clock the low 5
   * bits of `value` into the shift register selected by `addr`, as a single
   * unit. Optional — a driver supplies this only when its transport can't
   * reliably clock the five individual `writeCpu`s a serial register
   * (MMC1's) otherwise needs, because the per-write timing isn't preserved
   * over the wire. Mapper 1 feature-detects this and falls back to per-bit
   * `writeCpu`s when it's absent — the same optional-capability shape as
   * `readPpu`. Does not include the bit-7 reset write; the mapper issues
   * that via `writeCpu` first.
   */
  writeSerialRegister?(addr: number, value: number): Promise<void>;
}
