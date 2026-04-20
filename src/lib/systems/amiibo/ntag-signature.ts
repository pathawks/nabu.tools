// ECDSA signature verification on NIST secp128r1 for NXP NTAG chips.
//
// Every genuine NTAG21x silicon die is programmed at the NXP factory with a
// 32-byte ECC signature over its UID (computed by NXP's private key). The
// corresponding public key is published in NXP Application Note AN11350
// and included below. Verifying the signature against that public key
// proves the chip was actually manufactured by NXP — which distinguishes
// real NTAG215 silicon from the clone chips used in counterfeit Amiibo.
//
// Only the chip's physical authenticity is checked here; the Amiibo data
// stored in the chip is NOT validated (that's Nintendo's separate HMAC).
// A clone tag holding a legitimately-signed Amiibo blob will still work in
// games but will fail this check.

// secp128r1 curve parameters (SEC 2 / NIST P-128)
const P = 0xFFFFFFFDFFFFFFFFFFFFFFFFFFFFFFFFn;
const A = 0xFFFFFFFDFFFFFFFFFFFFFFFFFFFFFFFCn;
const N = 0xFFFFFFFE0000000075A30D1B9038A115n;
const GX = 0x161FF7528B899B2D0C28607CA52C5B86n;
const GY = 0xCF5AC8395BAFEB13C02DA292DDED7A83n;

// NXP's published NTAG21x public key (AN11350, SEC1-uncompressed form).
const PUBKEY_X = 0x494E1A386D3D3CFE3DC10E5DE68A499Bn;
const PUBKEY_Y = 0x1C202DB5B132393E89ED19FE5BE8BC61n;

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

/**
 * Verify a 32-byte NXP ECDSA signature against the 7-byte UID it was
 * computed over. Returns true iff the chip was produced by NXP (i.e.
 * not a clone).
 *
 * The "message" for NXP's NTAG signatures is the raw UID interpreted as a
 * big-endian integer (no hashing, no padding). Confirmed against real
 * NTAG215 test vectors.
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

  const sInv = modInv(s, N);
  const u1 = mod(e * sInv, N);
  const u2 = mod(r * sInv, N);

  const point = pointAdd(
    scalarMul(u1, { x: GX, y: GY }),
    scalarMul(u2, { x: PUBKEY_X, y: PUBKEY_Y }),
  );
  return point !== null && mod(point.x, N) === r;
}
