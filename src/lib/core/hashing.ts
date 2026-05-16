const CRC32_TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++)
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function digestHex(algo: string, data: Uint8Array): Promise<string> {
  // Cast needed: TS6 Uint8Array is generic over ArrayBufferLike, but
  // crypto.subtle.digest expects BufferSource (ArrayBuffer-backed only).
  const buf = await crypto.subtle.digest(algo, data as unknown as BufferSource);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const sha1Hex = (data: Uint8Array) => digestHex("SHA-1", data);
export const sha256Hex = (data: Uint8Array) => digestHex("SHA-256", data);

/**
 * Advance a CRC32 state through `n` zero bytes.
 * Used for the CRC32 combine identity.
 */
function crc32ProcessZeros(state: number, n: number): number {
  for (let i = 0; i < n; i++) state = CRC32_TABLE[state & 0xff] ^ (state >>> 8);
  return state;
}

/**
 * Derive the CRC32 of content bytes given the full-file CRC32 and header bytes.
 *
 * Uses: crc(A||B) = processZeros(crc_A, len_B) ^ crc_B
 * So:   crc_B = crc(A||B) ^ processZeros(crc_A, len_B)
 *
 * This lets us strip an iNES header from a No-Intro headered CRC
 * without having the actual ROM data — just the header bytes.
 */
export function deriveContentCrc(
  fullCrc: number,
  header: Uint8Array,
  contentLen: number,
): number {
  const headerCrc = crc32(header);
  return (fullCrc ^ crc32ProcessZeros(headerCrc, contentLen)) >>> 0;
}

export function hexStr(n: number, pad = 8): string {
  return n.toString(16).toUpperCase().padStart(pad, "0");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
