// PowerSaves for Amiibo portal — HID command bytes
// Protocol reverse-engineered from https://github.com/malc0mn/amiigo (Go)

export const CMD = {
  RF_FIELD_ON: 0x10,
  RF_FIELD_OFF: 0x11,
  GET_TOKEN_UID: 0x12,
  READ: 0x1c,
  UNKNOWN4: 0x1e,
  UNKNOWN1: 0x1f,
  SET_LED_STATE: 0x20,
  READ_SIGNATURE: 0x21,
  MAKE_KEY: 0x30,
} as const;

export const PACKET_SIZE = 64;
export const PAD_BYTE = 0xcd;
export const NTAG215_SIZE = 540;
export const COMMAND_TIMEOUT_MS = 2000;

export const DEVICE_FILTERS: HIDDeviceFilter[] = [
  { vendorId: 0x1c1a, productId: 0x03d9 }, // Datel PowerSaves for Amiibo
  { vendorId: 0x5c60, productId: 0xdead }, // MaxLander / NaMiio
];
