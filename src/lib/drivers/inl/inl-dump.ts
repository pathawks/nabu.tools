/**
 * INL Retro — double-buffered dump engine.
 *
 * Implements the buffer allocation, STARTDUMP, poll-and-read sequence
 * shared by all NES mappers.
 *
 * The firmware's dump engine is mapper-agnostic: it streams a fixed CPU/PPU
 * address window (NESCPU_4KB / NESPPU_1KB / PRGRAM) and knows nothing about
 * cart banking — its few "native" mappers (MAP30/A53/DPROM) are the vendor's
 * flashable homebrew boards, a flash write/read-back path rather than a
 * general dump facility. Banking is host-driven in the shared mapper layer.
 *
 * ── Why 2×128B buffers, and why this is as fast as this firmware dumps ──
 *
 * The firmware allocates buffers from a 512B raw pool (16 banks × 32B) and
 * is compiled NUM_BUFFERS_4, so larger layouts (4×128B) are accepted — but
 * not faster. A 4×128B layout plus a per-region setup hoist (allocate once,
 * rewind page_num + re-STARTDUMP per bank) was implemented and benchmarked
 * on hardware in 2026-06 against NROM, 8KB-banked, and small-CHR-window
 * carts: byte-identical output, wall-clock parity on every cart. The
 * firmware source explains why:
 *
 * - The pipeline is hard-limited to ONE buffer ahead. buffer.c's DUMPING
 *   state machine only dumps the next buffer after the host's IN transfer
 *   for the current one completes (the USB_UNLOADING gate), no matter how
 *   many buffers are allocated — extra buffers are never filled ahead.
 * - Wall-clock is dominated by the two control transfers per 128B chunk
 *   (status poll + payload, ≈9ms ≈ 13KB/s end to end). The dozen-or-so
 *   tiny setup transfers per region are off the critical path, which is
 *   why hoisting them gains nothing.
 * - Bigger chunks can't help either. A buffer fills within a single 256B
 *   page (the address high byte is latched once for the whole fill; the
 *   buffer's id supplies the starting low byte), so only sizes that tile a
 *   page exactly are valid: 128B half-pages or a full 256B page. 254B isn't
 *   even allocatable (buffers are whole 32B raw banks), a 224B buffer would
 *   silently skip bytes 224-255 of every page, and 256B is doubly dead — a
 *   full buffer sets last_idx=255, which the firmware's uint8 fill loop
 *   (`for (i=0; i<=last_idx; i++)`) never exits, and V-USB caps a control
 *   read at 254 bytes so it couldn't be pulled in one transfer anyway.
 *
 * So the per-chunk round-trip is this firmware's floor; faster dumps need
 * firmware changes, not host changes.
 *
 * Reference: host/scripts/app/buffers.lua and host/scripts/app/dump.lua,
 * firmware/source/buffer.c (INL-retro-progdump).
 */

import type { INLDevice } from "./inl-device";
import { BUFFER, MEM, OPER, PART, STATUS } from "./inl-opcodes";

const BUFF_SIZE = 128;
const RAW_BANK_SIZE = 32;
const NUM_BANKS_PER_BUFF = BUFF_SIZE / RAW_BANK_SIZE; // 4

/**
 * Cap how long to wait for a single buffer to report DUMPED. Each poll is a
 * fast USB round-trip, so the loop already yields; exceeding this bound means
 * the transfer stalled or the device faulted, and we error rather than spin
 * forever.
 */
const POLL_TIMEOUT_MS = 5000;

export interface DumpRegionOptions {
  sizeKB: number;
  memType: number;
  mapper: number;
  mapVar: number;
  onProgress?: (bytesRead: number, totalBytes: number) => void;
  /**
   * Abort signal, checked once per 128-byte chunk. Without it an abort only
   * lands at region boundaries — tens of seconds on a large region — while
   * the UI already reports the dump stopped. The throw unwinds through the
   * `finally` below, so the operation engine is reset on the way out.
   */
  signal?: AbortSignal;
}

/**
 * Reset the firmware's dump-operation engine and discard any allocated
 * buffers, returning it to a known-idle state.
 *
 * This is the lockstep-recovery primitive: the host and firmware track the
 * dump position jointly (the host polls `GET_CUR_BUFF_STATUS` and pulls each
 * 128-byte payload; the firmware advances its page/buffer pointer in step).
 * If a dump unwinds abnormally — a poll timeout, a device error byte, a
 * `payloadIn` fault, or an abort surfacing as a throw — the firmware is left
 * mid-region in `STARTDUMP`/`DUMPING` with buffers still allocated and its
 * read pointer offset from where the next dump assumes it is. Reading payload
 * against that stale pointer is exactly what yields a byte-SHIFTED next dump.
 *
 * Issuing `SET_OPERATION RESET` + `RAW_BUFFER_RESET` clears the operation
 * state and frees the buffers, re-synchronising host and firmware. It runs at
 * the start of every region (so a prior abnormal exit can't poison a fresh
 * dump) and in `dumpRegion`'s `finally` (so an abnormal exit cleans up after
 * itself). Transfer errors propagate from here: the leading call rightly
 * fails the dump when the device won't respond, while the `finally` call
 * site wraps this in its own try/catch so a failed *cleanup* reset (e.g.
 * the device was unplugged mid-dump) can't mask the original error.
 */
async function resetDumpEngine(device: INLDevice): Promise<void> {
  await device.operation(OPER.SET_OPERATION, STATUS.RESET);
  await device.buffer(BUFFER.RAW_BUFFER_RESET);
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

  // Reset the operation engine before configuring this region. Doing this at
  // the *start* means even if a prior dumpRegion exited abnormally and somehow
  // skipped its own cleanup, we re-synchronise here before reading any payload.
  await resetDumpEngine(device);

  const result = new Uint8Array(totalBytes);
  let bytesRead = 0;

  try {
    // Allocate 2x128B double buffers
    await allocateBuffers(device);

    // Configure both buffers: memory type + part number. PRG-RAM is
    // SRAM-backed; every other region we read is mask ROM. The part must match
    // the region so the firmware drives the right chip — a save read with the
    // mask-ROM part would target the wrong device.
    const part = opts.memType === MEM.PRGRAM ? PART.SRAM : PART.MASKROM;
    const memPart = (opts.memType << 8) | part;
    await device.buffer(BUFFER.SET_MEM_N_PART, memPart, 0);
    await device.buffer(BUFFER.SET_MEM_N_PART, memPart, 1);

    // Configure both buffers: mapper + variant
    const mapVar = (opts.mapper << 8) | opts.mapVar;
    await device.buffer(BUFFER.SET_MAP_N_MAPVAR, mapVar, 0);
    await device.buffer(BUFFER.SET_MAP_N_MAPVAR, mapVar, 1);

    // Start dumping
    await device.operation(OPER.SET_OPERATION, STATUS.STARTDUMP);

    // Read data in 128-byte chunks
    for (let i = 0; i < numChunks; i++) {
      opts.signal?.throwIfAborted();

      // Poll until the current buffer reports DUMPED. Each poll is a USB
      // round-trip (so the loop yields), but a stalled transfer or device
      // fault could otherwise never report DUMPED and hang the dump forever —
      // bound the wait and surface it as an error instead.
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let status = await device.buffer(BUFFER.GET_CUR_BUFF_STATUS);
      while (status !== STATUS.DUMPED) {
        // Keep aborts responsive even while waiting out a stalled buffer —
        // otherwise an abort during a stall only lands at the poll timeout.
        opts.signal?.throwIfAborted();
        if (Date.now() > deadline) {
          throw new Error(
            `INL dump stalled: buffer ${i + 1}/${numChunks} never reported DUMPED ` +
              `within ${POLL_TIMEOUT_MS}ms (last status 0x${status.toString(16)})`,
          );
        }
        status = await device.buffer(BUFFER.GET_CUR_BUFF_STATUS);
      }

      // Read the payload
      const chunk = await device.payloadIn(BUFF_SIZE);
      result.set(chunk, bytesRead);
      bytesRead += chunk.length;

      opts.onProgress?.(bytesRead, totalBytes);
    }
  } finally {
    // Always return the operation engine to idle, including on a poll
    // timeout, device error, payload fault, or abort that surfaces as a
    // throw. Skipping this is what leaves the firmware mid-region and
    // byte-shifts the *next* dump. Best-effort: if the reset itself throws
    // (e.g. the device was unplugged), swallow it so the original error wins.
    try {
      await resetDumpEngine(device);
    } catch {
      /* best-effort cleanup */
    }
  }

  return result;
}
