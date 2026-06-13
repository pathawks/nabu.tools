/**
 * `NesBus` adapter for the Kazzo dumper. Maps the generic CPU/PPU bus
 * primitives the shared NES mapper catalog consumes onto the Kazzo
 * firmware's per-byte read/write requests.
 *
 * Kazzo synthesizes real NES bus cycles per byte, so the adapter is thin:
 * `readCpu`/`readPpu` are direct chunked reads (no double-buffered dump
 * engine like INL needs), and `writeCpu` is a single 6502-style write.
 *
 * It implements one optional capability and omits two:
 *  - `writeSerialRegister` (implemented): MMC1's five-write serial load is
 *    sent as a single CPU_WRITE_6502 carrying all five shifted bytes — the
 *    firmware writes each to the register address in turn (one 6502 cycle
 *    each). This matches the reference anago `mmc1_write` (one transfer, not
 *    five) and removes four USB round-trips from a stateful, all-or-nothing
 *    load — the failure mode that's most exposed to a per-transaction hiccup.
 *  - `readChrBankLatched`: bus-conflict CHR mappers fall back to
 *    `writeCpu` + `readPpu`, which Kazzo expresses directly.
 *  - `readCpuBankLatched`: the fused latch+read primitive (mapper 470) the
 *    firmware doesn't have; the 470 walk falls back to re-latching with
 *    `writeCpu` before each sub-read.
 */

import type { NesBus, BusProgressCb } from "@/lib/systems/nes/bus";
import type { KazzoDevice } from "./kazzo-device";

export class KazzoNesBus implements NesBus {
  private readonly device: KazzoDevice;
  // Forwarded into the read loop so an abort interrupts per 256-byte page
  // rather than only at region boundaries.
  private readonly signal?: AbortSignal;

  constructor(device: KazzoDevice, signal?: AbortSignal) {
    this.device = device;
    this.signal = signal;
  }

  async setup(): Promise<void> {
    // PHI2 (CPU clock) must be running before the firmware can synthesize
    // bus cycles. Mappers call setup() at the start of every dump.
    await this.device.phi2Init();
  }

  async writeCpu(addr: number, value: number): Promise<void> {
    this.signal?.throwIfAborted();
    await this.device.cpuWrite(addr, value);
  }

  /**
   * MMC1's five-write serial load, atomically: clock the low 5 bits of
   * `value` (LSB first) into the shift register at `addr` as one
   * CPU_WRITE_6502 transfer. Each byte's bit 0 is what MMC1 latches; the
   * mapper issues the bit-7 reset via `writeCpu` first, so this is only the
   * data load. Equivalent to five per-bit `writeCpu`s but in a single
   * transaction (matches the reference anago `mmc1_write`).
   */
  async writeSerialRegister(addr: number, value: number): Promise<void> {
    this.signal?.throwIfAborted();
    const bits = Uint8Array.from({ length: 5 }, (_, i) => (value >> i) & 0x01);
    await this.device.cpuWriteBytes(addr, bits);
  }

  async readCpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    return this.device.cpuRead(addr, length, onProgress, this.signal);
  }

  async readPpu(
    addr: number,
    length: number,
    onProgress?: BusProgressCb,
  ): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    return this.device.ppuRead(addr, length, onProgress, this.signal);
  }
}
