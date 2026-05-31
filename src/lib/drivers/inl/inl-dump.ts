/**
 * INL Retro — multi-buffer dump engine.
 *
 * The INL firmware can only bank-switch a handful of mappers internally
 * (MAP30/A53/DPROM) — none of ours — so banking stays host-driven in the
 * shared mapper layer, and this engine only reads a fixed CPU/PPU address
 * window (`memType` NESCPU_4KB / NESPPU_1KB / PRGRAM). The firmware streams
 * the window sequentially: each allocated buffer dumps one page, then its
 * `page_num` advances by `reload`, rotating through the buffers.
 *
 * A region's allocation and per-buffer config (`SET_MEM_N_PART`,
 * `SET_MAP_N_MAPVAR`) are independent of which cart bank is selected, so a
 * bank walk allocates once (`allocateRegion`) and per bank only re-zeros
 * `page_num` (`rewindRegion`) and re-`STARTDUMP`s (`streamRegion`). `InlNesBus`
 * drives that reuse; `dumpRegion` is the self-contained one-shot for callers
 * that read a single region.
 *
 * Reference: host/scripts/app/buffers.lua, dump.lua and firmware buffer.c.
 */

import type { INLDevice } from "./inl-device";
import { BUFFER, MEM, OPER, PART, STATUS } from "./inl-opcodes";

/** Raw buffer bank size in bytes (firmware RAW_BANK_SIZE). */
const RAW_BANK_SIZE = 32;

/**
 * Cap how long to wait for a single buffer to report DUMPED. Each poll is a
 * fast USB round-trip, so the loop already yields; exceeding this bound means
 * the transfer stalled or the device faulted, and we error rather than spin
 * forever.
 */
const POLL_TIMEOUT_MS = 5000;

/** One allocated firmware buffer's parameters. */
export interface BufferSlot {
  /** Buffer id byte. Carries A7 of the 256B page (0x00 = low half, 0x80 = high). */
  id: number;
  /** First raw-buffer bank this buffer occupies (`baseBank * RAW_BANK_SIZE` bytes in). */
  baseBank: number;
  /** Initial `page_num` (A15:8 of the read window). */
  firstPage: number;
  /** Amount `page_num` advances after each of this buffer's dumps. */
  reload: number;
}

/** A buffer allocation: N equal-size buffers tiling the 512B raw pool. */
export interface BufferLayout {
  /** Bytes per buffer (≤256; must divide 1024). */
  buffSize: number;
  slots: BufferSlot[];
}

/**
 * Legacy 2×128B double buffer (firmware default, reload=1). Kept for hardware
 * A/B against the 4-buffer layout.
 */
export const LAYOUT_2x128: BufferLayout = {
  buffSize: 128,
  slots: [
    { id: 0x00, baseBank: 0, firstPage: 0, reload: 1 },
    { id: 0x80, baseBank: 4, firstPage: 0, reload: 1 },
  ],
};

/**
 * 4×128B quad buffer filling the whole 16-bank (512B) raw pool. Two buffers
 * cover each 256B page (low half id=0x00, high half id=0x80); buff0/1 stream
 * page P, buff2/3 stream page P+1, and reload=2 re-fires each buffer every two
 * pages — so the rotation buff0→1→2→3 emits strictly contiguous 128B chunks.
 * Deeper pipeline than 2×128B keeps more pages pre-dumped, cutting wasted
 * status polls.
 */
export const LAYOUT_4x128: BufferLayout = {
  buffSize: 128,
  slots: [
    { id: 0x00, baseBank: 0, firstPage: 0, reload: 2 },
    { id: 0x80, baseBank: 4, firstPage: 0, reload: 2 },
    { id: 0x00, baseBank: 8, firstPage: 1, reload: 2 },
    { id: 0x80, baseBank: 12, firstPage: 1, reload: 2 },
  ],
};

export const DEFAULT_LAYOUT = LAYOUT_4x128;

/** The firmware addressing for a region: memory type + host-side bank hint. */
export interface RegionCfg {
  /** MEM.* — NESCPU_4KB / NESPPU_1KB / PRGRAM etc. */
  memType: number;
  /** SET_MAP_N_MAPVAR high byte. For NESCPU_4KB/NESPPU_1KB this is the address-page hint. */
  mapper: number;
  /** SET_MAP_N_MAPVAR low byte (mapper variant). */
  mapVar: number;
}

export interface DumpRegionOptions extends RegionCfg {
  sizeKB: number;
  onProgress?: (bytesRead: number, totalBytes: number) => void;
}

/** PRG-RAM is SRAM-backed; everything else we read is mask ROM. */
function partFor(memType: number): number {
  return memType === MEM.PRGRAM ? PART.SRAM : PART.MASKROM;
}

/**
 * Allocate the layout's buffers and configure every one for `cfg`. Resets the
 * buffer pool first (freeing any prior allocation, which the firmware requires
 * before re-allocating). After this, `page_num` sits at each buffer's
 * firstPage, so the first `streamRegion` needs no rewind.
 */
export async function allocateRegion(
  device: INLDevice,
  cfg: RegionCfg,
  layout: BufferLayout,
): Promise<void> {
  await device.operation(OPER.SET_OPERATION, STATUS.RESET);
  await device.buffer(BUFFER.RAW_BUFFER_RESET);

  const numBanks = layout.buffSize / RAW_BANK_SIZE;
  for (let n = 0; n < layout.slots.length; n++) {
    const slot = layout.slots[n];
    await device.buffer(
      BUFFER.ALLOCATE_BUFFER0 + n,
      (slot.id << 8) | slot.baseBank,
      numBanks,
    );
  }
  await rewindRegion(device, layout);

  const memPart = (cfg.memType << 8) | partFor(cfg.memType);
  for (let n = 0; n < layout.slots.length; n++) {
    await device.buffer(BUFFER.SET_MEM_N_PART, memPart, n);
  }
  const mapVar = (cfg.mapper << 8) | cfg.mapVar;
  for (let n = 0; n < layout.slots.length; n++) {
    await device.buffer(BUFFER.SET_MAP_N_MAPVAR, mapVar, n);
  }
}

/**
 * Re-zero each buffer's `page_num` to its firstPage. STARTDUMP re-initializes
 * buffer *status* but not `page_num`, so a reused allocation must rewind here
 * before streaming the next bank's window.
 */
export async function rewindRegion(
  device: INLDevice,
  layout: BufferLayout,
): Promise<void> {
  for (let n = 0; n < layout.slots.length; n++) {
    const slot = layout.slots[n];
    await device.buffer(BUFFER.SET_RELOAD_PAGENUM0 + n, slot.firstPage, slot.reload);
  }
}

/**
 * STARTDUMP the (already-allocated, already-rewound) buffers and pull
 * `sizeKB * 1024` bytes, one `buffSize` payload per poll-and-read.
 */
export async function streamRegion(
  device: INLDevice,
  sizeKB: number,
  layout: BufferLayout,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
): Promise<Uint8Array> {
  const totalBytes = sizeKB * 1024;
  const numChunks = totalBytes / layout.buffSize;

  await device.operation(OPER.SET_OPERATION, STATUS.STARTDUMP);

  const result = new Uint8Array(totalBytes);
  let bytesRead = 0;

  for (let i = 0; i < numChunks; i++) {
    // Poll until the current buffer reports DUMPED. Each poll is a USB
    // round-trip (so the loop yields), but a stalled transfer or device fault
    // could otherwise never report DUMPED and hang the dump forever — bound the
    // wait and surface it as an error instead.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let status = await device.buffer(BUFFER.GET_CUR_BUFF_STATUS);
    while (status !== STATUS.DUMPED) {
      if (Date.now() > deadline) {
        throw new Error(
          `INL dump stalled: buffer ${i + 1}/${numChunks} never reported DUMPED ` +
            `within ${POLL_TIMEOUT_MS}ms (last status 0x${status.toString(16)})`,
        );
      }
      status = await device.buffer(BUFFER.GET_CUR_BUFF_STATUS);
    }

    const chunk = await device.payloadIn(layout.buffSize);
    result.set(chunk, bytesRead);
    bytesRead += chunk.length;

    onProgress?.(bytesRead, totalBytes);
  }

  return result;
}

/** Tear down the buffer allocation (RESET + RAW_BUFFER_RESET). */
export async function resetBuffers(device: INLDevice): Promise<void> {
  await device.operation(OPER.SET_OPERATION, STATUS.RESET);
  await device.buffer(BUFFER.RAW_BUFFER_RESET);
}

/**
 * Dump a single memory region: allocate, stream, tear down. Self-contained for
 * callers that read one region (the SRAM save path, fixed-bank PRG). A bank
 * walk should drive `allocateRegion`/`rewindRegion`/`streamRegion` directly
 * (via `InlNesBus`) to reuse the allocation across banks.
 */
export async function dumpRegion(
  device: INLDevice,
  opts: DumpRegionOptions,
  layout: BufferLayout = DEFAULT_LAYOUT,
): Promise<Uint8Array> {
  const cfg: RegionCfg = {
    memType: opts.memType,
    mapper: opts.mapper,
    mapVar: opts.mapVar,
  };
  await allocateRegion(device, cfg, layout);
  const out = await streamRegion(device, opts.sizeKB, layout, opts.onProgress);
  await resetBuffers(device);
  return out;
}
