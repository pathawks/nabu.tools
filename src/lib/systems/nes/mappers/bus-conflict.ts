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

/**
 * Read one CHR-ROM bank selected by latching `value`, using whichever CHR
 * path the bus offers. A device whose firmware fuses the bank-select write
 * and the read — and so exposes no standalone PPU read — implements the
 * optional `readChrBankLatched` capability; everything else selects the bank
 * with `selectBank` and reads the window via `readPpu`. This is the
 * read-side mirror of the optional-capability pattern MMC1 uses for writes
 * (`writeSerialRegister`), so the discrete CHR-ROM mappers stay
 * device-agnostic.
 */
export async function readLatchedChrBank(
  bus: NesBus,
  value: number,
  bank0: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (bus.readChrBankLatched) {
    return bus.readChrBankLatched(value, bank0, length);
  }
  if (!bus.readPpu) {
    throw new Error(
      "CHR-ROM dump needs either a PPU-bus read (`readPpu`) or the fused " +
        "`readChrBankLatched` capability; this driver exposes neither.",
    );
  }
  await selectBank(bus, value, bank0);
  return bus.readPpu(0x0000, length);
}
