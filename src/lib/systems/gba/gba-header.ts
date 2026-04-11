import type { CartridgeInfo } from "@/lib/types";

// GBA cartridge header offsets
export const GBA_HEADER = {
  ENTRY_POINT: 0x00,
  LOGO: 0x04,
  TITLE: 0xa0,       // 12 bytes
  GAME_CODE: 0xac,    // 4 bytes
  MAKER_CODE: 0xb0,   // 2 bytes
  FIXED_96H: 0xb2,
  UNIT_CODE: 0xb3,
  DEVICE_TYPE: 0xb4,
  VERSION: 0xbc,
  CHECKSUM: 0xbd,
} as const;

export interface GBAHeaderInfo {
  title: string;
  gameCode: string;
  makerCode: string;
  version: number;
  headerChecksum: number;
  headerChecksumValid: boolean;
}

export function parseGBAHeader(data: Uint8Array): GBAHeaderInfo | null {
  if (data.length < 0xc0) return null;

  // Title at 0xA0, 12 bytes, null-terminated ASCII
  let titleEnd = GBA_HEADER.TITLE;
  for (let i = 0; i < 12; i++) {
    if (data[GBA_HEADER.TITLE + i] === 0) break;
    titleEnd = GBA_HEADER.TITLE + i + 1;
  }
  const title = new TextDecoder("ascii")
    .decode(data.slice(GBA_HEADER.TITLE, titleEnd))
    .replace(/[^\x20-\x7e]/g, "");

  // Game code at 0xAC, 4 bytes
  const gameCode = new TextDecoder("ascii")
    .decode(data.slice(GBA_HEADER.GAME_CODE, GBA_HEADER.GAME_CODE + 4))
    .replace(/[^\x20-\x7e]/g, "");

  // Maker code at 0xB0, 2 bytes
  const makerCode = new TextDecoder("ascii")
    .decode(data.slice(GBA_HEADER.MAKER_CODE, GBA_HEADER.MAKER_CODE + 2))
    .replace(/[^\x20-\x7e]/g, "");

  const version = data[GBA_HEADER.VERSION];

  // Header checksum: complement of sum of bytes 0xA0-0xBC
  let checksum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) {
    checksum = (checksum + data[i]) & 0xff;
  }
  checksum = (-(checksum + 0x19)) & 0xff;
  const headerChecksum = data[GBA_HEADER.CHECKSUM];
  const headerChecksumValid = checksum === headerChecksum;

  return {
    title,
    gameCode,
    makerCode,
    version,
    headerChecksum,
    headerChecksumValid,
  };
}

export function gbaHeaderToCartridgeInfo(header: GBAHeaderInfo): CartridgeInfo {
  return {
    title: header.title,
    mapper: { id: 0, name: "None" },
    meta: {
      gameCode: header.gameCode,
      makerCode: header.makerCode,
      version: header.version,
      headerChecksumValid: header.headerChecksumValid,
    },
  };
}
