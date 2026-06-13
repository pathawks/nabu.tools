// Single import point for consumers: import type { ... } from "@/lib/types"

export type TransportType = "webusb" | "webhid" | "serial" | "nfc" | "http";

export interface TransportEvents {
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export interface Transport {
  readonly type: TransportType;
  readonly connected: boolean;
  connect(options?: TransportConnectOptions): Promise<DeviceIdentity>;
  disconnect(): Promise<void>;
  /**
   * Synchronous best-effort teardown for page unload. A dying document
   * may never resume the awaits inside `disconnect()`, so this kicks off
   * every release step in one synchronous burst without awaiting between
   * them. Optional — transports whose handles don't outlive the document
   * (WebUSB/WebHID release cleanly on unload) omit it.
   */
  closeNow?(): void;
  send(data: Uint8Array, options?: TransferOptions): Promise<void>;
  receive(length: number, options?: TransferOptions): Promise<Uint8Array>;
  on<K extends keyof TransportEvents>(
    event: K,
    handler: TransportEvents[K],
  ): void;
}

export interface TransportConnectOptions {
  baudRate?: number;
  host?: string;
  timeout?: number;
}

export interface TransferOptions {
  transferType?: "control" | "bulk" | "interrupt";
  requestType?: "vendor" | "class" | "standard";
  recipient?: "device" | "interface" | "endpoint";
  request?: number;
  value?: number;
  index?: number;
  flush?: boolean;
  endpoint?: string;
  method?: "GET" | "POST";
  stream?: boolean;
  timeout?: number;
}

export interface DeviceIdentity {
  vendorId?: number;
  productId?: number;
  name: string;
  serial?: string;
  firmwareVersion?: string;
  transport: TransportType;
  raw?: unknown;
}

// ─── Device Driver ──────────────────────────────────────────────────────────

export type SystemId =
  | "gb"
  | "gbc"
  | "gba"
  | "nes"
  | "amiibo"
  | "nds_save"
  | string;

export interface DeviceCapability {
  systemId: SystemId;
  operations: (
    | "dump_rom"
    | "dump_save"
    | "write_rom"
    | "write_save"
    | "erase_save"
  )[];
  autoDetect: boolean;
  notes?: string;
  /**
   * Mapper IDs in the system's shared catalog this device cannot drive
   * (only meaningful for mapper-based systems, i.e. NES). The driver
   * still pre-flight-rejects these in `readROM`; declaring them here
   * additionally greys the options out in the config UI.
   */
  unsupportedMappers?: number[];
}

export interface DeviceDriverEvents {
  onProgress?: (progress: DumpProgress) => void;
  onLog?: (message: string, level: "info" | "warn" | "error") => void;
}

export interface DetectSystemResult {
  systemId: SystemId;
  cartInfo: CartridgeInfo;
  /**
   * Set when a cartridge is detected but the driver cannot dump it
   * (e.g. media that requires non-redistributable encryption keys).
   * The wizard renders `reason` as an explanation instead of the dump UI.
   */
  unsupported?: { reason: string };
}

export interface DeviceDriver {
  readonly id: string;
  readonly name: string;
  readonly transport?: Transport;
  readonly capabilities: DeviceCapability[];
  initialize(): Promise<DeviceInfo>;
  /** Auto-detect which system is inserted (GBA first at 3.3V, then DMG at 5V). */
  detectSystem(): Promise<DetectSystemResult | null>;
  detectCartridge(systemId: SystemId): Promise<CartridgeInfo | null>;
  readROM(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array>;
  readSave(config: ReadConfig, signal?: AbortSignal): Promise<Uint8Array>;
  writeSave(
    data: Uint8Array,
    config: ReadConfig,
    signal?: AbortSignal,
  ): Promise<void>;
  on<K extends keyof DeviceDriverEvents>(
    event: K,
    handler: DeviceDriverEvents[K],
  ): void;
  /** Release any resources held by the driver (event listeners, buffers). */
  dispose?(): void;
}

export interface DeviceInfo {
  firmwareVersion: string;
  hardwareRevision?: string;
  deviceName: string;
  capabilities: DeviceCapability[];
  /**
   * If true, the device can re-detect a freshly-inserted cartridge without
   * a full USB disconnect/reconnect cycle. Defaults to false (conservative).
   * Drivers opt in when they know the hardware supports it safely —
   * e.g. natively hot-pluggable memory-card adapters, or GBxCart PCBs
   * with programmatic cart-power control.
   */
  hotSwap?: boolean;
  /**
   * Optional one-line note about cartridge compatibility — surfaced under
   * the "Insert a cartridge…" prompt to set user expectations before they
   * try and fail.
   */
  compatibilityNote?: string;
}

export interface ReadConfig {
  systemId: SystemId;
  params: Record<string, unknown>;
}

export interface DumpProgress {
  phase: "rom" | "save" | "header" | "verify";
  bytesRead: number;
  totalBytes: number;
  fraction: number;
  speed?: number;
}

// ─── System Handler ─────────────────────────────────────────────────────────

export interface CartridgeInfo<M = Record<string, unknown>> {
  title?: string;
  /**
   * One-line description of what detection found, for the event log when
   * the cart carries no self-reported title (e.g. NES: "NES cartridge
   * (mirroring: vertical)"). Unlike `title` it is never used for filenames
   * or config prefill, so it can hold transient detail like power-on
   * mirroring state.
   */
  summary?: string;
  mapper?: MapperInfo;
  romSize?: number;
  saveSize?: number;
  saveType?: string;
  rawHeader?: Uint8Array;
  meta?: M;
}

export interface MapperInfo {
  id: number;
  name: string;
  variant?: string;
}

export interface SystemHandler {
  readonly systemId: SystemId;
  readonly displayName: string;
  readonly fileExtension: string;
  getConfigFields(
    currentValues: ConfigValues,
    autoDetected?: CartridgeInfo,
    /**
     * The connected device's capability for this system, when known —
     * lets the handler grey out options the device can't drive (e.g.
     * `unsupportedMappers`).
     */
    capability?: DeviceCapability,
  ): ResolvedConfigField[];
  estimateDumpSize?(values: ConfigValues): number;
  validate(values: ConfigValues): ValidationResult;
  buildReadConfig(values: ConfigValues): ReadConfig;
  /**
   * Build the final output file. When `verification` carries a matched
   * `entry.header`, headered systems should prefer that canonical header
   * byte-for-byte over their own computed header — keeping the output
   * bit-identical to the No-Intro DAT entry rather than relying on our
   * defaults for the bits the cart can't self-report (TV system,
   * expansion device, submapper, etc.). The match is verified by
   * re-hashing `header || content`, so the emitted file equals the
   * verified entry byte-for-byte — emit the canonical header as-is even
   * if it looks unusual. A header that can't describe the attached bytes
   * (e.g. a trainer flag the dump can't satisfy, or size fields that
   * don't sum to the content) is surfaced via {@link OutputFile.warnings}
   * rather than rewritten — we never second-guess the verified bytes.
   */
  buildOutputFile(
    rawData: Uint8Array,
    config: ReadConfig,
    verification?: VerificationResult,
  ): OutputFile;
  computeHashes(rawData: Uint8Array): Promise<VerificationHashes>;
  verify(
    hashes: VerificationHashes,
    db: VerificationDB | null,
    /**
     * Unheadered ROM bytes (what `computeHashes` ran over). Headered
     * systems splice the canonical iNES header from a DAT entry onto the
     * content and confirm SHA-1, decoupling our output file's header
     * format from No-Intro's canonical form. May resolve asynchronously.
     */
    content?: Uint8Array,
  ): VerificationResult | Promise<VerificationResult>;
  /** Optional: extract a human-readable summary of a completed dump's contents. */
  summarizeDump?(rawData: Uint8Array): DumpSummary | null;
  /**
   * Optional: editable header fields offered for an UNVERIFIED dump, so the
   * user can complete the header the verification DB would otherwise supply
   * (e.g. NES 2.0 region/timing, console type, default controller). `file` is
   * the produced output bytes; `overrides` is the user's edits so far, keyed
   * by field key. Returns [] when the system has no editable header. Pair with
   * {@link applyHeaderOverrides}; only headered systems implement these.
   */
  getHeaderFields?(
    file: Uint8Array,
    overrides: ConfigValues,
  ): ResolvedConfigField[];
  /**
   * Optional: apply header-field overrides to a finished dump, returning new
   * output bytes with the header rewritten and the content left untouched.
   * Operates on the original `file` plus `overrides` (never a previously
   * edited file). No-op fields fall back to the file's current values.
   */
  applyHeaderOverrides?(file: Uint8Array, overrides: ConfigValues): Uint8Array;
  /**
   * Optional: human-readable display values for the editable header fields of
   * a finished dump, keyed for the report's "Dumping Settings" section. Lets
   * the wizard refresh the report meta after a header edit so the saved report
   * matches the saved bytes. Pairs with {@link getHeaderFields}/{@link applyHeaderOverrides}.
   */
  headerMeta?(file: Uint8Array): Record<string, string>;
  /**
   * Optional: post-dump heuristic checks over the unheadered raw bytes
   * that apply regardless of which device or mapper produced them — e.g.
   * PRG banks that came back byte-identical to bank 0, the signature of a
   * bank-switch latch failure. Returns human-readable notes; an empty
   * array (or an omitted method) means nothing to flag. Surfaced in the
   * event log, not as a blocking error.
   */
  analyzeDump?(content: Uint8Array, config: ReadConfig): string[];
}

/** A single cell in a {@link DumpSummary} row — text or a small bitmap (e.g. PS1 save icon). */
export type DumpSummaryCell =
  | string
  | {
      kind: "icon";
      /** One or more RGBA frames at native resolution. Multiple frames animate. */
      frames: Uint8ClampedArray<ArrayBuffer>[];
      width: number;
      height: number;
      /** CSS upscale factor; the canvas itself is rendered at native size with `image-rendering: pixelated`. */
      displayScale: number;
      /** Per-frame duration in milliseconds when animating. */
      frameDurationMs?: number;
      alt?: string;
    };

export interface DumpSummary {
  /** Heading shown above the table. */
  title: string;
  /** Column headers, in order. */
  columns: string[];
  /** Column indices to render in a monospace font (e.g., codes, IDs). */
  monoColumns?: number[];
  /** Column indices to render with muted/secondary text color (e.g., row IDs). */
  mutedColumns?: number[];
  /** Column indices to right-align (e.g., sizes, hashes, counts). */
  rightAlignColumns?: number[];
  /** Rows of cells; each row's length should equal `columns.length`. */
  rows: DumpSummaryCell[][];
  /** Optional summary line below the table (e.g., counts). */
  footer?: string;
  /**
   * Optional integrity check (e.g. per-frame checksum). When `ok` is false,
   * the dump is flagged as unverified in the UI even for save-only systems
   * with no verification database.
   */
  integrity?: { ok: boolean; message?: string };
}

// ─── Config Fields ──────────────────────────────────────────────────────────

export type ConfigValues = Record<string, unknown>;

export interface ResolvedConfigField {
  key: string;
  label: string;
  type: "select" | "number" | "checkbox" | "text" | "readonly" | "hidden";
  value: unknown;
  options?: ConfigOption[];
  range?: { min: number; max: number; step?: number };
  autoDetected?: boolean;
  locked?: boolean;
  helpText?: string;
  /** Prominent amber warning alert (e.g. a hardware/handling caveat). */
  warning?: string;
  lockedReason?: string;
  group?: string;
  order?: number;
  dependsOn?: string[];
}

export interface ConfigOption {
  value: string | number;
  label: string;
  hint?: string;
  /** Greyed out and unselectable (e.g. the connected device can't dump it). */
  disabled?: boolean;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };

export interface ValidationError {
  field?: string;
  message: string;
  code: string;
  severity: "error" | "warning";
  suggestion?: string;
}

export interface OutputFile {
  data: Uint8Array;
  filename: string;
  mimeType: string;
  meta?: Record<string, string>;
  /**
   * Optional list of equivalent file extensions to offer in the save dialog.
   * Useful when the same byte content is conventionally given different
   * names by different tools (e.g. PS1 memory cards: .mcr / .mcd).
   * Defaults to the extension parsed from `filename`.
   */
  acceptExtensions?: string[];
  /**
   * Optional override for the action button label shown in CompleteStep
   * (e.g. "Save Memory Card"). When unset, the UI picks a sensible default
   * based on whether the dump is save-only or a ROM.
   */
  actionLabel?: string;
  /**
   * Build-time warnings about the produced file that should be surfaced
   * loudly in the event log — e.g. a matched No-Intro header whose
   * size/trainer fields disagreed with the dump (a should-never-happen
   * integrity signal). Empty/omitted means none.
   */
  warnings?: string[];
}

export interface VerificationHashes {
  crc32: number;
  sha1: string;
  sha256?: string;
  size: number;
}

export interface VerificationDB {
  systemId: SystemId;
  source: string;
  entryCount: number;
  lookup(hashes: VerificationHashes): VerificationEntry | null;
  lookupBySerial?(serial: string): { name: string; size: number } | null;
}

export interface VerificationEntry {
  name: string;
  region?: string;
  languages?: string[];
  status: "verified" | "alt" | "bad" | "unknown";
  /**
   * Canonical iNES/etc. header bytes for headered systems (NES). When
   * the DAT publishes per-entry headers and the SystemHandler hashes
   * unheadered content, this lets `verify()` splice the canonical
   * header back on to confirm SHA-1 — decoupling our output's header
   * form from the DAT's canonical form.
   */
  header?: number[];
  /**
   * Original SHA-1 from the DAT. For headered systems this is the
   * SHA-1 over `header || content`. For non-headered systems it's the
   * SHA-1 over the raw file (same thing the SystemHandler computes).
   */
  sha1?: string;
}

export interface VerificationResult {
  matched: boolean;
  entry?: VerificationEntry;
  confidence: "exact" | "size_match" | "none";
  suggestions?: string[];
}

// ─── DumpJob ────────────────────────────────────────────────────────────────

export type DumpJobState =
  | "idle"
  | "connecting"
  | "detecting"
  | "configuring"
  | "dumping_rom"
  | "dumping_save"
  | "hashing"
  | "verifying"
  // Abort requested; the in-flight dump is still unwinding. Terminal
  // "aborted" only fires once the dump promise has actually settled.
  | "aborting"
  | "complete"
  | "error"
  | "aborted";

export interface DumpJobEvents {
  onStateChange?: (state: DumpJobState) => void;
  onProgress?: (progress: DumpProgress) => void;
  onLog?: (message: string, level: "info" | "warn" | "error") => void;
  onComplete?: (result: DumpResult) => void;
  onError?: (error: Error) => void;
}

export interface DumpResult {
  rom?: OutputFile;
  save?: OutputFile;
  hashes: VerificationHashes;
  verification: VerificationResult;
  cartInfo?: CartridgeInfo;
  durationMs: number;
}
