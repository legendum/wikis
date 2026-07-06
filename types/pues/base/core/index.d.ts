export type PuesProps = any;
export type PuesUser = any;
export const Pues: any;
export function usePuesFetch(): typeof fetch;
export function usePuesUser(): any;

export function defaultRoot(): string;
export function defaultCoreName(root?: string): string;
export function resolveCoreName(
  config: { core?: { name?: unknown } } | null | undefined,
  root?: string,
): string;

export function isByLegendum(): boolean;
export function isSelfHosted(): boolean;
export const LOCAL_USER_EMAIL: string;
export function setByLegendum(value: boolean | null): void;

export function puesAuthedFetch(baseFetch?: typeof fetch): typeof fetch;

export function useOnlineStatus(): boolean;
export function usePageTitle(title: string): void;

/** Mint a ULID-compatible sortable id. `length` is the total char count
 *  (10-char timestamp + the rest random); must be an integer in [13, 26],
 *  defaults to 26. Throws RangeError outside that range. */
export function ulid(length?: number): string;
/** Matches a standard 26-char id (first char 0-7). */
export const ULID_RE: RegExp;
/** Build a matcher for a non-standard total `length` (default 26). */
export function ulidPattern(length?: number): RegExp;
/** True if `value` is a standard 26-char ULID-compatible id. */
export function isUlid(value: string): boolean;
/** Decode a 26-char ULID to its canonical 16-byte big-endian form (e.g. a
 *  SQLite BLOB(16)). Sort-preserving. Throws unless `id` is a 26-char ULID. */
export function ulidToBytes(id: string): Uint8Array;
/** Encode a 16-byte value back to its 26-char ULID string. Throws unless
 *  `bytes` is exactly 16 long. */
export function bytesToUlid(bytes: Uint8Array): string;
/** Extract the millisecond timestamp from a ULID's 10-char prefix. */
export function ulidTime(id: string): number;

/** Consumer-app metadata derived from config/pues.yaml at vendor time.
 *  Empty in the pues source tree; populated when vendored into a consumer. */
export const puesAppMeta: {
  readonly name: string;
};
