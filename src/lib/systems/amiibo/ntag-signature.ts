// ECDSA signature verification on NIST secp128r1 for NXP NFC chips.
//
// Every genuine NXP NFC die is programmed at the factory with a 32-byte ECC
// signature over its UID (computed by NXP's private key). The corresponding
// public keys are published by NXP and included below. Verifying a card's
// signature against the right public key proves the chip was actually
// manufactured by NXP — which distinguishes real silicon from the clone
// chips used in counterfeit Amiibo, Yoto cards, and similar products.
//
// Different NXP chip families use different key pairs (still on the same
// secp128r1 curve). We try each known key and accept if any verifies:
//   - NTAG21x key — Amiibo, PowerSaves blank tags, most NDEF stickers
//     (NXP Application Note AN11350)
//   - MIFARE Ultralight EV1 key — Yoto cards, MYO replacement blanks, many
//     transit cards (NXP AN11340 and the published MF0ULx21 datasheet)
//
// Only the chip's physical authenticity is checked here; the content stored
// on the chip is NOT validated (Amiibo content uses Nintendo's separate HMAC;
// Yoto content is gated by a per-card token in the NDEF URL). A clone tag
// holding a legitimately-signed Amiibo blob will still work in games but
// will fail this check.

// secp128r1 curve parameters (SEC 2 / NIST P-128)
const P = 0xFFFFFFFDFFFFFFFFFFFFFFFFFFFFFFFFn;
const A = 0xFFFFFFFDFFFFFFFFFFFFFFFFFFFFFFFCn;
const N = 0xFFFFFFFE0000000075A30D1B9038A115n;
const GX = 0x161FF7528B899B2D0C28607CA52C5B86n;
const GY = 0xCF5AC8395BAFEB13C02DA292DDED7A83n;

// NXP public keys (SEC1-uncompressed form, split into X and Y coordinates).
const NXP_PUBKEYS: { x: bigint; y: bigint }[] = [
  // NTAG21x: AN11350
  {
    x: 0x494E1A386D3D3CFE3DC10E5DE68A499Bn,
    y: 0x1C202DB5B132393E89ED19FE5BE8BC61n,
  },
  // MIFARE Ultralight EV1: widely reproduced from NXP's UL EV1 key docs
  {
    x: 0x90933BDCD6E99B4E255E3DA55389A827n,
    y: 0x564E11718E017292FAF23226A96614B8n,
  },
];

type Point = { x: bigint; y: bigint } | null; // null = point at infinity

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modInv(a: bigint, m: bigint): bigint {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}

function pointAdd(p1: Point, p2: Point): Point {
  if (p1 === null) return p2;
  if (p2 === null) return p1;
  if (p1.x === p2.x) {
    if (p1.y === p2.y) {
      // Doubling
      const lambda = mod((3n * p1.x * p1.x + A) * modInv(2n * p1.y, P), P);
      const x = mod(lambda * lambda - 2n * p1.x, P);
      return { x, y: mod(lambda * (p1.x - x) - p1.y, P) };
    }
    return null; // p + (-p) = infinity
  }
  const lambda = mod((p2.y - p1.y) * modInv(p2.x - p1.x, P), P);
  const x = mod(lambda * lambda - p1.x - p2.x, P);
  return { x, y: mod(lambda * (p1.x - x) - p1.y, P) };
}

function scalarMul(k: bigint, point: Point): Point {
  let result: Point = null;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

function verifyWithKey(
  e: bigint,
  r: bigint,
  s: bigint,
  pub: { x: bigint; y: bigint },
): boolean {
  const sInv = modInv(s, N);
  const u1 = mod(e * sInv, N);
  const u2 = mod(r * sInv, N);
  const point = pointAdd(scalarMul(u1, { x: GX, y: GY }), scalarMul(u2, pub));
  return point !== null && mod(point.x, N) === r;
}

/**
 * Verify a 32-byte NXP ECDSA signature against the 7-byte UID it was
 * computed over. Returns true iff the chip was produced by NXP — i.e. it
 * matches one of the published NXP public keys (NTAG21x or UL EV1).
 *
 * The "message" for NXP's signatures is the raw UID interpreted as a
 * big-endian integer (no hashing, no padding). Confirmed against factory
 * NTAG215 Amiibo and genuine Yoto (UL EV1) test vectors.
 */
export function verifyNtagSignature(
  uid: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (uid.length !== 7 || signature.length !== 32) return false;

  const r = bytesToBigInt(signature.slice(0, 16));
  const s = bytesToBigInt(signature.slice(16, 32));
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;

  const e = bytesToBigInt(uid);
  return NXP_PUBKEYS.some((pub) => verifyWithKey(e, r, s, pub));
}
