/**
 * INL Retro Programmer — dictionary IDs, opcodes, and buffer constants.
 *
 * Derived from the shared headers in the INL-retro-progdump firmware:
 *   shared/shared_dictionaries.h
 *   shared/shared_dict_io.h
 *   shared/shared_dict_nes.h
 *   shared/shared_dict_buff.h
 *   shared/shared_dict_operation.h
 */

// ─── Dictionary IDs (sent as USB bRequest) ──────────────────────────────────

export const DICT = {
  PINPORT: 1,
  IO: 2,
  NES: 3,
  BUFFER: 5,
  OPER: 7,
} as const;

// ─── PINPORT Dictionary ─────────────────────────────────────────────────────

export const PINPORT = {
  CTL_RD: 6, // RL=4 — read a control pin
  ADDR_SET: 17, // set address bus value
  // Control pin operand IDs for CTL_RD
  CIA10: 11, // CIRAM A10 (nametable mirroring)
  CICE: 6, // CIRAM /CE
} as const;

// ─── IO Dictionary ──────────────────────────────────────────────────────────

export const IO = {
  IO_RESET: 0x00,
  NES_INIT: 0x01,
  SNES_INIT: 0x02,
  GAMEBOY_INIT: 0x05,
  GBA_INIT: 0x06,
  SEGA_INIT: 0x07,
  N64_INIT: 0x08,
  EXP0_PULLUP_TEST: 0x80,
} as const;

// ─── NES Dictionary ─────────────────────────────────────────────────────────

export const NES = {
  // Write operations (no return value)
  DISCRETE_EXP0_PRGROM_WR: 0x00,
  NES_PPU_WR: 0x01,
  NES_CPU_WR: 0x02,
  NES_MMC1_WR: 0x04,
  NES_DUALPORT_WR: 0x05,
  // Flash-program a byte on an MMC3 board: three JEDEC unlock writes
  // ($D555/$AAAA/$D555), then the (operand, misc) write, then $8000<-2 and
  // a stability poll-read — ALL inside one USB transaction, each a full
  // nes_cpu_wr M2 cycle microseconds apart. Caution: the tail poll re-reads
  // the WRITTEN address until two consecutive reads agree, so a target
  // whose reads flicker (e.g. $5xxx on the mapper-268 board) spins the
  // firmware until a physical replug — which is exactly why it is NOT used
  // as an M2-burst write primitive (see UNSUPPORTED_MAPPERS in
  // ./unsupported-mappers).
  MMC3_PRG_FLASH_WR: 0x07,
  SET_CUR_BANK: 0x20,
  SET_BANK_TABLE: 0x21,
  SET_NUM_PRG_BANKS: 0x24,

  // Read operations (return value in response)
  EMULATE_NES_CPU_RD: 0x80,
  NES_CPU_RD: 0x81,
  NES_PPU_RD: 0x82,
  CIRAM_A10_MIRROR: 0x83,
  NES_DUALPORT_RD: 0x84,
  GET_CUR_BANK: 0x85,
  GET_BANK_TABLE: 0x86,
  GET_NUM_PRG_BANKS: 0x87,
} as const;

// ─── Buffer Dictionary ──────────────────────────────────────────────────────

export const BUFFER = {
  // No return value
  RAW_BUFFER_RESET: 0x00,
  SET_MEM_N_PART: 0x30,
  SET_MULT_N_ADDMULT: 0x31,
  SET_MAP_N_MAPVAR: 0x32,

  // Return value
  GET_PRI_ELEMENTS: 0x50,
  GET_SEC_ELEMENTS: 0x51,
  GET_CUR_BUFF_STATUS: 0x61,
  BUFF_PAYLOAD: 0x70,

  // Per-buffer allocation (buffer index encoded in opcode)
  ALLOCATE_BUFFER0: 0x80,
  ALLOCATE_BUFFER1: 0x81,

  // Per-buffer dump-position init (buffer index encoded in opcode):
  // operand = first page_num, misc = reload (added to the buffer's page_num
  // after each of its dumps, advancing it through the region).
  SET_RELOAD_PAGENUM0: 0x90,
  SET_RELOAD_PAGENUM1: 0x91,
} as const;

// ─── Operation Dictionary ───────────────────────────────────────────────────

export const OPER = {
  SET_OPERATION: 0x00,
  GET_OPERATION: 0x40,
} as const;

// ─── Memory types (used in SET_MEM_N_PART) ──────────────────────────────────

export const MEM = {
  PRGROM: 0x10,
  CHRROM: 0x11,
  PRGRAM: 0x12,
  NESCPU_4KB: 0x20,
  NESPPU_1KB: 0x21,
  NESCPU_PAGE: 0x22,
  NESPPU_PAGE: 0x23,
  NESCPU_4KB_TOGGLE: 0x32,
  // Mapper 413 (BATMAP) serial-flash data port: firmware reads each
  // byte as 8 dummy cart-ROM reads (SPI clocks) + one $C000 port read.
  // The host opens the SPI frame first — see InlNesBus.readSpiDataPort.
  NESCPU_SPI413: 0x33,
} as const;

// ─── Part numbers ───────────────────────────────────────────────────────────

export const PART = {
  MASKROM: 0xdd,
  SRAM: 0xaa,
} as const;

// ─── Mapper IDs (used in SET_MAP_N_MAPVAR) ──────────────────────────────────

export const MAPPER = {
  NROM: 0,
  MMC1: 1,
  UxROM: 2,
  CNROM: 3,
  MMC3: 4,
  MMC5: 5,
  AxROM: 7,
  MMC2: 9,
  MMC4: 10,
  FME7: 69,
} as const;

// ─── Mapper variants ────────────────────────────────────────────────────────

export const MAPVAR = {
  NOVAR: 0,
} as const;

// ─── Buffer/Operation status values ─────────────────────────────────────────

export const STATUS = {
  EMPTY: 0x00,
  RESET: 0x01,
  DUMPED: 0xd8,
  STARTDUMP: 0xd2,
  DUMPING: 0xd0,
} as const;

// ─── USB response format ────────────────────────────────────────────────────

export const RETURN = {
  ERR_IDX: 0,
  LEN_IDX: 1,
  DATA_IDX: 2,
} as const;

export const SUCCESS = 0x00;

// ─── Device identifiers ─────────────────────────────────────────────────────

export const INL_DEVICE_FILTER = {
  vendorId: 0x16c0,
  productId: 0x05dc,
} as const;

// ─── Mirroring values (from CIRAM_A10_MIRROR response) ──────────────────────

export const MIRROR = {
  VERTICAL: 0x12,
  HORIZONTAL: 0x13,
  ONE_SCREEN_A: 0x10,
  ONE_SCREEN_B: 0x11,
} as const;
