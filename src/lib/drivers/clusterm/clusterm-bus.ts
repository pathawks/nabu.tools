/**
 * `NesBus` adapter for the Famicom Dumper/Writer.
 *
 * The device memory-maps both cart buses through its FSMC + CPLD, so the
 * generic primitives map 1:1 onto protocol operations at any address and
 * length — none of the alignment restrictions other dumpers impose.
 * Large reads are split into chunks here so progress callbacks tick and
 * an abort lands between chunks rather than at region boundaries.
 *
 * Deliberately omitted optional capabilities:
 * - `writeSerialRegister` — every `writeCpu` is a real M2-timed bus
 *   write executed in a tight firmware loop, the same way the reference
 *   client's MMC1 scripts drive the shift register; the mapper's
 *   per-bit fallback is the native path here.
 * - `readChrBankLatched` — only for devices without a generic PPU read;
 *   `readPpu` is the real thing on this hardware.
 */

import type { NesBus, BusProgressCb } from "@/lib/systems/nes/bus";
import type { ClusterMProtocol } from "./clusterm-protocol";

/**
 * Per-request read size. The firmware streams arbitrary lengths, so this
 * only sets progress/abort granularity: 8 KiB ≈ 10 ms per chunk at CDC
 * full speed while keeping request-turnaround overhead negligible.
 */
const READ_CHUNK = 8 * 1024;

// Mapper 413's serial flash CANNOT be dumped with this device's stock
// firmware — hardware-established 2026-06-13 with the cart on the bus:
//
// - Within one continuous read burst the rolling-window technique works
//   perfectly (strict one-SPI-clock-per-read, the whole $C000-$CFFF page
//   returns the shift register).
// - But the firmware's CDC send path flushes a 64-byte staging buffer,
//   PAUSING the FSMC read stream every 64 reads mid-request — and every
//   pause (USB gaps too) can inject spurious SPI clocks that shear the
//   bit phase. Corruption lands at exactly the 64-read boundaries.
// - Pause-free requests cap at 64 reads = 7 extracted bytes; with ~36
//   round trips of re-framing per request, the 8 MiB flash works out to
//   hours. Multi-byte $C000-page writes do NOT shift clean command bits
//   either (single writes to $C000 exactly are required for framing).
//
// The mapper's pre-flight probe rejects all of this before any long
// dump. A paced read needs firmware help (read a block gaplessly into
// RAM, then transmit) — the same conclusion as the INL's pending
// NESCPU_SPI413 memtype. Until a firmware path exists, this bus does
// not advertise `readSpiDataPort`, so mapper 413's misc dump throws its
// clear capability error (PRG/CHR dump fine).

export class ClusterMNesBus implements NesBus {
  private readonly protocol: ClusterMProtocol;
  private readonly signal?: AbortSignal;

  constructor(protocol: ClusterMProtocol, signal?: AbortSignal) {
    this.protocol = protocol;
    this.signal = signal;
  }

  /**
   * Simulate a console reset (bus floats ~500 ms, then M2 free-runs
   * again) so every dump region starts from power-on mapper state
   * instead of whatever a previous run left latched.
   */
  async setup(): Promise<void> {
    await this.protocol.reset();
  }

  async writeCpu(addr: number, value: number): Promise<void> {
    this.signal?.throwIfAborted();
    await this.protocol.writeCpu(addr, [value]);
  }

  async readCpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    return this.readChunked(
      (a, n) => this.protocol.readCpuBlock(a, n),
      addr,
      length,
      onProgress,
    );
  }

  async readPpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    return this.readChunked(
      (a, n) => this.protocol.readPpuBlock(a, n),
      addr,
      length,
      onProgress,
    );
  }

  /** Single-byte CPU read — mapper 413's SPI arming read needs one. */
  async readCpuByte(addr: number): Promise<number> {
    this.signal?.throwIfAborted();
    const data = await this.protocol.readCpuBlock(addr, 1);
    return data[0];
  }

  /**
   * Latch-write + read for mapper 470's per-chunk re-latch cadence.
   * Implemented as two sequential protocol operations — the firmware
   * accepts only one command in flight (see the pipelining note in
   * clusterm-protocol.ts) — and that is sufficient here: M2 free-runs
   * through the USB turnaround, so the inner latch holds across the gap
   * for the same reason it holds between CPU writes on a real console.
   * Supplying the capability buys the vendor's 2 KiB cadence rather
   * than atomicity.
   */
  async readCpuBankLatched(
    latchAddr: number,
    latchValue: number,
    addr: number,
    length: number,
  ): Promise<Uint8Array> {
    this.signal?.throwIfAborted();
    await this.protocol.writeCpu(latchAddr, [latchValue]);
    return this.protocol.readCpuBlock(addr, length);
  }

  private async readChunked(
    readBlock: (addr: number, length: number) => Promise<Uint8Array>,
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      this.signal?.throwIfAborted();
      const n = Math.min(READ_CHUNK, length - offset);
      result.set(await readBlock(addr + offset, n), offset);
      offset += n;
      onProgress?.(offset, length);
    }
    return result;
  }
}
