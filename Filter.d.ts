/**
 * @zakkster/lite-filter -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of Filter.js. The three-place
 * version sync (package.json / Filter.js VERSION / llms.txt) is enforced elsewhere.
 * ASCII-only.
 *
 * FAMILY CONTRACT. `LiteFilter<K>` is the uniform surface EVERY member of the family
 * implements. `Bloom` is the reference member; further members (Counting Bloom,
 * Cuckoo, XOR, Binary Fuse, ...) will each be a `class X<K> implements LiteFilter<K>`,
 * so a caller can swap `new Bloom(n, o)` for another member and stay type-checked --
 * the structure difference is INTERNAL, never in the surface.
 *
 * @license MIT
 */

/**
 * Opt-in runtime counters (decisions/0004), exposed by `stats()` on a filter
 * constructed with `{ stats: true }`. Four EXACT integers (plain JS numbers):
 *   - `adds`    -- every `add(key)` call.
 *   - `queries` -- every `mightContain(key)` / `has(key)` call.
 *   - `hits`    -- a query that returned `true` (a positive -- possibly a false one).
 *   - `misses`  -- a query that returned `false` (a definite non-member).
 */
export interface FilterStats {
  adds: number;
  queries: number;
  hits: number;
  misses: number;
}

/**
 * A plain, structurally-cloneable snapshot of a filter (decisions/0005), produced by
 * `dump()` and consumed by the static `restore()`. The bit store is a plain Array so
 * the snapshot round-trips through `structuredClone` AND JSON. The shared fail-closed
 * tag is always present:
 *   - `f`     -- the format tag, `"litefilter/1"`. `restore()` rejects any other value.
 *   - `mem`   -- the member name (`"Bloom"`). A mismatch fails closed.
 *   - `m`     -- the bit count. A mismatch vs the re-derived sizing fails closed.
 *   - `k`     -- the hash count. A mismatch fails closed.
 *   - `cap`   -- the capacity the filter was sized for.
 *   - `fpp`   -- the configured target false-positive probability.
 *   - `seed`  -- the hash seed. A mismatch fails closed.
 *   - `keys`  -- the backing: `"int"` or `null`.
 *   - `count` -- the number of adds recorded.
 *   - `bits`  -- the bit store as a plain array of 32-bit words.
 *
 * Treat it as opaque: do not hand-edit it. `restore()` validates every field and
 * throws a `[lite-filter]`-tagged Error on any corruption (null is not zero).
 */
export interface FilterSnapshot {
  f: "litefilter/1";
  mem: string;
  m: number;
  k: number;
  cap: number;
  fpp: number;
  seed: number;
  keys: "int" | null;
  count: number;
  bits: number[];
}

/** Construction options shared by every filter member. */
export interface FilterOptions {
  /** Target false-positive probability in the open interval (0, 1). Default 0.01. */
  fpp?: number;
  /** Hash seed (32-bit-coercible). Default is a fixed constant for determinism. */
  seed?: number;
  /** Opt into the strict-zero-alloc 32-bit-integer backing. */
  keys?: "int";
  /** Mint the per-instance stats holder. OFF by default. */
  stats?: boolean;
}

/** Options accepted by a static `restore()` -- re-derive runtime-only state. */
export interface FilterRestoreOptions {
  stats?: boolean;
}

/**
 * The uniform approximate-membership surface shared by every member of the family.
 *
 * Semantics are identical across members; only the INTERNAL structure differs. One
 * contract cannot be expressed in the type system and is stated here: `mightContain`
 * is ONE-SIDED. A `true` may be a false positive (bounded by `fpp`); a `false` is
 * always correct on an add-only member -- there are NO false negatives.
 */
export interface LiteFilter<K> {
  /** Record a key. Zero allocation on the int + string paths. */
  add(key: K): void;
  /** Query membership. NO false negatives; false positives bounded by `fpp`. */
  mightContain(key: K): boolean;
  /** The sole alias of `mightContain`, same one-sided semantics. */
  has(key: K): boolean;
  /** The number of adds recorded (a plain counter, not an estimate). */
  readonly size: number;
  /** Alias of `size`. */
  readonly count: number;
  /** The item count the filter was sized for at construction. */
  readonly capacity: number;
  /** The configured target fpp while empty, else the fill-derived estimate. */
  fpp(): number;
  /** Reset to empty. Allocates nothing (zeroes the store in place). */
  clear(): void;
  /** The live per-instance stats holder. Throws without `{ stats: true }`. */
  stats(): FilterStats;
  /** Zero the stats counters in place. Throws without `{ stats: true }`. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot. Cold; may allocate. */
  dump(): FilterSnapshot;
}

/**
 * Bloom filter (Bloom, CACM 1970) -- the reference member and differential oracle.
 * Add-only: `remove()` throws a `[lite-filter]`-tagged Error (fail closed).
 */
export class Bloom<K = unknown> implements LiteFilter<K> {
  constructor(capacity: number, options?: FilterOptions);
  add(key: K): void;
  mightContain(key: K): boolean;
  has(key: K): boolean;
  /** Bloom is add-only: this always throws a `[lite-filter]`-tagged Error. */
  remove(key: K): never;
  readonly size: number;
  readonly count: number;
  readonly capacity: number;
  fpp(): number;
  clear(): void;
  stats(): FilterStats;
  resetStats(): void;
  dump(): FilterSnapshot;
  /** Reconstruct a fresh Bloom from a snapshot. Fail closed on any mismatch. */
  static restore(snap: FilterSnapshot, opts?: FilterRestoreOptions): Bloom;
}

export const VERSION: string;
export default Bloom;
