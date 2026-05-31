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
  maxPrgRamKB: number;
  /**
   * Volatile CHR-RAM size in KiB. Used by the NES 2.0 header builder
   * (byte 11 low nibble). Mostly 0 (ROM carts); CHR-RAM mappers carry
   * their RAM size here.
   */
  chrRamKB?: number;
  /** Whether this mapper has a dump implementation in the INL driver. */
  dumpSupported?: boolean;
}

/**
 * Mappers offered in the UI. Each is implemented in the shared NES
 * mapper catalog (`./mappers/`) and wired to the INL driver. The list
 * is intentionally small — entries are added back one at a time as each
 * mapper is validated against real hardware.
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
    dumpSupported: true,
  },
  {
    id: 1,
    name: "MMC1 (SxROM)",
    prgSizesKB: [32, 64, 128, 256, 512],
    chrSizesKB: [0, 8, 16, 32, 64, 128],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 8,
    dumpSupported: true,
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
    dumpSupported: true,
  },
  {
    id: 4,
    name: "MMC3 (TxROM)",
    prgSizesKB: [32, 64, 128, 256, 512],
    chrSizesKB: [0, 8, 16, 32, 64, 128, 256],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 8,
    dumpSupported: true,
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
    dumpSupported: true,
  },
  {
    id: 9,
    name: "MMC2 (PxROM)",
    prgSizesKB: [128],
    chrSizesKB: [128],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    dumpSupported: true,
  },
  {
    id: 11,
    name: "Color Dreams",
    prgSizesKB: [32, 64, 128],
    chrSizesKB: [8, 16, 32, 64, 128],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    dumpSupported: true,
  },
  {
    id: 66,
    name: "GxROM",
    prgSizesKB: [32, 64, 128],
    chrSizesKB: [8, 16, 32],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
    dumpSupported: true,
  },
];

export function getMapperDef(id: number): NESMapperDef | undefined {
  return NES_MAPPER_DB.find((m) => m.id === id);
}

export function coerceToNearest<T>(value: T, options: T[]): T {
  if (options.length === 0) return value;
  if (options.includes(value)) return value;
  return options[0];
}
