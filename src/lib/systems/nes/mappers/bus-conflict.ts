/**
 * Bank-select helpers for discrete NES mappers (GxROM, Color Dreams, …)
 * whose register lives in PRG-ROM space and so suffers a bus conflict.
 *
 * On a write to $8000-$FFFF the data bus is driven by both the CPU and
 * the ROM at once, so the value the mapper latches is
 * `cpu_value & rom_value`, where `rom_value` is the byte at the write
 * address in the *currently mapped* bank.
 *
 * To latch a target value V we therefore write V through a byte N for
 * which `V & N === V` — i.e. N has every bit of V set (N is a superset
 * of V; equivalently `V | N === N`). The AND then leaves exactly V. An
 * 0xFF byte is the universal case (it passes any V); bytes with fewer
 * bits pass only the values they cover.
 */

import type { NesBus } from "../bus";

/**
 * Offset within `bank` of a byte through which writing `value` survives
 * the bus conflict unchanged (`(value & bank[offset]) === value`), or -1
 * if there is none. Scanning is cheap — `bank` is already in memory from
 * the read — so this runs per select.
 */
export function findWriteGate(bank: Uint8Array, value: number): number {
  for (let i = 0; i < bank.length; i++) {
    if ((value & bank[i]) === value) return i;
  }
  return -1;
}

/**
 * Latch bank-select `value`, departing from a known bank every time.
 *
 * First re-home to PRG bank 0 — writing 0x00 is conflict-immune
 * (`0 & anything === 0`), so it lands on bank 0 no matter which bank is
 * mapped or what byte sits at the write address. Then write `value`
 * through a byte in bank 0 (`bank0`, read once up front) that passes it
 * under the AND.
 *
 * Departing from bank 0 is the reliability property: a dropped latch
 * leaves the cart on bank 0 — a known state the caller detects by
 * comparing the read-back against bank 0 (`readBankWithRetry`) — instead
 * of drifting to an unknown bank. It also makes a value-write safe to
 * repeat for timing, since each one departs from bank 0 again.
 */
export async function selectBank(
  bus: NesBus,
  value: number,
  bank0: Uint8Array,
): Promise<void> {
  await bus.writeCpu(0x8000, 0x00); // re-home to bank 0 (conflict-immune)
  const gate = findWriteGate(bank0, value);
  await bus.writeCpu(gate >= 0 ? 0x8000 + gate : 0x8000, value);
}
