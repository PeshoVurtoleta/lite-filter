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
 *   - `count` -- the number of adds recorded (net of removes on a deletable member).
 *   - `bits`  -- (Bloom) the bit store as a plain array of 32-bit words.
 *   - `w`     -- (CountingBloom) the counter width in bits (4).
 *   - `cnts`  -- (CountingBloom) the packed counter store as a plain array of bytes.
 *
 * Treat it as opaque: do not hand-edit it. `restore()` validates every field and
 * throws a `[lite-filter]`-tagged Error on any corruption (null is not zero). The
 * `bits` / `w` + `cnts` fields are member-specific -- each member's `restore()` only
 * accepts its own shape and rejects a foreign one via the `mem` tag.
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
  /** Bloom: the bit store as 32-bit words. */
  bits?: number[];
  /** CountingBloom: the counter width in bits (4). */
  w?: number;
  /** CountingBloom: the packed counter store as bytes (0..255). */
  cnts?: number[];
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

/**
 * Counting Bloom filter -- the deletable member. A Bloom whose bit array is replaced
 * by 4-bit SATURATING counters (two per byte): `add` increments, `remove` decrements,
 * `mightContain` is true iff every probed counter is nonzero. Costs ~4x a plain
 * Bloom's space and carries two honest caveats (decisions/0009):
 *   - `remove(key)` on a key that was NEVER added can corrupt OTHER keys' state and
 *     cause a later false negative -- only remove keys you actually added.
 *   - a counter that SATURATES at 15 is clamped forever (never decrements again), so
 *     its keys can stick present after removal.
 */
export class CountingBloom<K = unknown> implements LiteFilter<K> {
  constructor(capacity: number, options?: FilterOptions);
  add(key: K): void;
  mightContain(key: K): boolean;
  has(key: K): boolean;
  /** Delete a key. Returns true on a real delete, false if the key is absent (no
   *  mutation). See the class caveats on never-added keys and saturation. */
  remove(key: K): boolean;
  readonly size: number;
  readonly count: number;
  readonly capacity: number;
  fpp(): number;
  clear(): void;
  stats(): FilterStats;
  resetStats(): void;
  dump(): FilterSnapshot;
  /** Reconstruct a fresh CountingBloom from a snapshot. Fail closed on any mismatch. */
  static restore(snap: FilterSnapshot, opts?: FilterRestoreOptions): CountingBloom;
}

export const VERSION: string;
export default Bloom;
