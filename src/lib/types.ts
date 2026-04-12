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

export type SystemId = "gb" | "gbc" | "gba" | "nes" | "amiibo" | string;

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
