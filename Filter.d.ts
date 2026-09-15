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
 *   - `f`     -- the format tag, `"litefilter/2"`. `restore()` rejects any other value.
 *   - `chk`   -- a 32-bit integrity checksum (decisions/0021). `restore()` recomputes it and
 *               rejects a mismatch fail-closed (catches a flipped keys-mode / seed).
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
  f: "litefilter/2";
  /** Family-wide 32-bit integrity checksum (decisions/0021); `restore()` recomputes and
   *  rejects a mismatch fail-closed. An integrity check against corruption, not a MAC. */
  chk: number;
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
  /** BlockedBloom: the block size in bits (512). */
  bb?: number;
  /** BlockedBloom / Cuckoo: the block / bucket count. */
  nb?: number;
  /** Cuckoo: the fingerprint width in bits (8 or 16). Named `fw` -- `f` is the tag. */
  fw?: number;
  /** Cuckoo: the bucket size (4). */
  b?: number;
  /** Cuckoo / XOR: the fingerprint store as a plain array of slots. */
  fp?: number[];
  /** XOR: the per-segment length (`bl`; the fingerprint array is `3*bl` slots). */
  bl?: number;
  /** Quotient: the remainder width in bits (r = ceil(log2(1/fpp))). */
  r?: number;
  /** Quotient: the quotient width in bits (q; nslots === 2^q; tracks a resize). */
  q?: number;
  /** Quotient: the fixed fingerprint bit budget (p = q0 + r; invariant across resize). */
  p?: number;
  /** Quotient: the slot count (2^q). */
  nslots?: number;
  /** Quotient: the load ceiling (0.90). */
  load?: number;
  /** Quotient: the slot store as a plain array of packed words ((remainder<<3)|metadata). */
  store?: number[];
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

/**
 * Blocked Bloom filter -- the cache-local member (decisions/0012, 0013). Partitions the
 * bit array into fixed 512-bit BLOCKS (one 64-byte cache line each) and routes every key
 * to ONE block, so a query touches ONE cache line regardless of k -- the throughput win.
 * Add-only like `Bloom`: `remove()` throws a `[lite-filter]`-tagged Error. The honest
 * price (decisions/0013): partitioning loses cross-block independence, so the MEASURED
 * false-positive rate runs OVER the plain-Bloom formula for the same bits/item. `fpp()`
 * returns the plain closed-form as a labeled FLOOR, not a prediction -- MEASURE with the
 * bench (`npm run bench`), which prints Bloom vs BlockedBloom side by side.
 */
export class BlockedBloom<K = unknown> implements LiteFilter<K> {
  constructor(capacity: number, options?: FilterOptions);
  add(key: K): void;
  mightContain(key: K): boolean;
  has(key: K): boolean;
  /** BlockedBloom is add-only: this always throws a `[lite-filter]`-tagged Error. */
  remove(key: K): never;
  readonly size: number;
  readonly count: number;
  readonly capacity: number;
  /** The plain-Bloom closed-form FLOOR (blocked runs OVER it); MEASURE the real rate. */
  fpp(): number;
  clear(): void;
  stats(): FilterStats;
  resetStats(): void;
  dump(): FilterSnapshot;
  /** Reconstruct a fresh BlockedBloom from a snapshot. Fail closed on any mismatch. */
  static restore(snap: FilterSnapshot, opts?: FilterRestoreOptions): BlockedBloom;
}

/**
 * Cuckoo filter (Fan, Andersen, Kaminsky & Mitzenmacher, CoNEXT 2014) -- the space-lean
 * deletable member (decisions/0014, 0015). Stores a small NONZERO fingerprint per key in
 * one of TWO candidate buckets of b=4 slots (partial-key cuckoo hashing); `add` scans
 * both and, on a full pair, kicks a victim to its alternate bucket up to 500 times. It
 * DELETES via a real `remove(key): boolean`. Two honest fail-closed rulings:
 *   - `add(key)` on a full table (500 kicks exhausted) THROWS a `[lite-filter]`-tagged
 *     Error -- fail closed, never a silent drop (decisions/0014). Headroom via size/capacity.
 *   - `remove(key)` on a key that was NEVER inserted whose fingerprint COLLIDES with a
 *     real key removes that other key's fingerprint -> a later false negative for it
 *     (decisions/0015). Only remove keys you inserted.
 * `fpp()` is the width-quantized `2b/2^f` once non-empty (typically BELOW the configured
 * target -- `f` is byte-aligned up), NOT a fill-varying estimate. MEASURE with the bench.
 */
export class Cuckoo<K = unknown> implements LiteFilter<K> {
  constructor(capacity: number, options?: FilterOptions);
  add(key: K): void;
  mightContain(key: K): boolean;
  has(key: K): boolean;
  /** Delete a key. Returns true on a real delete, false if the key is absent (no
   *  mutation). See the class caveat on never-inserted, fingerprint-colliding keys. */
  remove(key: K): boolean;
  readonly size: number;
  readonly count: number;
  readonly capacity: number;
  /** The configured target while empty, else the width-quantized `2b/2^f`. MEASURE. */
  fpp(): number;
  clear(): void;
  stats(): FilterStats;
  resetStats(): void;
  dump(): FilterSnapshot;
  /** Reconstruct a fresh Cuckoo from a snapshot. Fail closed on any mismatch. */
  static restore(snap: FilterSnapshot, opts?: FilterRestoreOptions): Cuckoo;
}

/**
 * Quotient filter (Bender et al., VLDB 2012) -- the mergeable + resizable deletable member
 * (decisions/0016, 0017). ONE open-addressed linear slot array; a key's hash splits into a
 * QUOTIENT (home slot index) and a REMAINDER (stored, r bits), with 3 metadata bits per
 * slot (is_occupied, is_continuation, is_shifted) encoding runs and clusters. It DELETES
 * via a real `remove(key): boolean` and, uniquely in the family so far, ships `merge()` and
 * `resize()` -- cold paths that reconstruct each element's identity from its stored
 * `(quotient, remainder)` pair WITHOUT the original keys (the bit budget p = q0 + r is fixed
 * for the filter's lifetime). Three honest edges:
 *   - `add(key)` at the 0.90 load ceiling (or whose linear cluster shift would run off the
 *     end) THROWS a `[lite-filter]`-tagged Error and is a BYTE-IDENTICAL no-op
 *     (decisions/0016) -- never a silent drop; headroom via size/capacity.
 *   - `remove(key)` on a NEVER-INSERTED key whose (quotient, remainder) COLLIDES with a
 *     real key removes that other key's fingerprint -> a later false negative for it
 *     (decisions/0017). Only remove keys you inserted.
 *   - a Quotient stores MULTIPLICITY (it does not dedup, like Cuckoo), and its FPR is the
 *     remainder-quantized `load * 2^-r` once non-empty (typically BELOW target -- r rounds
 *     up). `fpp()` reports that. Space is metadata + shift overhead on top of r bits/item.
 */
export class Quotient<K = unknown> implements LiteFilter<K> {
  constructor(capacity: number, options?: FilterOptions);
  add(key: K): void;
  mightContain(key: K): boolean;
  has(key: K): boolean;
  /** Delete a key. Returns true on a real delete, false if the key is absent (no
   *  mutation). See the class caveat on never-inserted, fingerprint-colliding keys. */
  remove(key: K): boolean;
  readonly size: number;
  readonly count: number;
  readonly capacity: number;
  /** The configured target while empty, else the remainder-quantized `load * 2^-r`. */
  fpp(): number;
  clear(): void;
  stats(): FilterStats;
  resetStats(): void;
  dump(): FilterSnapshot;
  /** Rebuild into a fresh slot array sized for `newCapacity`, preserving membership and
   *  exact size without the original keys. Cold; may allocate. Returns this filter. */
  resize(newCapacity: number): Quotient<K>;
  /** Merge an identically-configured Quotient into this one (union membership, exact
   *  additive size). Rejects a mismatched filter fail-closed. Cold; may allocate.
   *  Returns this filter. */
  merge(other: Quotient<K>): Quotient<K>;
  /** Reconstruct a fresh Quotient from a snapshot. Fail closed on any mismatch. */
  static restore(snap: FilterSnapshot, opts?: FilterRestoreOptions): Quotient;
}

/**
 * XOR filter (Graf & Lemire, ACM JEA 2020) -- the space-optimal STATIC member
 * (decisions/0018, 0019, 0020). The FIRST immutable member: built ONCE from a KNOWN key
 * set via the static `XorFilter.from(iterable, options)` (or the `.build` alias), then
 * FROZEN. It approaches the ~1.23x information-theoretic space lower bound by peeling a
 * 3-uniform hypergraph -- each key touches 3 fingerprint slots (one per segment), assigned
 * so a key's three slots XOR to its fingerprint. Three defining traits:
 *   - STATIC: there is no public constructor (`new XorFilter()` throws) and no mutation --
 *     `add` / `remove` / `clear` all throw a `[lite-filter]`-tagged Error (decisions/0019).
 *     Rebuild with `XorFilter.from(newKeys)` to change membership.
 *   - KEYS ARE A SET: `from()` DEDUPES its input (contrast Cuckoo / Quotient, which store
 *     multiplicity); `size` is the deduped key count.
 *   - WIDTH: the fingerprint is byte-aligned -- 8 bits when `fpp >= 2^-8` (~0.0039), else
 *     16 bits; `fpp < 2^-16` throws (the 16-bit floor). `fpp()` reports the width-quantized
 *     `2^-fw`, typically BELOW the configured target -- MEASURE with the bench.
 * A build over a DEGENERATE key set (many keys that String()-encode identically ->
 * duplicate hypergraph edges) exhausts 100 reseeds and throws `[lite-filter]` fail-closed;
 * it never ships a partial build.
 */
export class XorFilter<K = unknown> {
  private constructor();
  /** Query membership. NO false negatives for a key in the built set; false positives
   *  bounded by the width-quantized `2^-fw`. Zero allocation on the int + string paths. */
  mightContain(key: K): boolean;
  /** The sole alias of `mightContain`, same one-sided semantics. */
  has(key: K): boolean;
  /** A static filter has no incremental add: this always throws a `[lite-filter]` Error. */
  add(key: K): never;
  /** A static filter cannot delete: this always throws a `[lite-filter]` Error. */
  remove(key: K): never;
  /** A static filter has nothing to clear to: this always throws a `[lite-filter]` Error. */
  clear(): never;
  /** The deduped key count the filter was built from (a plain counter, not an estimate). */
  readonly size: number;
  /** Alias of `size`. */
  readonly count: number;
  /** The deduped key count (== size; an XOR filter is built from exactly its set). */
  readonly capacity: number;
  /** The width-quantized `2^-fw` (typically below the configured target). MEASURE. */
  fpp(): number;
  /** The live per-instance stats holder. Throws without `{ stats: true }`. */
  stats(): FilterStats;
  /** Zero the stats counters in place. Throws without `{ stats: true }`. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot. Cold; may allocate. */
  dump(): FilterSnapshot;
  /** Build a frozen XOR filter from a known key set (deduped internally). Peels the
   *  3-uniform hypergraph with up to 100 deterministic reseeds; throws `[lite-filter]`
   *  fail-closed on an unpeelable (degenerate) set -- never a partial build. Cold. */
  static from<K = unknown>(iterable: Iterable<K>, options?: FilterOptions): XorFilter<K>;
  /** The `.build` alias of `from` -- the family's static-build verb, same contract. */
  static build<K = unknown>(iterable: Iterable<K>, options?: FilterOptions): XorFilter<K>;
  /** Reconstruct a fresh XorFilter from a snapshot. Fail closed on any mismatch. */
  static restore(snap: FilterSnapshot, opts?: FilterRestoreOptions): XorFilter;
}

export const VERSION: string;
export default Bloom;
