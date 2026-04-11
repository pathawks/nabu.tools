import { GB_HEADER, GB_CART_TYPES, GB_ROM_SIZES, GB_RAM_SIZES } from "./gb-constants";
import type { CartridgeInfo } from "@/lib/types";

export interface GBHeaderInfo {
  title: string;
  isCGB: boolean;
  isSGB: boolean;
  cartType: number;
  cartTypeName: string;
  mbc: string;
  hasRam: boolean;
  hasBattery: boolean;
  romSizeCode: number;
  romSize: number;
  ramSizeCode: number;
  ramSize: number;
  headerChecksum: number;
  headerChecksumValid: boolean;
}

export function parseGBHeader(data: Uint8Array): GBHeaderInfo | null {
  if (data.length < 0x150) return null;

  // Extract title (0x134-0x143, null-terminated ASCII)
  let titleEnd = GB_HEADER.TITLE;
  const titleMaxLen = 16;
  for (let i = 0; i < titleMaxLen; i++) {
    if (data[GB_HEADER.TITLE + i] === 0) break;
    titleEnd = GB_HEADER.TITLE + i + 1;
  }
  const title = new TextDecoder("ascii")
    .decode(data.slice(GB_HEADER.TITLE, titleEnd))
    .replace(/[^\x20-\x7e]/g, "");

  const cgbFlag = data[GB_HEADER.CGB_FLAG];
  const isCGB = cgbFlag === 0x80 || cgbFlag === 0xc0;

  const sgbFlag = data[GB_HEADER.SGB_FLAG];
  const isSGB = sgbFlag === 0x03;

  const cartType = data[GB_HEADER.CART_TYPE];
  const cartInfo = GB_CART_TYPES[cartType] ?? {
    name: `Unknown (0x${cartType.toString(16).padStart(2, "0")})`,
    mbc: "Unknown",
    ram: false,
    battery: false,
  };

  const romSizeCode = data[GB_HEADER.ROM_SIZE];
  const romSize = GB_ROM_SIZES[romSizeCode] ?? 32 * 1024;

  const ramSizeCode = data[GB_HEADER.RAM_SIZE];
  // MBC2 has built-in 512x4 bits RAM regardless of header
  const ramSize =
    cartInfo.mbc === "MBC2" ? 512 : (GB_RAM_SIZES[ramSizeCode] ?? 0);

  // Verify header checksum (0x134-0x14C)
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) {
    checksum = (checksum - data[i] - 1) & 0xff;
  }
  const headerChecksum = data[GB_HEADER.HEADER_CHECKSUM];
  const headerChecksumValid = checksum === headerChecksum;

  return {
    title,
    isCGB,
    isSGB,
    cartType,
    cartTypeName: cartInfo.name,
    mbc: cartInfo.mbc,
    hasRam: cartInfo.ram,
    hasBattery: cartInfo.battery,
    romSizeCode,
    romSize,
    ramSizeCode,
    ramSize,
    headerChecksum,
    headerChecksumValid,
  };
}

export function gbHeaderToCartridgeInfo(header: GBHeaderInfo): CartridgeInfo {
  return {
    title: header.title,
    mapper: { id: header.cartType, name: header.mbc },
    romSize: header.romSize,
    saveSize: header.hasBattery ? header.ramSize : 0,
    saveType: header.hasBattery ? "SRAM" : undefined,
    meta: {
      cartTypeName: header.cartTypeName,
      isCGB: header.isCGB,
      isSGB: header.isSGB,
      headerChecksumValid: header.headerChecksumValid,
    },
  };
}
