// Build a Dolphin-compatible 320-byte Disney Infinity figure file (.bin) from
// the data the portal exposes. The (block, u) addressing scheme reverse-
// engineered against v9.09 firmware maps to tag blocks as:
//
//   (block, u) = (sector, offset_within_sector)
//
// We read the manufacturer block, the encrypted identity block, the three
// save data blocks, and the five sector trailers. Remaining tag blocks
// (inner data blocks of each sector that Disney doesn't use) are left zero.
// The sector trailers come back with Key A/Key B zeroed — the portal won't
// reveal the MIFARE keys. Tools that need them (e.g. Dolphin) can derive
// Key A from the UID via the public nfc.toys algorithm.

export const INF_FIGURE_SIZE = 0x140; // 20 MIFARE blocks × 16 bytes

export interface FigureBlocks {
  /** 7 bytes — NFC UID from GET_FIGURE_UID (0xB4). */
  uid: Uint8Array;
  /** 16 bytes — manufacturer block (tag block 0), (U=0, block=0). Starts with UID + SAK/ATQA. */
  manufacturer: Uint8Array;
  /** 16 bytes — encrypted identity block (tag block 1), (U=1, block=0). AES-128-ECB ciphertext of character ID + date + CRC. */
  identity: Uint8Array;
  /** 16 bytes — encrypted save block 1 (tag block 4), (U=0, block=1). */
  save1: Uint8Array;
  /** 16 bytes — encrypted save block 2 (tag block 8), (U=0, block=2). */
  save2: Uint8Array;
  /** 16 bytes — encrypted save block 3 (tag block 12), (U=0, block=3). */
  save3: Uint8Array;
  /** 16 bytes — sector 0 trailer (tag block 3), (U=3, block=0). Keys zeroed. */
  trailer0: Uint8Array;
  /** 16 bytes — sector 1 trailer (tag block 7). */
  trailer1: Uint8Array;
  /** 16 bytes — sector 2 trailer (tag block 11). */
  trailer2: Uint8Array;
  /** 16 bytes — sector 3 trailer (tag block 15). */
  trailer3: Uint8Array;
  /** 16 bytes — sector 4 trailer (tag block 19). */
  trailer4: Uint8Array;
}

/** Maps each field of FigureBlocks to its absolute byte offset in the 320-byte file. */
const OFFSETS = {
  manufacturer: 0 * 16,
  identity: 1 * 16,
  trailer0: 3 * 16,
  save1: 4 * 16,
  trailer1: 7 * 16,
  save2: 8 * 16,
  trailer2: 11 * 16,
  save3: 12 * 16,
  trailer3: 15 * 16,
  trailer4: 19 * 16,
} as const;

export function buildFigureFile(blocks: FigureBlocks): Uint8Array {
  const buf = new Uint8Array(INF_FIGURE_SIZE);
  for (const [key, offset] of Object.entries(OFFSETS)) {
    const data = blocks[key as keyof typeof OFFSETS];
    buf.set(data.slice(0, 16), offset);
  }
  return buf;
}

export function uidFilename(uid: Uint8Array): string {
  const hex = Array.from(uid.slice(0, 7), (b) =>
    b.toString(16).padStart(2, "0").toUpperCase(),
  ).join("");
  const date = new Date().toISOString().slice(0, 10);
  return `Disney Infinity - ${hex} - ${date}.bin`;
}
