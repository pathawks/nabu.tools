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
  /** Whether this mapper has a dump implementation in the INL driver. */
  dumpSupported?: boolean;
}

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
    maxPrgRamKB: 32,
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
    dumpSupported: true,
  },
  {
    id: 3,
    name: "CNROM",
    prgSizesKB: [16, 32],
    chrSizesKB: [8, 16, 32],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
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
    id: 5,
    name: "MMC5 (ExROM)",
    prgSizesKB: [128, 256, 512, 1024],
    chrSizesKB: [0, 128, 256, 512],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 64,
    dumpSupported: true,
  },
  {
    id: 7,
    name: "AxROM",
    prgSizesKB: [128, 256],
    chrSizesKB: [0],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
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
    id: 10,
    name: "MMC4 (FxROM)",
    prgSizesKB: [128, 256],
    chrSizesKB: [64, 128],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 8,
    dumpSupported: true,
  },
  {
    id: 11,
    name: "Color Dreams",
    prgSizesKB: [32, 64, 128],
    chrSizesKB: [16, 32, 64, 128],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 19,
    name: "Namco 163",
    prgSizesKB: [128, 256],
    chrSizesKB: [0, 128, 256],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 0,
  },
  {
    id: 24,
    name: "VRC6a",
    prgSizesKB: [256],
    chrSizesKB: [128],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 26,
    name: "VRC6b",
    prgSizesKB: [256],
    chrSizesKB: [128],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 8,
  },
  {
    id: 34,
    name: "BNROM / NINA-001",
    prgSizesKB: [64, 128],
    chrSizesKB: [0],
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
  },
  {
    id: 69,
    name: "FME-7 (Sunsoft)",
    prgSizesKB: [128, 256],
    chrSizesKB: [0, 128, 256],
    mirroring: "mapper_controlled",
    commonlyHasBattery: true,
    maxPrgRamKB: 8,
    dumpSupported: true,
  },
  {
    id: 71,
    name: "Camerica/Codemasters",
    prgSizesKB: [64, 128, 256],
    chrSizesKB: [0],
    mirroring: "mapper_controlled",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
  },
  {
    id: 206,
    name: "DxROM / Namco 108",
    prgSizesKB: [32, 64, 128],
    chrSizesKB: [16, 32, 64],
    mirroring: "selectable",
    commonlyHasBattery: false,
    maxPrgRamKB: 0,
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
