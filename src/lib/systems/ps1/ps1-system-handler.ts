import type {
  SystemHandler,
  ConfigValues,
  CartridgeInfo,
  ResolvedConfigField,
  ValidationResult,
  ReadConfig,
  OutputFile,
  VerificationHashes,
  VerificationDB,
  VerificationResult,
  DumpSummary,
  DumpSummaryCell,
} from "@/lib/types";
import { crc32, sha1Hex, sha256Hex } from "@/lib/core/hashing";

// Spec constants — duplicated from `ps3-mca-commands.ts` to keep the system
// handler decoupled from a specific driver module.
const PS1_CARD_SIZE = 131072;
const PS1_BLOCK_SIZE = 8192;
const PS1_FRAME_SIZE = 128;
// Block 0 holds the BIOS-managed metadata (header + 15 directory entries +
// broken-sector list + test-write frame) — every frame here has its XOR
// checksum enforced. Save data blocks (1-15) are written by games directly
// and do not maintain a per-frame XOR, so we don't check them.
const PS1_BLOCK0_FRAMES = 64;
const ICON_SCALE = 3;

// Directory-entry block-allocation states (psx-spx).
//   0x51 = used, head of a save
//   0x52 / 0x53 = used, middle / last continuation block
//   0xA0 = free / formatted
//   0xA1 = deleted, head of a save (filename + chain preserved for undelete)
//   0xA2 / 0xA3 = deleted continuation
// We surface only head entries (0x51 / 0xA1) — continuations have zero-filled
// filenames and contain no SC-magic title frame of their own.
const STATUS_HEAD_USED = 0x51;
const STATUS_HEAD_DELETED = 0xa1;

export class Ps1SystemHandler implements SystemHandler {
  readonly systemId = "ps1";
  readonly displayName = "PS1 Memory Card";
  readonly fileExtension = ".mcr";

  getConfigFields(
    _currentValues: ConfigValues,
    _autoDetected?: CartridgeInfo,
  ): ResolvedConfigField[] {
    return [];
  }

  estimateDumpSize(_values: ConfigValues): number {
    return PS1_CARD_SIZE;
  }

  validate(_values: ConfigValues): ValidationResult {
    return { valid: true };
  }

  buildReadConfig(_values: ConfigValues): ReadConfig {
    return { systemId: "ps1", params: {} };
  }

  buildOutputFile(rawData: Uint8Array, _config: ReadConfig): OutputFile {
    const now = new Date();
    const stamp =
      now.getFullYear().toString() +
      (now.getMonth() + 1).toString().padStart(2, "0") +
      now.getDate().toString().padStart(2, "0");
    return {
      data: rawData,
      filename: `ps1_memcard_${stamp}.mcr`,
      mimeType: "application/octet-stream",
      meta: { Format: "Raw PS1 memory card", Size: `${rawData.length} bytes` },
      // .mcr (ePSXe / PCSX-Reloaded / DuckStation) and .mcd (PCSX) are
      // byte-identical raw 128 KiB images; offer both in the save dialog.
      acceptExtensions: [".mcr", ".mcd"],
      actionLabel: "Save Memory Card",
    };
  }

  async computeHashes(rawData: Uint8Array): Promise<VerificationHashes> {
    const [sha1, sha256] = await Promise.all([
      sha1Hex(rawData),
      sha256Hex(rawData),
    ]);
    return { crc32: crc32(rawData), sha1, sha256, size: rawData.length };
  }

  verify(
    _hashes: VerificationHashes,
    _db: VerificationDB | null,
  ): VerificationResult {
    // No verification DB for user-written memory-card contents.
    return { matched: false, confidence: "none" };
  }

  summarizeDump(rawData: Uint8Array): DumpSummary | null {
    if (rawData.length !== PS1_CARD_SIZE) return null;
    if (rawData[0] !== 0x4d || rawData[1] !== 0x43) return null; // "MC"

    const ascii = new TextDecoder("ascii");
    const sjis = new TextDecoder("shift-jis", { fatal: false });

    const rows: DumpSummaryCell[][] = [];
    let used = 0;
    let deleted = 0;
    let blocksUsed = 0;

    // TODO: each used slot could expose a per-save export action that
    // writes just that save in single-save formats (.mcs / .psx / .psv)
    // for transferring an individual save to another card. Would need a
    // richer DumpSummary shape (per-row actions) and a header/wrapper
    // builder for each format.
    for (let slot = 1; slot <= 15; slot++) {
      const entryOffset = slot * PS1_FRAME_SIZE;
      const status = rawData[entryOffset];

      if (status !== STATUS_HEAD_USED && status !== STATUS_HEAD_DELETED)
        continue;

      const isDeleted = status === STATUS_HEAD_DELETED;
      const filename = ascii
        .decode(rawData.subarray(entryOffset + 10, entryOffset + 30))
        .replace(/\0+$/, "");

      // Count blocks by walking the next-block-pointer chain at offset
      // 0x08-0x09 (little-endian). 0xFFFF terminates the chain; otherwise
      // the value is `block_index - 1`. Cap at 15 hops as a corruption
      // guard against a self-referencing or out-of-range pointer.
      let blocks = 1;
      let cur = slot;
      for (let hop = 0; hop < 15; hop++) {
        const ptrOffset = cur * PS1_FRAME_SIZE + 8;
        const ptr = rawData[ptrOffset] | (rawData[ptrOffset + 1] << 8);
        if (ptr === 0xffff) break;
        const next = ptr + 1;
        if (next < 1 || next > 15) break;
        cur = next;
        blocks++;
      }

      let title = "";
      let icon: DumpSummaryCell = "";
      const blockOffset = slot * PS1_BLOCK_SIZE;
      const hasTitleFrame =
        rawData[blockOffset] === 0x53 && rawData[blockOffset + 1] === 0x43;
      if (hasTitleFrame) {
        // PS1 games typically write Latin titles as fullwidth ASCII
        // (U+FF01–U+FF5E) and pad with U+3000 (IDEOGRAPHIC SPACE) plus,
        // in some games, embedded NULs. Normalize fullwidth → halfwidth
        // for readability, truncate at the first NUL, and trim trailing
        // whitespace.
        title = normalizeFullwidth(
          sjis.decode(rawData.subarray(blockOffset + 4, blockOffset + 68)),
        )
          .split("\0", 1)[0]
          .trimEnd();

        icon = decodeIcon(rawData, blockOffset, title);
      }

      if (isDeleted) deleted++;
      else used++;
      blocksUsed += blocks;

      // A directory entry marked used/deleted but missing the "SC" magic at
      // the start of its data block has lost its title frame — common when
      // the save block has been overwritten or partially corrupted.
      const statusLabel = !hasTitleFrame
        ? "Corrupt"
        : isDeleted
          ? "Deleted"
          : "Used";

      const productCode = extractProductCode(filename);
      rows.push([
        icon,
        String(slot),
        statusLabel,
        productCode,
        String(blocks),
        title,
      ]);
    }

    const integrity = checkFrameXor(rawData);
    const baseFooter = `${used} used · ${deleted} deleted (${blocksUsed} / 15 blocks)`;
    const footer = integrity.ok
      ? baseFooter
      : `${baseFooter} · ${integrity.message}`;

    return {
      title: "Memory card contents",
      columns: ["Icon", "Slot", "Status", "Code", "Blocks", "Title"],
      monoColumns: [1, 3, 4],
      mutedColumns: [1],
      rows,
      footer,
      integrity,
    };
  }
}

/**
 * XOR-check every frame in block 0. Each frame's last byte is the XOR of
 * bytes 0..126; the BIOS enforces this for the header, directory entries,
 * broken-sector list, and test-write frame. (Save data blocks are written
 * by games directly and don't maintain a per-frame XOR.)
 */
function checkFrameXor(rawData: Uint8Array): {
  ok: boolean;
  message?: string;
} {
  let corrupt = 0;
  for (let f = 0; f < PS1_BLOCK0_FRAMES; f++) {
    const start = f * PS1_FRAME_SIZE;
    let xor = 0;
    for (let i = 0; i < PS1_FRAME_SIZE - 1; i++) xor ^= rawData[start + i];
    if (xor !== rawData[start + PS1_FRAME_SIZE - 1]) corrupt++;
  }
  if (corrupt === 0) return { ok: true };
  const noun = corrupt === 1 ? "frame" : "frames";
  return {
    ok: false,
    message: `${corrupt} corrupt directory ${noun}`,
  };
}

/**
 * Decode a save's icon frames to RGBA. Title-frame layout (psx-spx):
 * palette at +0x60 (16 × 16-bit colour: bits 0-4 R, 5-9 G, 10-14 B, bit 15
 * = mask), icon frames at +0x80 / +0x100 / +0x180 (16×16, 4-bpp, low nibble
 * first). The display flag at +0x02 selects 1-3 frames (0x11/0x12/0x13);
 * animation rates are 16 / 11 PAL frames per icon frame for 2 / 3 frame
 * icons respectively.
 */
function decodeIcon(
  rawData: Uint8Array,
  blockOffset: number,
  alt: string,
): Extract<DumpSummaryCell, { kind: "icon" }> {
  const paletteOffset = blockOffset + 0x60;

  const palette = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const lo = rawData[paletteOffset + i * 2];
    const hi = rawData[paletteOffset + i * 2 + 1];
    const word = lo | (hi << 8);
    const r5 = word & 0x1f;
    const g5 = (word >> 5) & 0x1f;
    const b5 = (word >> 10) & 0x1f;
    palette[i] =
      ((r5 << 3) | (r5 >> 2)) |
      (((g5 << 3) | (g5 >> 2)) << 8) |
      (((b5 << 3) | (b5 >> 2)) << 16) |
      (0xff << 24);
  }

  // Byte 0x02 is the format's sole animation flag (0x11/0x12/0x13 = 1/2/3
  // frames); MemcardRex and the PS1 BIOS bootmenu both animate strictly
  // based on this. There's no "valid frames" byte to sanity-check against.
  const flag = rawData[blockOffset + 2];
  const claimedFrames = flag >= 0x11 && flag <= 0x13 ? flag - 0x10 : 1;

  // UX hedge over the literal BIOS behaviour: a handful of titles set the
  // flag to 0x13 but only fill the first icon slot — the other 256 bytes
  // hold save-data leakage. The real BIOS would flicker through that
  // garbage; we skip any subsequent frame whose non-zero nibble count is
  // far below frame 0's.
  const nibbleCount = (off: number) => {
    let n = 0;
    for (let i = 0; i < 128; i++) {
      const b = rawData[off + i];
      if (b & 0x0f) n++;
      if (b & 0xf0) n++;
    }
    return n;
  };
  const frame0Count = nibbleCount(blockOffset + 0x80);
  const threshold = frame0Count / 4;
  let frameCount = 1;
  for (let f = 1; f < claimedFrames; f++) {
    if (nibbleCount(blockOffset + 0x80 + f * 128) < threshold) break;
    frameCount = f + 1;
  }

  const frames: Uint8ClampedArray<ArrayBuffer>[] = [];
  for (let f = 0; f < frameCount; f++) {
    const iconOffset = blockOffset + 0x80 + f * 128;
    const rgba = new Uint8ClampedArray(new ArrayBuffer(16 * 16 * 4));
    const view = new DataView(rgba.buffer);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const byte = rawData[iconOffset + y * 8 + (x >> 1)];
        const idx = (x & 1) === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
        view.setUint32((y * 16 + x) * 4, palette[idx], true);
      }
    }
    frames.push(rgba);
  }

  // Per psx-spx: 2-frame icons cycle every 16 PAL frames, 3-frame every 11.
  // PAL = 50Hz, so 16 frames = 320ms, 11 frames = 220ms.
  const frameDurationMs = frameCount === 3 ? 220 : 320;

  return {
    kind: "icon",
    frames,
    width: 16,
    height: 16,
    displayScale: ICON_SCALE,
    frameDurationMs,
    alt,
  };
}

function extractProductCode(filename: string): string {
  // Filenames are typically "B" + region letter + region prefix + dash +
  // 5-digit serial + optional trailer. A small number of titles use a
  // single letter or no separator instead of the dash. Strip the leading
  // "B" + region letter, capture the 4-letter region prefix and 5-digit
  // serial; allow any single non-digit separator between them (or none).
  const m = filename.match(/^B[A-Z]([A-Z]{4})[^0-9]?(\d{5})/);
  return m ? `${m[1]}-${m[2]}` : "";
}

function normalizeFullwidth(s: string): string {
  return s.replace(/[\uFF01-\uFF5E\u3000]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    return code === 0x3000 ? " " : String.fromCharCode(code - 0xfee0);
  });
}
