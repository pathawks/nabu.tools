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

export type SystemId = "gb" | "gbc" | "gba" | "amiibo" | string;

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

export interface CartridgeInfo {
  title?: string;
  mapper?: MapperInfo;
  romSize?: number;
  saveSize?: number;
  saveType?: string;
  rawHeader?: Uint8Array;
  meta?: Record<string, unknown>;
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
  ): ResolvedConfigField[];
  estimateDumpSize?(values: ConfigValues): number;
  validate(values: ConfigValues): ValidationResult;
  buildReadConfig(values: ConfigValues): ReadConfig;
  buildOutputFile(rawData: Uint8Array, config: ReadConfig): OutputFile;
  computeHashes(rawData: Uint8Array): Promise<VerificationHashes>;
  verify(
    hashes: VerificationHashes,
    db: VerificationDB | null,
  ): VerificationResult;
  /** Optional: extract a human-readable summary of a completed dump's contents. */
  summarizeDump?(rawData: Uint8Array): DumpSummary | null;
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
  lockedReason?: string;
  group?: string;
  order?: number;
  dependsOn?: string[];
}

export interface ConfigOption {
  value: string | number;
  label: string;
  hint?: string;
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
