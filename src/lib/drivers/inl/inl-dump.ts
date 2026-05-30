/**
 * INL Retro — double-buffered dump engine.
 *
 * Implements the buffer allocation, STARTDUMP, poll-and-read sequence
 * shared by all NES mappers.
 *
 * Reference: host/scripts/app/buffers.lua and host/scripts/app/dump.lua
 */

import type { INLDevice } from "./inl-device";
import {
  BUFFER,
  OPER,
  STATUS,
  PART,
} from "./inl-opcodes";

const BUFF_SIZE = 128;
const RAW_BANK_SIZE = 32;
const NUM_BANKS_PER_BUFF = BUFF_SIZE / RAW_BANK_SIZE; // 4

export interface DumpRegionOptions {
  sizeKB: number;
  memType: number;
  mapper: number;
  mapVar: number;
  onProgress?: (bytesRead: number, totalBytes: number) => void;
}

/**
 * Allocate 2x128B double buffers on the device.
 *
 * Buffer layout for 2x128B:
 *   buff0: id=0x00, basebank=0, numbanks=4 (128/32)
 *   buff1: id=0x80, basebank=4, numbanks=4
 *   reload=1 (page_num increments by 1 after both buffers complete)
 *
 * Reference: host/scripts/app/buffers.lua allocate()
 */
async function allocateBuffers(device: INLDevice): Promise<void> {
  const buff0basebank = 0;
  const buff1basebank = NUM_BANKS_PER_BUFF;
  const buff0id = 0x00;
  const buff1id = 0x80;
  const reload = 0x01;

  // Allocate buffer0: operand = (id << 8) | basebank, index = numbanks
  await device.buffer(
    BUFFER.ALLOCATE_BUFFER0,
    (buff0id << 8) | buff0basebank,
    NUM_BANKS_PER_BUFF,
  );
  // Allocate buffer1
  await device.buffer(
    BUFFER.ALLOCATE_BUFFER1,
    (buff1id << 8) | buff1basebank,
    NUM_BANKS_PER_BUFF,
  );

  // Set first page and reload for each buffer
  // SET_RELOAD_PAGENUM0 = 0x90, SET_RELOAD_PAGENUM1 = 0x91
  await device.buffer(0x90, 0x0000, reload); // buff0: firstpage=0, reload=1
  await device.buffer(0x91, 0x0000, reload); // buff1: firstpage=0, reload=1
}

/**
 * Dump a memory region using the INL double-buffered protocol.
 *
 * Sequence:
 *   1. RESET operation + RAW_BUFFER_RESET
 *   2. Allocate 2x128B buffers with proper bank/id/reload config
 *   3. Configure buffers (memory type, mapper)
 *   4. STARTDUMP
 *   5. Poll GET_CUR_BUFF_STATUS until DUMPED, read payload
 *   6. Repeat until all data read
 *   7. RESET + RAW_BUFFER_RESET
 */
export async function dumpRegion(
  device: INLDevice,
  opts: DumpRegionOptions,
): Promise<Uint8Array> {
  const totalBytes = opts.sizeKB * 1024;
  const numChunks = totalBytes / BUFF_SIZE;

  // Reset buffers
  await device.operation(OPER.SET_OPERATION, STATUS.RESET);
  await device.buffer(BUFFER.RAW_BUFFER_RESET);

  // Allocate 2x128B double buffers
  await allocateBuffers(device);

  // Configure both buffers: memory type + part number
  const memPart = (opts.memType << 8) | PART.MASKROM;
  await device.buffer(BUFFER.SET_MEM_N_PART, memPart, 0);
  await device.buffer(BUFFER.SET_MEM_N_PART, memPart, 1);

  // Configure both buffers: mapper + variant
  const mapVar = (opts.mapper << 8) | opts.mapVar;
  await device.buffer(BUFFER.SET_MAP_N_MAPVAR, mapVar, 0);
  await device.buffer(BUFFER.SET_MAP_N_MAPVAR, mapVar, 1);

  // Start dumping
  await device.operation(OPER.SET_OPERATION, STATUS.STARTDUMP);

  // Read data in 128-byte chunks
  const result = new Uint8Array(totalBytes);
  let bytesRead = 0;

  for (let i = 0; i < numChunks; i++) {
    // Poll until current buffer is DUMPED
    let status = await device.buffer(BUFFER.GET_CUR_BUFF_STATUS);
    while (status !== STATUS.DUMPED) {
      status = await device.buffer(BUFFER.GET_CUR_BUFF_STATUS);
    }

    // Read the payload
    const chunk = await device.payloadIn(BUFF_SIZE);
    result.set(chunk, bytesRead);
    bytesRead += chunk.length;

    opts.onProgress?.(bytesRead, totalBytes);
  }

  // Reset
  await device.operation(OPER.SET_OPERATION, STATUS.RESET);
  await device.buffer(BUFFER.RAW_BUFFER_RESET);

  return result;
}
