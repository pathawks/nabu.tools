// Identify a dumped Skylanders figure from the plaintext tag blocks.
//
// Only block 0 (manufacturer / NUID) and block 1 (figure identity) are
// readable as plaintext. The remaining blocks are AES-128-ECB encrypted with
// a per-tag key the portal never exposes, so the saved .bin keeps them in
// their encrypted on-tag form — a faithful raw dump, not a decrypted one.

import {
  BLOCK_SIZE,
  BLOCK1_FIGURE_ID_OFFSET,
  BLOCK1_VARIANT_ID_OFFSET,
  FIGURE_SIZE,
} from "./portal-commands";

export interface FigureIdentity {
  /** 4-byte NUID — block 0 bytes 0..3. Unique per physical tag. */
  nuid: Uint8Array;
  /** Uppercase hex of `nuid`, e.g. "0A1B2C3D". */
  nuidHex: string;
  /** u16 LE from block 1 — identifies the character model. */
  figureId: number;
  /** u16 LE from block 1 — distinguishes repose / wave / Legendary / etc. */
  variantId: number;
}

const BLOCK1_OFFSET = BLOCK_SIZE; // block 1 starts at byte 16

/** Parse the plaintext identity fields from a figure dump. */
export function parseFigureIdentity(data: Uint8Array): FigureIdentity {
  if (data.length < BLOCK1_OFFSET + BLOCK_SIZE) {
    throw new Error(
      `Figure data too short: ${data.length} bytes (need ${BLOCK1_OFFSET + BLOCK_SIZE})`,
    );
  }
  const nuid = data.slice(0, 4);
  const figureId =
    data[BLOCK1_OFFSET + BLOCK1_FIGURE_ID_OFFSET] |
    (data[BLOCK1_OFFSET + BLOCK1_FIGURE_ID_OFFSET + 1] << 8);
  const variantId =
    data[BLOCK1_OFFSET + BLOCK1_VARIANT_ID_OFFSET] |
    (data[BLOCK1_OFFSET + BLOCK1_VARIANT_ID_OFFSET + 1] << 8);
  return { nuid, nuidHex: toHex(nuid), figureId, variantId };
}

/** True when `data` is a full MIFARE 1K dump (all 64 blocks present). */
export function isFullDump(data: Uint8Array): boolean {
  return data.length === FIGURE_SIZE;
}

/** Filename convention for downloaded figure dumps. */
export function figureFilename(identity: FigureIdentity): string {
  const date = new Date().toISOString().slice(0, 10);
  return `Skylanders - ${identity.nuidHex} - ${date}.bin`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
