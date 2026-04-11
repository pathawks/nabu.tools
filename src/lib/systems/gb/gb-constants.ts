// Game Boy cartridge header offsets (relative to 0x0000)
export const GB_HEADER = {
  ENTRY_POINT: 0x100,
  LOGO: 0x104,
  TITLE: 0x134,
  CGB_FLAG: 0x143,
  NEW_LICENSEE: 0x144,
  SGB_FLAG: 0x146,
  CART_TYPE: 0x147,
  ROM_SIZE: 0x148,
  RAM_SIZE: 0x149,
  DEST_CODE: 0x14a,
  OLD_LICENSEE: 0x14b,
  VERSION: 0x14c,
  HEADER_CHECKSUM: 0x14d,
  GLOBAL_CHECKSUM: 0x14e,
} as const;

export const GB_CART_TYPES: Record<number, { name: string; mbc: string; ram: boolean; battery: boolean }> = {
  0x00: { name: "ROM ONLY", mbc: "None", ram: false, battery: false },
  0x01: { name: "MBC1", mbc: "MBC1", ram: false, battery: false },
  0x02: { name: "MBC1+RAM", mbc: "MBC1", ram: true, battery: false },
  0x03: { name: "MBC1+RAM+BATTERY", mbc: "MBC1", ram: true, battery: true },
  0x05: { name: "MBC2", mbc: "MBC2", ram: true, battery: false },
  0x06: { name: "MBC2+BATTERY", mbc: "MBC2", ram: true, battery: true },
  0x08: { name: "ROM+RAM", mbc: "None", ram: true, battery: false },
  0x09: { name: "ROM+RAM+BATTERY", mbc: "None", ram: true, battery: true },
  0x0f: { name: "MBC3+TIMER+BATTERY", mbc: "MBC3", ram: false, battery: true },
  0x10: { name: "MBC3+TIMER+RAM+BATTERY", mbc: "MBC3", ram: true, battery: true },
  0x11: { name: "MBC3", mbc: "MBC3", ram: false, battery: false },
  0x12: { name: "MBC3+RAM", mbc: "MBC3", ram: true, battery: false },
  0x13: { name: "MBC3+RAM+BATTERY", mbc: "MBC3", ram: true, battery: true },
  0x19: { name: "MBC5", mbc: "MBC5", ram: false, battery: false },
  0x1a: { name: "MBC5+RAM", mbc: "MBC5", ram: true, battery: false },
  0x1b: { name: "MBC5+RAM+BATTERY", mbc: "MBC5", ram: true, battery: true },
  0x1c: { name: "MBC5+RUMBLE", mbc: "MBC5", ram: false, battery: false },
  0x1d: { name: "MBC5+RUMBLE+RAM", mbc: "MBC5", ram: true, battery: false },
  0x1e: { name: "MBC5+RUMBLE+RAM+BATTERY", mbc: "MBC5", ram: true, battery: true },
  0x20: { name: "MBC6", mbc: "MBC6", ram: true, battery: true },
  0x22: { name: "MBC7+SENSOR+RUMBLE+RAM+BATTERY", mbc: "MBC7", ram: true, battery: true },
  0xfc: { name: "POCKET CAMERA", mbc: "CAMERA", ram: true, battery: true },
  0xfe: { name: "HuC3", mbc: "HuC3", ram: true, battery: true },
  0xff: { name: "HuC1+RAM+BATTERY", mbc: "HuC1", ram: true, battery: true },
};

// ROM size code -> bytes
export const GB_ROM_SIZES: Record<number, number> = {
  0x00: 32 * 1024,      //  32 KB -  2 banks
  0x01: 64 * 1024,      //  64 KB -  4 banks
  0x02: 128 * 1024,     // 128 KB -  8 banks
  0x03: 256 * 1024,     // 256 KB - 16 banks
  0x04: 512 * 1024,     // 512 KB - 32 banks
  0x05: 1024 * 1024,    //   1 MB - 64 banks
  0x06: 2 * 1024 * 1024, //  2 MB - 128 banks
  0x07: 4 * 1024 * 1024, //  4 MB - 256 banks
  0x08: 8 * 1024 * 1024, //  8 MB - 512 banks
};

// RAM size code -> bytes
export const GB_RAM_SIZES: Record<number, number> = {
  0x00: 0,
  0x01: 0,         // Listed in header but unused
  0x02: 8 * 1024,  //   8 KB -  1 bank
  0x03: 32 * 1024, //  32 KB -  4 banks
  0x04: 128 * 1024, // 128 KB - 16 banks
  0x05: 64 * 1024,  //  64 KB -  8 banks
};
