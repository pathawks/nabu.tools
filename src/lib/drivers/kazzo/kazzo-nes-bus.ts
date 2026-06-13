/**
 * `NesBus` adapter for the Kazzo dumper. Maps the generic CPU/PPU bus
 * primitives the shared NES mapper catalog consumes onto the Kazzo
 * firmware's per-byte read/write requests.
 *
 * Kazzo synthesizes real NES bus cycles per byte, so the adapter is thin:
 * `readCpu`/`readPpu` are direct chunked reads (no double-buffered dump
 * engine like INL needs), and `writeCpu` is a single 6502-style write.
 *
 * It deliberately omits the optional capabilities:
 *  - `writeSerialRegister`: MMC1's five-write serial load is driven as five
 *    plain `writeCpu`s — the kazzo-native approach (anago does the same), so
 *    no atomic-shift helper is needed.
 *  - `readChrBankLatched`: bus-conflict CHR mappers fall back to
 *    `writeCpu` + `readPpu`, which Kazzo expresses directly.
 *  - `readCpuBankLatched`: the fused latch+read primitive (mapper 470) the
 *    firmware doesn't have; 470 is pre-flight-rejected anyway.
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
