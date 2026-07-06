/**
 * ULIDs: spec-conformant sortable ids, a matcher, and binary/time codecs.
 *
 * Layout: 10 chars of 48-bit ms timestamp (Crockford base32, big-endian)
 * followed by `length - 10` random chars (default total `length` 26 → 16
 * random chars → 80 bits).
 *
 * The default 26-char form is a spec-conformant ULID: the 10-char prefix is
 * base32 of the 48-bit ms timestamp, and the 16-char tail is 80 uniform random
 * bits — we draw one bias-free base32 symbol per byte (256 = 32 × 8), which is
 * distributionally identical to encoding an 80-bit random integer, so a
 * standard ULID decoder reads our strings correctly. The result is lexically
 * sortable by creation time, URL-safe, Crockford base32, and unique with
 * overwhelming probability. The first char is always 0-7 (the high 2 bits of a
 * 48-bit ms timestamp are zero until ~year 10889), which `ULID_RE` enforces.
 *
 * Convert to/from the canonical 16-byte binary form with `ulidToBytes` /
 * `bytesToUlid` (e.g. a SQLite BLOB(16)); read the embedded timestamp with
 * `ulidTime`.
 *
 * Consumers that want shorter ids for usability pass a smaller total `length`
 * (e.g. `ulid(20)` mints 20-char ids). Only the default 26-char form is a
 * standard ULID — the binary codec is 26-char only; shorter ids are a pues
 * convenience.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const MIN_LEN = 13;
const MAX_LEN = 26;

/** Mint a new ULID-compatible id. `length` is the total character count — a
 *  fixed 10-char timestamp plus `length - 10` random chars — and must be an
 *  integer in [13, 26] (defaults to 26, a standard ULID). 26 is the standard
 *  width; 13 is the floor (10-char timestamp + 3 random chars). Fewer random
 *  chars means higher within-millisecond collision risk — prefer the default
 *  unless short ids matter. Matches `ulidPattern(length)`. */
export function ulid(length = MAX_LEN): string {
  if (!Number.isInteger(length) || length < MIN_LEN || length > MAX_LEN) {
    throw new RangeError(
      `ulid: length must be an integer in [${MIN_LEN}, ${MAX_LEN}], got ${length}`,
    );
  }
  return encodeTime(Date.now()) + encodeRandom(length - TIME_LEN);
}

function encodeTime(ms: number): string {
  let t = ms;
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(n: number): string {
  // 256 = 32 * 8 exactly, so `byte % 32` is bias-free.
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < n; i++) out += CROCKFORD[bytes[i]! % 32];
  return out;
}

/** Matches a standard 26-char id. First char is 0-7 (timestamp high bits). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

/** Build a matcher for a non-standard total `length` (e.g. 20). */
export function ulidPattern(length = 26): RegExp {
  return new RegExp(`^[0-7][0-9A-HJKMNP-TV-Z]{${length - 1}}$`, "i");
}

/** True if `value` is a standard 26-char ULID-compatible id. */
export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/**
 * Decode a 26-char ULID to its canonical 16-byte (128-bit, big-endian) binary
 * form — e.g. for a SQLite BLOB(16). Byte order preserves sort order: memcmp
 * of the bytes == lexicographic order of the strings == chronological order.
 * The bytes match any spec ULID decoder. Throws unless `id` is a 26-char ULID.
 */
export function ulidToBytes(id: string): Uint8Array {
  if (!ULID_RE.test(id)) {
    throw new TypeError(`ulidToBytes: not a 26-char ULID: ${id}`);
  }
  let v = 0n;
  for (const c of id.toUpperCase()) v = v * 32n + BigInt(CROCKFORD.indexOf(c));
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Encode a 16-byte (128-bit, big-endian) value back to its 26-char ULID
 *  string — the inverse of {@link ulidToBytes}. Throws unless `bytes` is
 *  exactly 16 long. */
export function bytesToUlid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new TypeError(`bytesToUlid: expected 16 bytes, got ${bytes.length}`);
  }
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(v % 32n)] + out;
    v >>= 5n;
  }
  return out;
}

/** Extract the millisecond Unix timestamp encoded in a ULID's 10-char prefix.
 *  Works for any pues id with a valid timestamp prefix (incl. short ids). The
 *  value is 48-bit, so it's a safe JS number. Throws on a bad prefix. */
export function ulidTime(id: string): number {
  const s = id.toUpperCase();
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{9}/.test(s)) {
    throw new TypeError(`ulidTime: not a valid ULID-compatible id: ${id}`);
  }
  let ms = 0;
  for (const c of s.slice(0, TIME_LEN)) ms = ms * 32 + CROCKFORD.indexOf(c);
  return ms;
}
