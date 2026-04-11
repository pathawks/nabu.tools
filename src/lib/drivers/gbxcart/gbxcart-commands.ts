// GBxCart RW command opcodes (from FlashGBX LK_Device.py)

export const CMD = {
  // Original firmware
  OFW_PCB_VER: 0x68,
  OFW_FW_VER: 0x56,
  OFW_USART_1_5M_SPEED: 0x3e,
  OFW_CART_MODE: 0x43,

  // Custom firmware
  QUERY_FW_INFO: 0xa1,
  SET_MODE_AGB: 0xa2,
  SET_MODE_DMG: 0xa3,
  SET_VOLTAGE_3_3V: 0xa4,
  SET_VOLTAGE_5V: 0xa5,
  SET_VARIABLE: 0xa6,
  GET_VARIABLE: 0xad,

  // DMG (Game Boy)
  DMG_CART_READ: 0xb1,
  DMG_CART_WRITE: 0xb2,
  DMG_MBC_RESET: 0xb4,

  // AGB (GBA)
  AGB_CART_READ: 0xc1,
  AGB_CART_WRITE: 0xc2,
  AGB_CART_READ_SRAM: 0xc3,
  AGB_CART_WRITE_SRAM: 0xc4,
  AGB_BOOTUP_SEQUENCE: 0xc9,

  // Misc
  DISABLE_PULLUPS: 0xac,

  // System
  CART_PWR_ON: 0xf2,
  CART_PWR_OFF: 0xf3,
  QUERY_CART_PWR: 0xf4,
} as const;

// Firmware variable definitions: [bitWidth, index]
export const VAR = {
  // 32-bit
  ADDRESS: [32, 0x00] as const,
  // 16-bit
  TRANSFER_SIZE: [16, 0x00] as const,
  BUFFER_SIZE: [16, 0x01] as const,
  DMG_ROM_BANK: [16, 0x02] as const,
  // 8-bit
  CART_MODE: [8, 0x00] as const,
  DMG_ACCESS_MODE: [8, 0x01] as const,
  DMG_READ_CS_PULSE: [8, 0x08] as const,
  DMG_WRITE_CS_PULSE: [8, 0x09] as const,
  DMG_READ_METHOD: [8, 0x0b] as const,
  AGB_READ_METHOD: [8, 0x0c] as const,
  AGB_IRQ_ENABLED: [8, 0x10] as const,
} as const;

// Access modes for DMG_ACCESS_MODE
export const DMG_ACCESS = {
  ROM: 1,
  SRAM: 2,
} as const;

// ACK values
export const ACK_OK = [0x01, 0x03];
