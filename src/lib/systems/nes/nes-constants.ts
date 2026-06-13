import type { ConfigOption } from "@/lib/types";

export interface NESMapperDef {
  id: number;
  name: string;
  prgSizesKB: number[];
  chrSizesKB: number[];
  mirroring:
    | "selectable"
    | "horizontal"
    | "vertical"
    | "four_screen"
    | "mapper_controlled";
  commonlyHasBattery: boolean;
  alwaysHasBattery?: boolean;
  /**
   * Battery-backed SRAM capacity in KiB. Drives the "Back up battery
   * SRAM" opt-in (and the NVRAM declaration, byte 10 high nibble, when
   * it's checked). Strictly about saves — boards whose $6000 RAM is
   * volatile work RAM declare `prgRamKB` instead.
   */
  maxPrgRamKB: number;
  /**
   * Volatile PRG work RAM in KiB, declared in the header (byte 10 low
   * nibble) regardless of the battery opt-in. For boards that need work
   * RAM at $6000-$7FFF to function (e.g. mapper 268's bank-switch
   * trampoline) but have nothing worth backing up.
   */
  prgRamKB?: number;
  /**
   * Volatile CHR-RAM size in KiB. Used by the NES 2.0 header builder
   * (byte 11 low nibble). Mostly 0 (ROM carts); CHR-RAM mappers carry
   * their RAM size here.
   */
  chrRamKB?: number;
  /**
   * NES 2.0 miscellaneous-ROM size in KiB — a fixed extra ROM section
   * appended after CHR in the output file (header byte 14 counts it).
   * Only boards that carry one declare it (mapper 413: 8 MiB of sample
   * flash); it is never user-selectable.
   */
  miscRomKB?: number;
  /**
   * Optional per-mapper warning, surfaced as a prominent amber alert in
   * the config UI when the mapper is selected. Must be DEVICE-AGNOSTIC —
   * a cart-handling caveat (e.g. Quattro's A/B switch) or an
   * implementation-maturity note — because it shows on every driver that
   * can select the mapper. Device-specific "can't dump here" belongs in
   * the driver's `capability.unsupportedMappers` (which greys the option
   * out per-device), never here.
   */
  warning?: string;
}

/**
 * Static metadata for the mappers offered in the UI — sizes, mirroring,
 * battery. Whether a mapper can actually be *dumped* is owned by the
 * device driver (it drives the shared implementation in `./mappers/`),
 * not declared here. The list is intentionally small — entries are added
 * one at a time as each mapper is validated against real hardware.
 *
 * Size lists are ascending; the largest (last) entry is the default the
 * config fields and dump-size estimate fall back to.
 */
export const NES_MAPPER_DB: NESMapperDef[] = [
  {
    id: 0,
    name: "NROM",
    prgSizesKB: [16, 32],
    chrSizesKB: [0, 8],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 1,
    name: "MMC1 (SxROM)",
    prgSizesKB: [32, 64, 128, 256, 512],
    chrSizesKB: [0, 8, 16, 32, 64, 128],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 8,
  },
  {
    id: 2,
    name: "UxROM",
    prgSizesKB: [64, 128, 256],
    chrSizesKB: [0],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    chrRamKB: 8,
  },
  {
    id: 3,
    name: "CxROM",
    prgSizesKB: [16, 32],
    chrSizesKB: [8, 16, 32],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 4,
    name: "MMC3 (TxROM)",
    prgSizesKB: [32, 64, 128, 256, 512],
    chrSizesKB: [0, 8, 16, 32, 64, 128, 256],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 8,
  },
  {
    id: 7,
    name: "AxROM",
    prgSizesKB: [64, 128, 256],
    chrSizesKB: [0],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    chrRamKB: 8,
  },
  {
    id: 9,
    name: "MMC2 (PxROM)",
    prgSizesKB: [128],
    chrSizesKB: [128],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 11,
    name: "Color Dreams",
    prgSizesKB: [32, 64, 128],
    chrSizesKB: [8, 16, 32, 64, 128],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 64,
    name: "RAMBO-1",
    prgSizesKB: [64, 128, 256],
    chrSizesKB: [16, 32, 64, 128, 256],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 66,
    name: "GxROM",
    prgSizesKB: [32, 64, 128],
    chrSizesKB: [8, 16, 32],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 69,
    name: "FME-7 (5A/5B)",
    prgSizesKB: [128, 256],
    chrSizesKB: [0, 128, 256],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    maxPrgRamKB: 8,
    chrRamKB: 8,
  },
  {
    id: 71,
    name: "Camerica (BF909x)",
    prgSizesKB: [64, 128, 256],
    chrSizesKB: [0],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    chrRamKB: 8,
  },
  {
    id: 206,
    name: "DxROM",
    prgSizesKB: [32, 64, 128],
    chrSizesKB: [16, 32, 64],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 232,
    name: "Quattro",
    prgSizesKB: [256],
    chrSizesKB: [0],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    chrRamKB: 8,
    warning:
      "Set the A/B switch to position A (lockout-defeat OFF) before dumping — leaving it in B can damage the cart or reader.",
  },
  {
    id: 268,
    name: "Mindkids / CoolBoy",
    // The SMD172 board family ships up to 32 MiB and the dump walk's
    // register math covers all of it (the header builder spills sizes
    // >= 4 MiB into byte 9), but only the sizes listed here have been
    // validated on hardware — extend the list as bigger boards are.
    // Listing conservatively also keeps the default (largest = last)
    // a sane dump length.
    prgSizesKB: [512, 1024, 2048],
    chrSizesKB: [0],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    // No battery — so no save opt-in (maxPrgRamKB 0). But multicarts on
    // this board use volatile PRG-RAM at $6000-$7FFF as the destination
    // for a runtime-copied bank-switch trampoline; without declaring it
    // in the header (byte 10 low nibble), emulators reject the copy and
    // the trampoline-dependent games fail to boot even though the dump
    // is complete.
    maxPrgRamKB: 0,
    prgRamKB: 8,
    chrRamKB: 256,
    // No device-agnostic caveat: incompatibility is per-device
    // (capability.unsupportedMappers greys it out on the INL), and on a
    // device that can drive this board the dump path is hardware-validated.
  },
  {
    id: 413,
    name: "BATMAP",
    // One board, one configuration: 256 KiB PRG + 256 KiB CHR + an
    // 8 MiB sample flash dumped as the NES 2.0 miscellaneous-ROM area.
    prgSizesKB: [256],
    chrSizesKB: [256],
    mirroring: "vertical",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    miscRomKB: 8192,
    // Device-agnostic maturity caveat, same shape as mapper 470's.
    warning:
      "The dump recipe for this board is derived from emulator and FPGA " +
      "sources and not yet hardware-validated — verify the result against " +
      "a known-good reference. The 8 MB sample ROM makes this a long dump.",
  },
  {
    id: 470,
    name: "INX_007T_V01",
    prgSizesKB: [1024],
    chrSizesKB: [0],
    mirroring: "horizontal",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    chrRamKB: 8,
    // Device-agnostic maturity caveat (the INL incompatibility itself is
    // handled per-device via capability.unsupportedMappers).
    warning:
      "The dump recipe for this board is vendor-derived and not yet hardware-validated — verify the result against a known-good reference.",
  },
];

// ─── NES 2.0 header-field options ───────────────────────────────────────────
// Curated choices for the post-dump header editor (unverified dumps only).
// Values match the encodings the NES header helpers expect: timing/mirroring
// use the NesTvSystem/NesMirroring string literals; the rest are raw field
// numbers.

/** CPU/PPU timing (header byte 12) — the closest thing NES 2.0 has to region. */
export const NES_TIMING_OPTIONS: ConfigOption[] = [
  { value: "ntsc", label: "NTSC", hint: "North America / Japan (RP2C02)" },
  { value: "pal", label: "PAL", hint: "Europe / Australia (RP2C07)" },
  { value: "multi", label: "Multi-region" },
  { value: "dendy", label: "Dendy", hint: "Famiclone timing" },
];

/** Console type (header byte 7 bits 0-1). */
export const NES_CONSOLE_TYPE_OPTIONS: ConfigOption[] = [
  { value: 0, label: "NES / Famicom" },
  { value: 1, label: "Vs. System" },
  { value: 2, label: "PlayChoice-10" },
];

/** Nametable mirroring (header byte 6). */
export const NES_MIRRORING_OPTIONS: ConfigOption[] = [
  { value: "horizontal", label: "Horizontal" },
  { value: "vertical", label: "Vertical" },
  { value: "four_screen", label: "Four-screen" },
];

/**
 * Default expansion device (header byte 15). The NES 2.0 spec defines ~60;
 * this is a curated shortlist of the common first-party peripherals. Values
 * are the spec's device IDs.
 */
export const NES_EXPANSION_DEVICE_OPTIONS: ConfigOption[] = [
  { value: 0, label: "Unspecified" },
  { value: 1, label: "Standard Controller" },
  { value: 2, label: "Four Score", hint: "4-player adapter" },
  { value: 8, label: "Zapper", hint: "Light gun" },
  { value: 0x0b, label: "Power Pad" },
];

/** Submapper (header byte 8, high nibble): 0-15. */
export const NES_SUBMAPPER_OPTIONS: ConfigOption[] = Array.from(
  { length: 16 },
  (_, i) => ({ value: i, label: String(i) }),
);

export function getMapperDef(id: number): NESMapperDef | undefined {
  return NES_MAPPER_DB.find((m) => m.id === id);
}

export function coerceToNearest<T>(value: T, options: T[]): T {
  if (options.length === 0) return value;
  if (options.includes(value)) return value;
  return options[0];
}
