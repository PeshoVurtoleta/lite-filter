/**
 * @zakkster/lite-filter -- Zero-dependency, zero-GC approximate-membership filters
 *
 * A family of probabilistic "have I seen this key?" filters under ONE uniform
 * `LiteFilter<K>` surface, exactly as `@zakkster/lite-lru` puts its eviction
 * policies under one `LiteCache<K,V>` surface. v0.1.0 ships the SUBSTRATE plus the
 * reference member -- `Bloom` (Bloom, "Space/Time Trade-offs in Hash Coding with
 * Allowable Errors", CACM 1970) -- the differential oracle every later member is
 * measured against and the honest floor everything else improves on.
 *
 * The two HOT-PATH primitives are `add` and `mightContain`; everything else is
 * cold or opt-in. A Bloom filter is one bit array of `m` bits and `k` hash
 * positions per key: `add` sets `k` bits, `mightContain` returns true only if all
 * `k` bits are set. It is one-sided -- NO false negatives (a key that was added
 * always reads true), only false POSITIVES, bounded by the configured `fpp`.
 *
 * Zero-GC design (ROADMAP section 6; suite CLAUDE.md):
 *   - ONE preallocated `Uint32Array` bit store, sized ONCE at construction from
 *     (n, fpp) and reused forever. No per-op array/object/boxed-number allocation.
 *   - Kirsch & Mitzenmacher enhanced double hashing ("Less Hashing, Same
 *     Performance", 2006): all `k` probe positions come from just TWO base hashes
 *     `h_i = (h1 + i*h2) mod m`, so a probe needs zero scratch storage and only two
 *     real hash computations.
 *   - `keys:'int'` strict-zero-alloc mode: a 32-bit integer key is mixed with the
 *     murmur3 fmix32 finalizer directly -- no string encoding, no allocation at all.
 *     A string key hashes over its code units (also alloc-free); an arbitrary key
 *     is honestly AMORTIZED where it must `String()`-encode (stated, not hidden).
 *   - Opt-in `{ stats: true }` mints a per-instance holder; OFF by default so the
 *     hot path writes NOTHING (`_stats === null`, decisions/0004 mirror of lite-lru).
 *   - Fail closed on every unverified state: an impossible sizing request, a bad
 *     int key, a corrupt snapshot, or a `remove` on an add-only member all throw a
 *     `[lite-filter]`-tagged Error. null is not zero.
 *
 * The 2nd member -- `CountingBloom` -- swaps the bit array for 4-bit SATURATING
 * counters (two per byte) so it can `remove()`: add increments, remove decrements,
 * `mightContain` is true iff every probed counter is nonzero. It costs ~4x a plain
 * Bloom's space and carries two honest caveats (decisions/0009): removing a key that
 * was never added can corrupt OTHER keys, and a counter that saturates at 15 sticks.
 *
 * The 3rd member -- `BlockedBloom` -- partitions the bit array into fixed 512-bit
 * BLOCKS (one 64-byte cache line each) and routes every key to ONE block, so a query
 * is ONE cache miss regardless of k (decisions/0012). It is add-only like Bloom. The
 * honest price (decisions/0013): partitioning loses cross-block independence, so its
 * MEASURED false-positive rate runs OVER the plain-Bloom formula for the same bits/item
 * -- fpp() reports the plain closed-form as a labeled FLOOR and the bench prints the two
 * members side by side (query ns down, FPR up). No "same fpp for free" claim.
 *
 * The 4th member -- `Cuckoo` (Fan, Andersen, Kaminsky & Mitzenmacher, "Cuckoo Filter:
 * Practically Better Than Bloom", CoNEXT 2014) -- stores a small nonzero FINGERPRINT per
 * key in one of TWO candidate buckets of b=4 slots each, chosen by partial-key cuckoo
 * hashing: `i1 = hash(key) & (nb-1)`, `i2 = (i1 XOR hash(fp)) & (nb-1)` (an INVOLUTION --
 * `i1 = (i2 XOR hash(fp)) & (nb-1)` -- so an evicted fingerprint finds its alternate
 * bucket from the fingerprint alone). add scans i1 then i2 for an empty slot; on a full
 * pair it KICKS a random victim to its alternate bucket up to 500 times using a SINGLE
 * scalar victim register (no scratch array). It DELETES (remove -> boolean) and its FPR
 * is width-quantized to ~2b/2^f (decisions/0014). Two honest fail-closed rulings: an
 * insert that exhausts 500 kicks THROWS (the table is at capacity -- fail closed, never a
 * silent drop, decisions/0014), and deleting a NEVER-INSERTED key whose fingerprint
 * collides removes a DIFFERENT real key's fingerprint -> a false negative for that key
 * (decisions/0015). Fingerprint 0 is the empty-slot sentinel; the fingerprint hash never
 * emits 0. The store is ONE `Uint8Array` (f<=8) or `Uint16Array` (9..16 bits) of nb*b
 * slots, sized once and reused; clear() zeroes it in place.
 *
 * The 5th member -- `Quotient` (Bender et al., "Don't Thrash: How to Cache Your Hash on
 * Flash", VLDB 2012) -- is ONE open-addressed linear slot array. A key's hash splits into a
 * QUOTIENT (home slot index, high bits) and a REMAINDER (stored, low r bits); same-home
 * keys form a RUN and adjacent runs a CLUSTER, encoded by 3 METADATA bits per slot
 * (is_occupied, is_continuation, is_shifted) packed in the low 3 bits of each byte-aligned
 * word (remainder in the high bits). It DELETES (remove -> boolean), and ALSO ships
 * `merge()` + `resize()` -- both cold paths that reconstruct each element's identity from
 * its stored `(quotient, remainder)` pair WITHOUT the original keys (the fingerprint bit
 * budget p = q0 + r is fixed for the filter's lifetime, decisions/0016). Its FPR is
 * remainder-quantized (`load * 2^-r`, typically UNDER target because r rounds up). Two
 * honest edges: a fail-closed insert at the 0.90 load ceiling / off the linear end (a
 * byte-identical no-op, decisions/0016), and the same never-added delete caveat as Cuckoo
 * (decisions/0017). Delete repairs metadata by REBUILDING the affected cluster through the
 * verified insert path -- so the shift-back is provably correct by construction.
 *
 * Design decisions live in decisions/ (0001 hashing; 0002 sizing; 0003 remove +
 * count; 0004 fpp; 0005 snapshot; 0006 deferred static-build API; 0007 counter
 * width; 0008 saturation; 0009 remove caveat; 0010 count deferred; 0011 CBF
 * snapshot; 0012 block size; 0013 FPR locality; 0014 Cuckoo sizing/overload; 0015
 * Cuckoo delete caveat; 0016 Quotient sizing/split/storage/ceiling/resize; 0017
 * Quotient delete caveat) and are summarized in ROADMAP.md.
 *
 * @license MIT
 */

export const VERSION = "0.6.0";

/* -------------------------------------------------------------------------- *
 * Constants + fail-closed messages (built ONCE, thrown only on misuse).
 * -------------------------------------------------------------------------- */

/** Accepted int-key domain bounds (decisions/0001): 32-bit signed integers.
 *  Mirrors lite-lru's keys:'int' door so the two libraries feel identical. */
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/** Fail-closed message for a bad integer-mode key (decisions/0001). Built once. */
const INT_KEY_MSG =
    "[lite-filter] keys:'int' requires a 32-bit signed integer key, got ";

/** Fail-closed message for remove() on an add-only member (decisions/0003). Bloom
 *  cannot delete: clearing k bits would corrupt every other key that shares one of
 *  them, causing later FALSE NEGATIVES. We reject loudly rather than silently no-op
 *  or silently corrupt. Built once, thrown only on misuse. */
const REMOVE_MSG =
    "[lite-filter] Bloom is add-only and cannot remove(); clearing bits would cause " +
    "false negatives for other keys. Use a deletable member (Counting Bloom / Cuckoo) " +
    "when the roster ships one.";

/** Fail-closed message for stats()/resetStats() on a non-stats instance
 *  (decisions/0004). Built once, thrown only when the accessor is used on a filter
 *  that was not constructed with `{ stats: true }` (there is no holder -- a caller
 *  bug, not zeros; null is not zero). */
const STATS_OFF_MSG =
    "[lite-filter] stats()/resetStats() require the filter to be constructed with " +
    "{ stats: true }; this instance has no stats configured";

/** The snapshot format tag (decisions/0005, 0021). A `dump()` carries it; `restore()`
 *  rejects any other value fail-closed. Versioned so a layout change is a clean,
 *  detectable break rather than a silent misread. Bumped to `litefilter/2` in v0.6.0:
 *  every snapshot now carries an integrity checksum (`chk`, decisions/0021), and a v1
 *  snapshot (which has none) cannot be integrity-verified -- so it is REJECTED. */
const SNAP_TAG = "litefilter/2";

/** CountingBloom counter width (decisions/0007): 4 bits per counter (a nibble),
 *  two counters packed per byte. The saturation ceiling is MAX_COUNT = 15 -- a
 *  nibble at 15 is CLAMPED (never wraps on add, never decrements on remove;
 *  decisions/0008). Four bits is the width where the packed store still costs
 *  ~4x a plain Bloom's bits while making overflow negligibly rare at a 1% fpp. */
const COUNTER_WIDTH = 4;
const MAX_COUNT = 15;

/** BlockedBloom block geometry (decisions/0012). A key touches exactly ONE 512-bit
 *  block -- 16 x 32-bit words = 64 bytes, one cache line on x86-64 and Apple Silicon --
 *  so a query is ONE cache miss regardless of k. 512 is PINNED, the only production
 *  path, NOT configurable (decisions/0012). BLOCK_BITS is the within-block position
 *  mask domain (`pos & (BLOCK_BITS-1)`); BLOCK_WORDS is the per-block word count. */
const BLOCK_BITS = 512;
const BLOCK_WORDS = 16;

/** Fail-closed message for remove() on BlockedBloom (decisions/0003, add-only like
 *  Bloom). Clearing k block-local bits would corrupt every other key that shares one
 *  of them (a later FALSE NEGATIVE), so we reject loudly. Built once, thrown on misuse. */
const BB_REMOVE_MSG =
    "[lite-filter] BlockedBloom is add-only and cannot remove(); clearing bits would " +
    "cause false negatives for other keys. Use a deletable member (Counting Bloom / " +
    "Cuckoo) when the roster ships one.";

/** Cuckoo bucket size b (decisions/0014): 4 slots per bucket, PINNED (not configurable).
 *  b=4 is the classic Cuckoo-filter sweet spot -- it reaches ~95% load before insert
 *  failures while keeping the fingerprint width (and thus the FPR) small. */
const CUCKOO_B = 4;

/** Cuckoo maximum eviction chain length (decisions/0014): 500 kicks, PINNED. Beyond this
 *  the table is treated as full and add() throws (fail closed). 500 is the reference
 *  ceiling from Fan et al. 2014 -- long enough that a real insert almost never hits it
 *  below the load target, short enough that a genuinely full table fails fast. */
const CUCKOO_KICKS = 500;

/** Cuckoo load target for bucket-count derivation (decisions/0014): 0.95. The bucket
 *  count is ceil(capacity / (b * load)) rounded UP to a power of two, so the REAL slot
 *  capacity is nb*b >= capacity/0.95 -- headroom before the kick ceiling bites. */
const CUCKOO_LOAD = 0.95;

/** Fail-closed message when the requested fpp needs a fingerprint wider than 16 bits
 *  (decisions/0014). f = ceil(log2(2b/fpp)) = ceil(log2(8/fpp)) at b=4; f>16 means
 *  fpp < 8/65536. Built once, thrown only at construction. */
const CUCKOO_FPP_MSG =
    "[lite-filter] Cuckoo fpp too small: the derived fingerprint width would exceed 16 " +
    "bits; the smallest supported fpp at b=4 (16-bit fingerprints) is 8/65536 " +
    "(~0.000122). Raise the fpp, or use a space-optimal static member (XOR / Binary " +
    "Fuse) when the roster ships one.";

/** Fail-closed message when an insert exhausts CUCKOO_KICKS evictions (decisions/0014).
 *  The table is at capacity (load factor too high); add() THROWS rather than silently
 *  dropping the fingerprint (which would be a false negative). Built once, thrown only on
 *  a genuinely full table. */
const CUCKOO_FULL_MSG =
    "[lite-filter] Cuckoo insert failed after 500 kicks: the filter is at capacity (load " +
    "factor too high). Raise the capacity (size up) -- the overload is FAIL-CLOSED, never " +
    "a silent drop. Observe headroom via size vs capacity before it bites.";

/** Quotient filter load ceiling (decisions/0016): 0.90. The slot count is the
 *  smallest power of two `2^q >= ceil(capacity / 0.90)`, so a filter sized for
 *  `capacity` items can hold at least that many before the ceiling bites. An insert
 *  that would push occupancy past `floor(0.90 * nslots)`, or whose linear cluster
 *  shift would run off the end of the slot array, THROWS fail-closed (a byte-identical
 *  no-op). PINNED, not a constructor option. */
const QF_LOAD = 0.90;

/** Quotient filter metadata bit masks (decisions/0016). Each slot word packs three
 *  metadata bits in the LOW 3 bits and the remainder in the HIGH bits:
 *  `word = (remainder << 3) | metadata`. A slot is EMPTY iff all three metadata bits
 *  are 0 (remainder 0 is a LEGAL remainder -- emptiness is carried by metadata, never
 *  by the remainder value). */
const QF_OCCUPIED = 1;      // bit0: this canonical slot is home to some stored key
const QF_CONTINUATION = 2;  // bit1: the remainder here continues a run (not its head)
const QF_SHIFTED = 4;       // bit2: the remainder here is not in its canonical slot
const QF_META = 7;          // all three metadata bits
const QF_RSHIFT = 3;        // remainder occupies bits [3, 3+r)

/** Fail-closed message when the requested fpp needs a remainder wider than the
 *  byte-aligned slot word can carry (decisions/0016). `r = ceil(log2(1/fpp))`; the slot
 *  word is `r + 3` bits (remainder + 3 metadata), byte-aligned to a Uint8Array (r <= 5)
 *  or Uint16Array (r 6..13). `r + 3 > 16` (fpp below ~1/2^13) exceeds the 16-bit floor
 *  and throws -- parallel to Cuckoo's 16-bit fingerprint floor. Built once. */
const QF_FPP_MSG =
    "[lite-filter] Quotient fpp too small: the derived remainder width r + 3 metadata " +
    "bits would exceed a 16-bit slot word (r <= 13); the smallest supported fpp is " +
    "1/2^13 (~0.000122). Raise the fpp, or use a space-optimal static member (XOR / " +
    "Binary Fuse) when the roster ships one.";

/** Fail-closed message when the quotient + remainder bit budget exceeds the 32-bit base
 *  hash (decisions/0016). A key's hash supplies `q + r` bits (quotient high, remainder
 *  low); `q + r > 32` cannot be drawn from one 32-bit fmix, so construction throws.
 *  Built once, thrown only at construction for very large capacities. */
const QF_BITS_MSG =
    "[lite-filter] requested Quotient filter is too large: the quotient + remainder bit " +
    "budget (q + r) would exceed the 32-bit base hash; lower the capacity or raise the fpp";

/** Fail-closed message when an insert cannot place (decisions/0016): the load ceiling is
 *  reached or the linear cluster shift would run off the end of the slot array. The
 *  insert THROWS and is a BYTE-IDENTICAL no-op (no partial shift is left behind). Built
 *  once, thrown only on a genuinely full filter. */
const QF_FULL_MSG =
    "[lite-filter] Quotient insert failed: the filter is at the 0.90 load ceiling (or the " +
    "cluster shift would run off the end). Raise the capacity (size up) or resize() -- the " +
    "overload is FAIL-CLOSED and a byte-identical no-op, never a silent drop. Observe " +
    "headroom via size vs capacity before it bites.";

/** Fail-closed message when merge() is called with a filter of non-identical params
 *  (decisions/0016). merge requires the SAME seed, remainder width, fingerprint bit
 *  budget, and keys mode; anything else would misalign the (quotient, remainder) split
 *  and corrupt membership. Built once, thrown only on a mismatched merge. */
const QF_MERGE_MSG =
    "[lite-filter] merge(other) requires an identically-configured Quotient (same seed, " +
    "fpp-derived remainder width, hash bit budget, and keys mode); merging mismatched " +
    "filters would misalign the quotient/remainder split and cause false negatives.";

/** Default target false-positive probability when the caller omits `fpp`
 *  (decisions/0002): the textbook 1% baseline. Explicit and documented, never a
 *  hidden magic number smuggled onto a hot path. */
const DEFAULT_FPP = 0.01;

/** Default hash seed (decisions/0001). A fixed constant so a filter's behavior is
 *  deterministic across runs; overridable via `{ seed }` for A/B hashing. */
const DEFAULT_SEED = 0x9e3779b1;

/* -------------------------------------------------------------------------- *
 * XOR filter constants (decisions/0018, 0019, 0020; Graf & Lemire, "Xor Filters:
 * Faster and Smaller Than Bloom and Cuckoo Filters", ACM JEA 2020). The FIRST static
 * member: built ONCE from a KNOWN key set by peeling a 3-uniform hypergraph, then
 * frozen. No add/remove/clear -- membership is fixed at construction.
 * -------------------------------------------------------------------------- */

/** The XOR filter is 3-uniform: every key touches exactly 3 fingerprint slots, one in
 *  each of 3 equal SEGMENTS (decisions/0018). PINNED (the peeling threshold and the
 *  ~1.23x space factor are both tied to arity 3). */
const XOR_ARITY = 3;

/** The ~1.23x space factor (decisions/0018): the segment length is
 *  `ceil(1.23 * n / 3) + 32`, so the total array is `3*bl ~= 1.23*n + 96` slots. 1.23
 *  is just above the 3-uniform peeling threshold (~1.222 slots/key), and the +32 per
 *  segment gives small-n slack; together they keep a random key set peelable in one or
 *  two attempts. PINNED. */
const XOR_LOAD = 1.23;

/** Per-segment additive padding (decisions/0018): +32 slots per segment (=+96 total)
 *  so small key sets sit comfortably above the peeling threshold. PINNED. */
const XOR_SEGMENT_PAD = 32;

/** The peeling reseed ceiling (decisions/0018): try up to 100 deterministic reseeds
 *  `seed ^ (attempt * 0x9e3779b1)` before giving up. A random key set peels on the
 *  first attempt with overwhelming probability; exhaustion means a DEGENERATE key set
 *  (e.g. many keys that encode to the same string -> duplicate hypergraph edges that no
 *  reseed can separate), which THROWS fail-closed rather than shipping a partial build. */
const XOR_MAX_ATTEMPTS = 100;

/** The 8-bit fingerprint's characteristic FPR, 2^-8 (decisions/0020). `fpp >= 2^-8`
 *  (~0.0039) admits an 8-bit fingerprint (a `Uint8Array`); a tighter target widens to
 *  16 bits. Byte-aligned like Cuckoo/Quotient. */
const XOR_FP8_FPP = 0.00390625;

/** The 16-bit fingerprint's characteristic FPR, 2^-16 (decisions/0020). This is the
 *  floor: `fpp < 2^-16` (~0.0000153) would need a wider-than-16-bit fingerprint and
 *  THROWS fail-closed (parallel to Cuckoo's / Quotient's 16-bit floor). */
const XOR_FP16_FPP = 0.0000152587890625;

/** The largest fingerprint array the too-large door admits (decisions/0020). `3*bl`
 *  must fit a typed-array length AND keep the position math (`hash % bl`) exact; capped
 *  well below the typed-array limit so the allocation never throws an opaque RangeError. */
const XOR_MAX_SLOTS = 0x3fffffff; // ~1.07e9 slots

/** Fail-closed message: `new XorFilter()` is forbidden -- a static member is built via
 *  the factory, never incrementally (decisions/0018). Built once, thrown only on misuse. */
const XOR_CTOR_MSG =
    "[lite-filter] XorFilter is a STATIC member built from a known key set: use " +
    "XorFilter.from(iterable, options) (or the .build alias), not new XorFilter().";

/** Fail-closed message: a static filter has no mutation surface (decisions/0019).
 *  add/remove/clear all throw this -- membership is fixed at construction. Rebuild with
 *  XorFilter.from(newKeys) to change the set. Built once, thrown only on misuse. */
const XOR_STATIC_MSG =
    "[lite-filter] XorFilter is immutable: a static filter is built once from a fixed " +
    "key set and has no add()/remove()/clear(). Rebuild with XorFilter.from(newKeys) to " +
    "change membership (a deletable member -- Counting Bloom / Cuckoo / Quotient -- mutates in place).";

/** Fail-closed message: an XOR filter over ZERO keys is undefined (decisions/0018);
 *  null is not zero. Built once, thrown only on an empty key set. */
const XOR_EMPTY_MSG =
    "[lite-filter] XorFilter.from() requires a non-empty key set; a filter over zero keys " +
    "is undefined (null is not zero).";

/** Fail-closed message when the requested fpp needs a fingerprint wider than 16 bits
 *  (decisions/0020): `fpp < 2^-16`. Built once, thrown only at construction. */
const XOR_FPP_MSG =
    "[lite-filter] XOR fpp too small: the fingerprint width would exceed 16 bits; the " +
    "smallest supported fpp is 2^-16 (~0.0000153). Raise the fpp.";

/** Fail-closed message when peeling exhausts every reseed (decisions/0018). Expected
 *  ONLY for a degenerate key set (duplicate-encoding keys -> parallel hypergraph edges
 *  no reseed can separate). Built once, thrown only on a genuinely unpeelable set. */
const XOR_CONSTRUCT_MSG =
    "[lite-filter] XorFilter.from() could not construct after 100 peeling attempts: the " +
    "key set produced an unpeelable 3-uniform hypergraph under every reseed. This is " +
    "expected only for a DEGENERATE set -- e.g. many distinct keys that encode to the same " +
    "string (String(key) collision -> duplicate edges). Check for duplicate-encoding keys.";

/** Fail-closed message when the derived array would exceed the too-large cap
 *  (decisions/0020). Built once, thrown only at construction for very large key sets. */
const XOR_TOO_LARGE_MSG =
    "[lite-filter] requested XOR filter is too large (would need > " + XOR_MAX_SLOTS +
    " fingerprint slots); lower the key count.";

/** Module-private build brand (decisions/0018). The constructor throws on any token but
 *  this one, so `new XorFilter()` fails closed while the static `from`/`build`/`restore`
 *  factories construct a bare instance internally. Never exported. */
const XOR_BUILD_TOKEN = Symbol("lite-filter/xor.build");

/** ln(2) and ln(2)^2 precomputed (decisions/0002): the Bloom sizing constants.
 *  Cold path -- used only in the constructor -- but computed once regardless. */
const LN2 = Math.LN2;
const LN2SQ = Math.LN2 * Math.LN2;

/* -------------------------------------------------------------------------- *
 * Hash trio (decisions/0001). The murmur3 fmix32 finalizer is the default
 * arbitrary-key mixer; a 32-bit integer takes a direct mix (no encoding); a string
 * hashes over its code units. Validated by the bench's FPR-vs-theory number
 * (ROADMAP section 5), NOT chosen by reputation.
 * -------------------------------------------------------------------------- */

/**
 * murmur3 fmix32 -- the 32-bit avalanche finalizer. `Math.imul` is an EXACT 32-bit
 * multiply (zero-alloc), and `>>>` coerces to unsigned, so a single set bit in the
 * input spreads across the whole word. Returns an unsigned 32-bit integer.
 */
function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/**
 * murmur3-style 32-bit hash over a string's UTF-16 code units (decisions/0001).
 * `charCodeAt` returns a number -- the loop allocates NOTHING -- so string keys are
 * zero-alloc on the default backing too; only a non-string, non-int key pays a
 * `String()` encode (the honest AMORTIZED caveat). Returns an unsigned 32-bit int.
 */
function hashStr(str, seed) {
    let h = seed >>> 0;
    const len = str.length;
    for (let i = 0; i < len; i++) {
        let k = Math.imul(str.charCodeAt(i), 0xcc9e2d51);
        k = (k << 15) | (k >>> 17);
        k = Math.imul(k, 0x1b873593);
        h ^= k;
        h = (h << 13) | (h >>> 19);
        h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    h ^= len;
    return fmix32(h);
}

/* -------------------------------------------------------------------------- *
 * Sizing (decisions/0002). Cold: called ONCE per constructor, never on a hot path.
 * The classic Bloom derivation from (n, fpp):
 *     m = ceil(-n * ln(fpp) / ln(2)^2)      bits
 *     k = round((m / n) * ln(2))            hash positions (clamped >= 1)
 * Fail closed on every impossible request -- null is not zero, an unsized filter is
 * never a zero-capacity one.
 * -------------------------------------------------------------------------- */

/**
 * Derive the bit count `m` and hash count `k` for a target `(n, fpp)`. Throws a
 * `[lite-filter]` RangeError at the door on any impossible request. Returns a plain
 * `{ m, k }` (cold path -- allocation here is fine, it never runs on add/query).
 */
function sizeFor(n, fpp) {
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(
            "[lite-filter] capacity must be an integer >= 1, got " + String(n));
    }
    if (typeof fpp !== "number" || !(fpp > 0) || !(fpp < 1)) {
        throw new RangeError(
            "[lite-filter] fpp must be a number in the open interval (0, 1), got " + String(fpp));
    }
    let m = Math.ceil((-n * Math.log(fpp)) / LN2SQ);
    if (m < 1) m = 1;
    // A bit count that would overflow a safe typed-array word count is fail-closed:
    // Uint32Array length is capped at ~2^32 - 1; words = ceil(m/32). Reject far
    // below that so the allocation itself never throws an opaque RangeError.
    if (!Number.isFinite(m) || m > 0x7fffffe0) {
        throw new RangeError(
            "[lite-filter] requested filter is too large (m=" + String(m) +
            " bits); lower the capacity or raise the fpp");
    }
    let k = Math.round((m / n) * LN2);
    if (k < 1) k = 1;
    return { m: m, k: k };
}

/**
 * Derive the Cuckoo geometry for a target (n, fpp) (decisions/0014). Cold -- called ONCE
 * per constructor, never on a hot path. Three fail-closed doors and two derivations:
 *
 *   - fingerprint width  f  = ceil(log2(2b/fpp)) = ceil(log2(8/fpp)) at b=4, then BYTE-
 *     ALIGNED UP: f<=8 -> an 8-bit store, 9..16 -> a 16-bit store. f>16 (fpp < 8/65536)
 *     throws (the store never widens past 16 bits). `bits` is the store element width.
 *   - bucket count       nb = ceil(n / (b * load)) rounded UP to a power of two, so the
 *     index math is a `& (nb-1)` mask and the alt-bucket XOR is an involution. The REAL
 *     slot capacity is nb*b >= n/load (headroom before the 500-kick ceiling bites).
 *
 * Returns a plain `{ f, bits, nb }` (cold path -- allocation here never runs on add/query).
 */
function cuckooSizeFor(n, fpp) {
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(
            "[lite-filter] capacity must be an integer >= 1, got " + String(n));
    }
    if (typeof fpp !== "number" || !(fpp > 0) || !(fpp < 1)) {
        throw new RangeError(
            "[lite-filter] fpp must be a number in the open interval (0, 1), got " + String(fpp));
    }
    // Fingerprint width from the target FPR (~2b/2^f), byte-aligned UP. Fail closed when
    // the width would exceed the 16-bit store (fpp < 8/65536); null is not zero.
    let f = Math.ceil(Math.log2((2 * CUCKOO_B) / fpp));
    if (f < 1) f = 1;
    if (f > 16) {
        throw new RangeError(CUCKOO_FPP_MSG);
    }
    const bits = f <= 8 ? 8 : 16;
    // Bucket count: pow2 >= ceil(n / (b * load)). Rounding UP to a power of two makes the
    // bucket index a mask and keeps the alt-bucket XOR an involution (decisions/0014).
    // The largest bucket count whose store (nb*b slots) stays within a safe typed-array
    // length is 2^28 (2^28 * 4 = 0x40000000 <= 0x7fffffff); any request needing more is
    // rejected BEFORE the doubling loop, so the count is derived entirely in the Number
    // domain and can never 32-bit-overflow into an infinite loop (null is not zero -- an
    // unsized filter is never valid). Mirrors the other members' "too large" doors.
    const MAX_NB = 0x10000000; // 2^28 buckets -> nb*b = 0x40000000 slots (fits Uint*Array)
    const need = Math.ceil(n / (CUCKOO_B * CUCKOO_LOAD));
    if (!Number.isFinite(need) || need > MAX_NB) {
        throw new RangeError(
            "[lite-filter] requested Cuckoo filter is too large (needs ~" + String(need) +
            " buckets, max " + MAX_NB + "); lower the capacity or raise the fpp");
    }
    // Number-domain doubling (never `<<`, which would wrap at 2^31): `need <= 2^28` here, so
    // this runs at most 28 iterations and `nb` stays an exact power-of-two safe integer.
    let nb = 1;
    while (nb < need) nb *= 2;
    return { f: f, bits: bits, nb: nb };
}

/**
 * Derive the Quotient-filter geometry for a target (n, fpp) (decisions/0016). Cold --
 * called ONCE per constructor, never on a hot path. Two derivations and three fail-closed
 * doors:
 *
 *   - remainder width  r  = ceil(log2(1/fpp)). The slot WORD is `r + 3` bits (remainder
 *     in the high bits, 3 metadata bits in the low bits), byte-aligned UP: `r + 3 <= 8`
 *     (r <= 5) -> a Uint8Array; `r + 3 <= 16` (r 6..13) -> a Uint16Array; `r + 3 > 16`
 *     (fpp below ~1/2^13) THROWS (the byte-aligned 16-bit floor, parallel to Cuckoo).
 *   - quotient width   q  chosen so `nslots = 2^q >= ceil(n / 0.90)` (the load ceiling).
 *
 * The base hash supplies `q + r` bits (quotient from the HIGH bits, remainder from the
 * LOW bits, decisions/0016); `q + r > 32` cannot come from one 32-bit fmix and throws.
 * A fail-closed too-large door caps `q` before the doubling loop (mirrors cuckooSizeFor's
 * MAX_NB). Returns a plain `{ r, bits, q, nslots }` (cold path -- alloc here is fine).
 */
function quotientSizeFor(n, fpp) {
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(
            "[lite-filter] capacity must be an integer >= 1, got " + String(n));
    }
    if (typeof fpp !== "number" || !(fpp > 0) || !(fpp < 1)) {
        throw new RangeError(
            "[lite-filter] fpp must be a number in the open interval (0, 1), got " + String(fpp));
    }
    // Remainder width from the target FPR (~2^-r), byte-aligned via the r+3 slot word.
    let r = Math.ceil(Math.log2(1 / fpp));
    if (r < 1) r = 1;
    if (r + QF_RSHIFT > 16) {
        throw new RangeError(QF_FPP_MSG);
    }
    const bits = (r + QF_RSHIFT) <= 8 ? 8 : 16;
    // Slot count: the smallest power of two >= ceil(n / load). The largest slot count that
    // stays within a safe typed-array length is 2^31 (fits a Uint16Array's element count);
    // any request needing more is rejected BEFORE the doubling loop, so the count is
    // derived entirely in the Number domain and can never 32-bit-overflow into a spin.
    const MAX_NSLOTS = 0x80000000; // 2^31 slots
    const need = Math.ceil(n / QF_LOAD);
    if (!Number.isFinite(need) || need > MAX_NSLOTS) {
        throw new RangeError(
            "[lite-filter] requested Quotient filter is too large (needs ~" + String(need) +
            " slots, max " + MAX_NSLOTS + "); lower the capacity or raise the fpp");
    }
    // Number-domain doubling (never `<<`, which would wrap at 2^31).
    let nslots = 1;
    let q = 0;
    while (nslots < need) { nslots *= 2; q++; }
    if (q < 1) { q = 1; nslots = 2; }   // at least 2 slots so q >= 1 (a valid quotient)
    // The base hash must supply q + r bits (quotient high, remainder low). Fail closed
    // when the budget exceeds one 32-bit fmix; null is not zero (decisions/0016).
    if (q + r > 32) {
        throw new RangeError(QF_BITS_MSG);
    }
    return { r: r, bits: bits, q: q, nslots: nslots };
}

/**
 * The linear Quotient filter's GUARD spillover count for a slot total (decisions/0016).
 * The quotient range is [0, nslots) but clusters near the top must be able to shift right
 * without running off the end at ordinary load, so the physical array is `nslots + guard`.
 * `max(1024, nslots >> 3)` (12.5%, floored at 1024) comfortably absorbs the longest cluster
 * a well-distributed key set produces at the 0.90 load ceiling; a pathological single-
 * quotient stream that still exhausts it THROWS fail-closed (a byte-identical no-op).
 * Deterministic from nslots so restore()/resize() re-derive the same physical length.
 */
function _qfGuard(nslots) {
    const g = nslots >> 3;
    return g > 1024 ? g : 1024;
}

/**
 * Deep STRUCTURAL check of a Quotient slot array (decisions/0016). Cold -- used by
 * `restore()` so a corrupt-but-in-range snapshot is REJECTED (never truncated), matching the
 * fail-closed law fully: per-word range checks alone let a lone continuation, or a
 * shifted/continuation cluster start, slip through. Walks each cluster (maximal run of non-
 * empty slots) and enforces: slot 0 is never shifted; a cluster start is neither a
 * continuation nor shifted; #occupied homes == #runs; each run's remainders are non-
 * decreasing. Returns an error message string on the first violation, or null if sound.
 */
function _qfStructureError(store, len) {
    if ((store[0] & QF_SHIFTED) !== 0) {
        return "slot 0 is is_shifted (nothing lies left of 0)";
    }
    let p = 0;
    while (p < len) {
        if ((store[p] & QF_META) === 0) { p++; continue; }
        const cs = p;
        let ce = p;
        while (ce < len && (store[ce] & QF_META) !== 0) ce++;
        if ((store[cs] & QF_CONTINUATION) !== 0) {
            return "cluster start " + cs + " is a continuation";
        }
        if ((store[cs] & QF_SHIFTED) !== 0) {
            return "cluster start " + cs + " is is_shifted";
        }
        let homes = 0, runs = 0, prevRem = -1;
        for (let i = cs; i < ce; i++) {
            if (store[i] & QF_OCCUPIED) homes++;
            const isRunStart = (i === cs) || !(store[i] & QF_CONTINUATION);
            if (isRunStart) { runs++; prevRem = store[i] >>> QF_RSHIFT; }
            else {
                const rem = store[i] >>> QF_RSHIFT;
                if (rem < prevRem) return "run not sorted at slot " + i;
                prevRem = rem;
            }
        }
        if (homes !== runs) {
            return "cluster [" + cs + "," + ce + ") has " + homes + " occupied homes but " + runs + " runs";
        }
        p = ce;
    }
    return null;
}

/* -------------------------------------------------------------------------- *
 * XOR filter doors + peeling scaffold (decisions/0018, 0020). ALL cold: called only
 * by the static from()/build()/restore() factories, never by the query hot path.
 * -------------------------------------------------------------------------- */

/**
 * Select the XOR fingerprint width for a target fpp, or throw fail-closed (decisions/0020).
 * Byte-aligned like Cuckoo/Quotient: `fpp >= 2^-8` -> an 8-bit fingerprint; `2^-16 <= fpp
 * < 2^-8` -> 16-bit; `fpp < 2^-16` THROWS (the 16-bit floor). Fails closed on any fpp
 * outside the open interval (0, 1). Cold. Returns the width in bits (8 or 16).
 */
function _xorSizeError(fpp) {
    if (typeof fpp !== "number" || !(fpp > 0) || !(fpp < 1)) {
        throw new RangeError(
            "[lite-filter] fpp must be a number in the open interval (0, 1), got " + String(fpp));
    }
    if (fpp >= XOR_FP8_FPP) return 8;
    if (fpp >= XOR_FP16_FPP) return 16;
    throw new RangeError(XOR_FPP_MSG);
}

/**
 * The XOR segment length `bl` for a deduped key count `n`, with the empty-set and
 * too-large doors (decisions/0018, 0020). `bl = ceil(1.23 * n / 3) + 32`; the total
 * array is `3*bl`. Fails closed on `n < 1` (an XOR filter over zero keys is undefined;
 * null is not zero) and on a request whose array would exceed the too-large cap. Cold.
 * Returns `bl` (the per-segment length; the store is `3*bl`).
 */
function _xorGuard(n) {
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(XOR_EMPTY_MSG);
    }
    const bl = Math.ceil((XOR_LOAD * n) / XOR_ARITY) + XOR_SEGMENT_PAD;
    if (!Number.isFinite(bl) || bl < 1 || XOR_ARITY * bl > XOR_MAX_SLOTS) {
        throw new RangeError(XOR_TOO_LARGE_MSG);
    }
    return bl;
}

/* -------------------------------------------------------------------------- *
 * Snapshot integrity checksum (decisions/0021). Family-wide, COLD -- computed only by
 * dump()/restore(), never on a hot path. It closes a real fail-OPEN: keys-mode and seed
 * are free construction inputs that CANNOT be re-derived from the stored bytes, so a
 * flipped `keys` ("int" <-> null) or `seed` would silently reconstruct under the wrong
 * hash path (1990/2000 false negatives in the QA repro). A 32-bit checksum over the
 * provenance (tag, mem, keys-mode, seed), every sizing/width field, the count, and every
 * store word -- recomputed at restore and compared to the stored `chk` -- turns that (and
 * any single-bit store corruption) into a fail-closed throw. It is an INTEGRITY check
 * against accidental corruption, NOT a MAC: a determined forger who recomputes `chk` is
 * out of scope (same as any checksum). Reuses the murmur3 fmix32 substrate; no new deps.
 * -------------------------------------------------------------------------- */

/** One shared 8-byte scratch view for folding a JS number by its EXACT 64-bit bit
 *  pattern (so ints, floats like fpp/load, seed > 2^31, and -0 all fold canonically).
 *  Module-level, allocated ONCE; only ever touched on the cold snapshot path.
 *  NOTE: the two u32 halves are read in the HOST byte order, so the checksum assumes a
 *  little-endian host (every supported Node/V8 target: x64, arm64). A snapshot dumped on
 *  a big-endian host and restored on a little-endian one (or vice versa) FAILS CLOSED --
 *  the checksum mismatches and restore() throws; it can never accept corruption. */
const _CHK_BUF = new ArrayBuffer(8);
const _CHK_F64 = new Float64Array(_CHK_BUF);
const _CHK_U32 = new Uint32Array(_CHK_BUF);

/** Fold one number into the running 32-bit checksum by its 64-bit bit pattern. Cold. */
function _chkNum(h, x) {
    _CHK_F64[0] = +x;
    h = fmix32((h ^ _CHK_U32[0]) >>> 0);
    h = fmix32((h ^ _CHK_U32[1]) >>> 0);
    return h >>> 0;
}

/** Fold one ASCII token (the tag, the member name, the keys-mode) into the checksum,
 *  length included so a truncation cannot collide. Cold. */
function _chkStr(h, s) {
    h = fmix32((h ^ hashStr(s, 0x9e3779b9)) >>> 0);
    h = fmix32((h ^ (s.length >>> 0)) >>> 0);
    return h >>> 0;
}

/**
 * Compute the family-wide snapshot checksum (decisions/0021) in a FIXED deterministic
 * order: the format tag, the member name, the keys-mode, the seed, the member's sizing/
 * width fields (`dims`, member-specific order), the count, then the store length and
 * every store word. `keys` is folded as the token "int" or "null" so the two legal values
 * check DISTINCT (the whole point). Returns an unsigned 32-bit integer. Cold; the caller
 * (dump/restore) supplies the SNAPSHOT's own field values so a tampered field is caught.
 *
 * @param {string} mem     the member name ("Bloom", "Xor", ...)
 * @param {"int"|null} keys the keys-mode
 * @param {number} seed    the 32-bit hash seed
 * @param {number} count   the recorded size/count
 * @param {number[]} dims  the member's sizing/width fields, in a fixed member-specific order
 * @param {number[]} store the serialized store array (bits / cnts / fp / store)
 * @returns {number} the unsigned 32-bit checksum
 */
function snapChecksum(mem, keys, seed, count, dims, store) {
    let h = 0x811c9dc5 >>> 0;                 // a nonzero fold seed
    h = _chkStr(h, SNAP_TAG);
    h = _chkStr(h, mem);
    h = _chkStr(h, keys === "int" ? "int" : "null");
    h = _chkNum(h, seed);
    h = _chkNum(h, count);
    for (let i = 0; i < dims.length; i++) h = _chkNum(h, dims[i]);
    h = _chkNum(h, store.length);
    for (let i = 0; i < store.length; i++) h = _chkNum(h, store[i]);
    return h >>> 0;
}

/**
 * Recompute the checksum from a (possibly tampered) snapshot and throw fail-closed if it
 * does not match the stored `chk` (decisions/0021). Runs AFTER a member's structural checks
 * (so `store` is already a validated array of in-range words) and BEFORE any field is
 * assigned or any array is built into the new instance -- REJECT, never truncate. Catches a
 * keys-mode flip, a seed flip, and any single-bit store/field corruption.
 */
function verifySnapChecksum(snap, mem, dims, store) {
    if (!Number.isInteger(snap.chk) || snap.chk < 0 || snap.chk > 0xffffffff) {
        throw new Error(
            "[lite-filter] restore(): missing or corrupt integrity checksum chk " +
            String(snap.chk) + " (a litefilter/2 snapshot must carry a 32-bit chk)");
    }
    const actual = snapChecksum(mem, snap.keys, snap.seed, snap.count, dims, store);
    if (actual !== (snap.chk >>> 0)) {
        throw new Error(
            "[lite-filter] restore(): integrity checksum mismatch (snapshot chk=" +
            String(snap.chk) + ", recomputed=" + actual + ") -- the snapshot's provenance " +
            "(keys-mode / seed) or store has been altered; reconstructing would build a wrong " +
            "filter (silent false negatives). Rejected fail-closed (decisions/0021).");
    }
}

/**
 * ONE peeling attempt (decisions/0018). Builds the 3-uniform hypergraph for `keys` under
 * `seed`, peels degree-1 vertices onto a stack, and -- ONLY if the peel is COMPLETE
 * (stack length === n) -- assigns the fingerprint array in REVERSE peel order so every
 * key's three slots XOR to its fingerprint. Returns the fingerprint typed array on a
 * complete peel, or `null` on a peel FAILURE (a 2-core remains). Cold; allocates its own
 * scaffold each attempt.
 *
 * THE SIGNATURE FAIL-OPEN CATCH (the charter's flagged risk): a peeling loop that exits
 * WITHOUT a full peel and still assigns fingerprints ships a PARTIAL build -- silent false
 * negatives on real keys. The `if (sp !== n) return null` guard BEFORE assignment is the
 * only thing between a short stack and a fail-OPEN filter; it treats a short stack as a
 * peel failure (the caller reseeds, or throws on exhaustion), never assigning from it.
 *
 * @param {Array} keys   the deduped keys (int32 numbers when int, else arbitrary)
 * @param {boolean} int  the keys:'int' backing (no String encode)
 * @param {number} seed  the attempt seed (32-bit unsigned)
 * @param {number} seed2 the derived second seed word (fmix32(seed ^ 0x9e3779b9))
 * @param {number} n     the deduped key count (edge count)
 * @param {number} bl    the per-segment length
 * @param {number} fw    the fingerprint width (8 or 16)
 * @returns {Uint8Array|Uint16Array|null}
 */
function _xorTryBuild(keys, int, seed, seed2, n, bl, fw) {
    const m = XOR_ARITY * bl;
    const fpMask = (1 << fw) - 1;

    // Per-edge geometry: the three ABSOLUTE slot positions (one per segment) and the
    // fingerprint. Computed with EXACTLY the same math the query hot path uses, so a key
    // in the set always reads true. `hash % bl` is the range reduction: exact for any
    // 32-bit hash and any bl < 2^53 (no multiply-shift precision loss), zero-branch.
    const eh0 = new Uint32Array(n);
    const eh1 = new Uint32Array(n);
    const eh2 = new Uint32Array(n);
    const efp = new Uint16Array(n);
    for (let e = 0; e < n; e++) {
        const key = keys[e];
        let h, g;
        if (int) {
            h = fmix32((key ^ seed) | 0);
            g = fmix32((Math.imul(key | 0, 0x9e3779b1) ^ seed2) | 0);
        } else {
            h = (typeof key === "string") ? hashStr(key, seed) : hashStr(String(key), seed);
            g = fmix32((h ^ seed2) | 0);
        }
        const t = fmix32((h ^ g) | 0);
        eh0[e] = h % bl;
        eh1[e] = bl + (g % bl);
        eh2[e] = 2 * bl + (t % bl);
        efp[e] = fmix32((h + g) | 0) & fpMask;
    }

    // Incidence: per-vertex edge COUNT and XOR-of-edge-indices. When a vertex's count is
    // 1, its single remaining edge index IS its xor accumulator (the standard peeling
    // trick). The three positions of an edge live in three DISTINCT segments (h0 < bl <=
    // h1 < 2*bl <= h2), so an edge never touches the same vertex twice -- the XOR trick is
    // never corrupted by a self-collision.
    const tcount = new Uint32Array(m);
    const txor = new Uint32Array(m);
    for (let e = 0; e < n; e++) {
        let v = eh0[e]; tcount[v]++; txor[v] ^= e;
        v = eh1[e]; tcount[v]++; txor[v] ^= e;
        v = eh2[e]; tcount[v]++; txor[v] ^= e;
    }

    // Peel: repeatedly take a degree-1 vertex, record (vertex, edge) on the stack, and
    // remove that edge from all three of its vertices (which may create new degree-1
    // vertices). The queue is a plain array (cold path -- allocation is fine here); the
    // `tcount[v] !== 1` guard drops stale queue entries.
    const stackV = new Uint32Array(n);
    const stackE = new Uint32Array(n);
    let sp = 0;
    const queue = [];
    for (let v = 0; v < m; v++) if (tcount[v] === 1) queue.push(v);
    while (queue.length > 0) {
        const v = queue.pop();
        if (tcount[v] !== 1) continue;
        const e = txor[v];
        stackV[sp] = v;
        stackE[sp] = e;
        sp++;
        let p = eh0[e]; tcount[p]--; txor[p] ^= e; if (tcount[p] === 1) queue.push(p);
        p = eh1[e]; tcount[p]--; txor[p] ^= e; if (tcount[p] === 1) queue.push(p);
        p = eh2[e]; tcount[p]--; txor[p] ^= e; if (tcount[p] === 1) queue.push(p);
    }

    // FAIL-OPEN GUARD: a short stack means a 2-core survived -- an INCOMPLETE peel. Do NOT
    // assign; return null so the caller reseeds (or throws on exhaustion). Assigning from a
    // partial stack would leave real keys unsatisfied -> silent false negatives.
    if (sp !== n) return null;

    // Assign in REVERSE peel order: when an edge is assigned at its owning slot, that slot
    // is still 0 (each slot is owned by exactly one edge) and the OTHER two slots are
    // already final (their edges peeled later -> higher stack index -> assigned earlier
    // here). So fp[v] = efp ^ fp[a] ^ fp[b] ^ fp[c] makes the three slots XOR to efp.
    const arr = fw <= 8 ? new Uint8Array(m) : new Uint16Array(m);
    for (let i = sp - 1; i >= 0; i--) {
        const e = stackE[i];
        const v = stackV[i];
        arr[v] = (efp[e] ^ arr[eh0[e]] ^ arr[eh1[e]] ^ arr[eh2[e]]) & fpMask;
    }
    return arr;
}

/* -------------------------------------------------------------------------- *
 * Snapshot helpers (decisions/0005). Cold: dump()/restore() never touch the hot
 * body. The Uint32Array store IS the serial form -- emitted as a plain Array so the
 * snapshot round-trips through structuredClone AND JSON.
 * -------------------------------------------------------------------------- */

/** Validate the optional `stats` door and mint the per-instance counter holder
 *  (decisions/0004). Mirrors lite-lru's stats door: `undefined` -> no stats
 *  (`null`); `true` -> a fresh zeroed holder; any other value fails closed with a
 *  did-you-mean hint. Cold: called once per constructor. */
function validateStats(stats) {
    if (stats === undefined) return null;
    if (stats === true) return { adds: 0, queries: 0, hits: 0, misses: 0 };
    throw new TypeError(
        "[lite-filter] unknown stats option " + String(stats) + " (did you mean true?)");
}

/** Validate the optional `seed` door (decisions/0001): a 32-bit-coercible number,
 *  or `undefined` for the default. Anything else fails closed. Cold. */
function validateSeed(seed) {
    if (seed === undefined) return DEFAULT_SEED >>> 0;
    if (typeof seed !== "number" || !Number.isFinite(seed)) {
        throw new TypeError(
            "[lite-filter] seed must be a finite number, got " + String(seed));
    }
    return seed >>> 0;
}

/** Validate the optional `keys` door (decisions/0001): `undefined` -> arbitrary
 *  keys (default backing); `'int'` -> the strict-zero-alloc integer backing. Any
 *  other value fails closed with a did-you-mean hint. Returns a boolean `int`. */
function validateKeys(keys) {
    if (keys === undefined) return false;
    if (keys === "int") return true;
    throw new TypeError(
        "[lite-filter] unknown keys option " + String(keys) + " (did you mean 'int'?)");
}

/* -------------------------------------------------------------------------- *
 * Bloom -- the reference member (decisions/0001..0005). The differential oracle
 * and the honest floor. Implements the uniform LiteFilter<K> surface.
 * -------------------------------------------------------------------------- */

export class Bloom {
    /**
     * @param {number} capacity  Items the filter is sized for. Integer >= 1.
     * @param {{ fpp?: number, seed?: number, keys?: 'int', stats?: boolean }} [options]
     */
    constructor(capacity, options) {
        // Cold sizing door: fail closed on every impossible request (decisions/0002).
        const fpp = (options && options.fpp !== undefined) ? options.fpp : DEFAULT_FPP;
        const dims = sizeFor(capacity, fpp);

        this._cap = capacity;      // items sized for (the configured capacity)
        this._fpp = fpp;           // the CONFIGURED target fpp (decisions/0004)
        this._m = dims.m;          // bit count
        this._k = dims.k;          // hash positions per key

        // The keyed backing is chosen ONCE here (decisions/0001) so the hot path
        // takes one predictable branch, never a per-op type dispatch.
        this._int = validateKeys(options && options.keys);
        this._seed = validateSeed(options && options.seed);
        // A second, independent seed for the b base hash, derived from the first so
        // one `{ seed }` still fully determines behavior (decisions/0001).
        this._seed2 = fmix32(this._seed ^ 0x9e3779b9);

        // The ONE preallocated bit store: ceil(m/32) 32-bit words, sized once and
        // reused forever. `clear()` zeroes it in place -- same ArrayBuffer identity.
        this._words = new Uint32Array((this._m + 31) >>> 5);

        // Presence counter (decisions/0003): the number of add() calls, a plain
        // counter (NOT an estimate). Bloom cannot detect a duplicate add, so this
        // counts calls, not distinct keys -- documented, never overclaimed.
        this._count = 0;

        // Opt-in stats (decisions/0004): null when off (the default) so the hot path
        // writes NOTHING; a fresh per-instance holder when `{ stats: true }`.
        this._stats = validateStats(options && options.stats);
    }

    get size() { return this._count; }
    get count() { return this._count; }
    get capacity() { return this._cap; }

    // --- hot path (zero allocation; strict on keys:'int') ---------------------

    /**
     * Record a key. Sets `k` bits derived from two base hashes via enhanced double
     * hashing (decisions/0001). Zero allocation on the int + string paths; an
     * arbitrary key is amortized where it must `String()`-encode. Add-only -- there
     * is no `remove` (decisions/0003).
     */
    add(key) {
        const m = this._m;
        let a, b;
        if (this._int) {
            // Strict-zero-alloc integer backing: mix the int directly, no encoding.
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            b = (fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0) | 1) >>> 0;
        } else {
            a = this._hashKey(key);
            b = (fmix32(a ^ this._seed2) | 1) >>> 0;
        }
        const words = this._words;
        const k = this._k;
        for (let i = 0; i < k; i++) {
            const pos = ((a + Math.imul(i, b)) >>> 0) % m;
            words[pos >>> 5] |= (1 << (pos & 31));
        }
        this._count++;
        if (this._stats !== null) this._stats.adds++;
    }

    /**
     * The query. Returns true only if ALL `k` bits are set. One-sided: NO false
     * negatives (an added key always reads true), only false POSITIVES bounded by
     * the configured fpp. Zero allocation on the int + string paths.
     */
    mightContain(key) {
        const m = this._m;
        let a, b;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            b = (fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0) | 1) >>> 0;
        } else {
            a = this._hashKey(key);
            b = (fmix32(a ^ this._seed2) | 1) >>> 0;
        }
        const words = this._words;
        const k = this._k;
        let hit = true;
        for (let i = 0; i < k; i++) {
            const pos = ((a + Math.imul(i, b)) >>> 0) % m;
            if ((words[pos >>> 5] & (1 << (pos & 31))) === 0) { hit = false; break; }
        }
        if (this._stats !== null) {
            this._stats.queries++;
            if (hit) this._stats.hits++; else this._stats.misses++;
        }
        return hit;
    }

    /** The SOLE alias of `mightContain` (decisions/0003): `has` reads best at a call
     *  site and carries the SAME one-sided semantics (false positives only, never
     *  false negatives). One canonical name + one alias, never three. */
    has(key) { return this.mightContain(key); }

    /**
     * Hash an arbitrary key to a 32-bit base (decisions/0001). A string hashes over
     * its code units (alloc-free); any other type is `String()`-encoded first (the
     * honest amortized caveat). Never called on the keys:'int' path.
     */
    _hashKey(key) {
        if (typeof key === "string") return hashStr(key, this._seed);
        return hashStr(String(key), this._seed);
    }

    // --- add-only door (decisions/0003) ---------------------------------------

    /** Bloom is add-only. Fail closed rather than silently no-op or corrupt state. */
    remove() {
        throw new Error(REMOVE_MSG);
    }

    // --- cold inspection ------------------------------------------------------

    /**
     * The false-positive probability (decisions/0004). For an EMPTY filter this is
     * the CONFIGURED target; once keys are added it is the fill-derived closed-form
     * ESTIMATE `(1 - e^(-k*n/m))^k`. It is a formula, explicitly NOT a measurement
     * of your keys -- MEASURE with the bench (ROADMAP section 5). Cold, O(1).
     */
    fpp() {
        if (this._count === 0) return this._fpp;
        const exponent = -(this._k * this._count) / this._m;
        return Math.pow(1 - Math.exp(exponent), this._k);
    }

    /** Reset to empty. Allocates NOTHING: zeroes the existing bit store in place, so
     *  the ArrayBuffer identity is preserved (decisions/0002, proven by the torture
     *  gate). The presence counter resets; opt-in stats are cumulative instrumentation
     *  and SURVIVE a clear() -- reset them explicitly with resetStats(). */
    clear() {
        this._words.fill(0);
        this._count = 0;
    }

    // --- opt-in stats (decisions/0004) ----------------------------------------

    /** The live per-instance counter holder BY REFERENCE (not a snapshot). Requires
     *  `{ stats: true }`; throws fail-closed otherwise (null is not zero). */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE, so a previously borrowed holder stays valid.
     *  Requires `{ stats: true }`; throws fail-closed otherwise. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        this._stats.adds = 0;
        this._stats.queries = 0;
        this._stats.hits = 0;
        this._stats.misses = 0;
    }

    // --- snapshot / restore (decisions/0005) ----------------------------------

    /**
     * Serialize to a plain, structurally-cloneable snapshot (decisions/0005). COLD --
     * never a hot path -- and MAY allocate. The Uint32Array store IS the serial form,
     * emitted as a plain Array so it round-trips through structuredClone AND JSON.
     * The fail-closed tag `{ f, mem, m, k, cap, fpp, seed, keys, count, bits }` lets
     * `restore()` reject any mismatch or corruption (REJECT, never truncate).
     *
     * NOTE (decisions/0006): a future STATIC member (XOR / Binary Fuse) will need a
     * batch-build API (add-then-freeze vs `Member.from(iterable)`); that ruling is
     * DEFERRED to the first static member and does not change this snapshot shape.
     */
    dump() {
        const keys = this._int ? "int" : null;
        const bits = Array.from(this._words);
        return {
            f: SNAP_TAG,
            mem: "Bloom",
            m: this._m,
            k: this._k,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: keys,
            count: this._count,
            bits: bits,
            chk: snapChecksum("Bloom", keys, this._seed, this._count,
                [this._m, this._k, this._cap, this._fpp], bits),
        };
    }

    /**
     * Reconstruct a FRESH Bloom from a snapshot (decisions/0005). Fail closed on any
     * tag / member / capacity / fpp / seed / keys mismatch AND on a corrupt or
     * short bit store (REJECT, never truncate -- null is not zero). `opts` re-derives
     * runtime-only options (stats); everything structural comes FROM the snapshot.
     */
    static restore(snap, opts) {
        if (snap === null || typeof snap !== "object") {
            throw new TypeError("[lite-filter] restore(snap): snapshot must be an object");
        }
        if (snap.f !== SNAP_TAG) {
            throw new Error(
                "[lite-filter] restore(): bad format tag " + String(snap.f) +
                " (expected " + SNAP_TAG + ")");
        }
        if (snap.mem !== "Bloom") {
            throw new Error(
                "[lite-filter] restore(): member mismatch " + String(snap.mem) +
                " (this is Bloom.restore)");
        }
        // The seed is the snapshot's source of truth (the bits were computed with
        // it), so it cannot be re-derived -- but it MUST be a valid uint32 integer or
        // the snapshot is corrupt. Validate BEFORE constructing (null is not zero).
        if (!Number.isInteger(snap.seed) || snap.seed < 0 || snap.seed > 0xffffffff) {
            throw new Error(
                "[lite-filter] restore(): corrupt seed " + String(snap.seed) +
                " (must be a 32-bit unsigned integer)");
        }
        // The keys mode selects the HASH PATH, so a stripped/garbled `keys` field
        // must fail closed: silently mapping it to the arbitrary (string) backing
        // would restore an int-backed filter onto the wrong hasher and produce
        // FALSE NEGATIVES. Only the two exact values are accepted (null is not zero).
        if (snap.keys !== "int" && snap.keys !== null) {
            throw new Error(
                "[lite-filter] restore(): corrupt keys mode " + String(snap.keys) +
                " (must be 'int' or null)");
        }
        const keys = snap.keys === "int" ? "int" : undefined;
        // Rebuild from the recorded (cap, fpp, seed, keys). The sizing is
        // deterministic, so a re-derived m/k that disagrees with the snapshot means a
        // corrupt or foreign snapshot -- fail closed rather than load a wrong shape.
        const inst = new Bloom(snap.cap, {
            fpp: snap.fpp,
            seed: snap.seed,
            keys: keys,
            stats: opts && opts.stats,
        });
        if (snap.m !== inst._m) {
            throw new Error(
                "[lite-filter] restore(): bit-count mismatch (snapshot m=" + String(snap.m) +
                ", derived m=" + inst._m + ")");
        }
        if (snap.k !== inst._k) {
            throw new Error(
                "[lite-filter] restore(): hash-count mismatch (snapshot k=" + String(snap.k) +
                ", derived k=" + inst._k + ")");
        }
        const bits = snap.bits;
        if (!Array.isArray(bits) || bits.length !== inst._words.length) {
            throw new Error(
                "[lite-filter] restore(): corrupt bit store (expected " + inst._words.length +
                " words, got " + (Array.isArray(bits) ? bits.length : String(bits)) + ")");
        }
        if (!Number.isInteger(snap.count) || snap.count < 0) {
            throw new Error(
                "[lite-filter] restore(): corrupt count " + String(snap.count));
        }
        // Validate EVERY word BEFORE mutating (REJECT never truncate; null is not
        // zero). A `>>> 0` coercion would silently turn NaN/null/"str"/{} into 0 or
        // an out-of-range float into garbage -- dropping set bits and causing a
        // FALSE NEGATIVE on a previously-added key. Each word must be an exact
        // 32-bit unsigned integer, or the snapshot is corrupt (decisions/0005).
        for (let i = 0; i < bits.length; i++) {
            const w = bits[i];
            if (!Number.isInteger(w) || w < 0 || w > 0xffffffff) {
                throw new Error(
                    "[lite-filter] restore(): corrupt bit-store word at index " + i +
                    " (" + String(w) + "); each word must be a 32-bit unsigned integer");
            }
        }
        // Integrity gate (decisions/0021): the seed + keys-mode CANNOT be re-derived from
        // the bytes, so a flipped `keys` / `seed` (or any store-word bit flip) is caught
        // here -- recompute the checksum over the snapshot's own fields and REJECT on a
        // mismatch, BEFORE any word is written into the instance store.
        verifySnapChecksum(snap, "Bloom", [snap.m, snap.k, snap.cap, snap.fpp], bits);
        for (let i = 0; i < bits.length; i++) inst._words[i] = bits[i];
        inst._count = snap.count;
        return inst;
    }
}

/* -------------------------------------------------------------------------- *
 * CountingBloom -- the deletable member (decisions/0007..0011). A Bloom whose bit
 * array is replaced by an array of small SATURATING counters (4-bit nibbles): add
 * increments, remove decrements, mightContain is true iff every probed counter is
 * nonzero. This buys `remove()` -- at ~4x the space of a plain Bloom -- with two
 * documented caveats (decisions/0009): removing a NEVER-ADDED key can corrupt
 * OTHER keys' state (a later false negative), and a counter that SATURATES at 15 is
 * clamped forever (it never decrements again, so its keys stick present).
 * -------------------------------------------------------------------------- */

export class CountingBloom {
    /**
     * @param {number} capacity  Items the filter is sized for. Integer >= 1.
     * @param {{ fpp?: number, seed?: number, keys?: 'int', stats?: boolean }} [options]
     */
    constructor(capacity, options) {
        // Cold sizing door: reuse Bloom's derivation (decisions/0002) verbatim, so a
        // CountingBloom and a Bloom sized for the same (n, fpp) share m and k.
        const fpp = (options && options.fpp !== undefined) ? options.fpp : DEFAULT_FPP;
        const dims = sizeFor(capacity, fpp);

        this._cap = capacity;      // items sized for (the configured capacity)
        this._fpp = fpp;           // the CONFIGURED target fpp (decisions/0004)
        this._m = dims.m;          // counter count
        this._k = dims.k;          // hash positions per key

        this._int = validateKeys(options && options.keys);
        this._seed = validateSeed(options && options.seed);
        this._seed2 = fmix32(this._seed ^ 0x9e3779b9);

        // The ONE preallocated counter store: ceil(m/2) bytes, two 4-bit counters per
        // byte (decisions/0007). Sized once, reused forever; clear() zeroes it in
        // place -- same ArrayBuffer identity.
        this._cnts = new Uint8Array((this._m + 1) >>> 1);

        // Presence counter (decisions/0003): net add() minus successful remove(). NOT
        // an estimate and NOT a distinct-key count -- a plain call counter.
        this._count = 0;

        // Opt-in stats (decisions/0004): null when off so the hot path writes NOTHING.
        this._stats = validateStats(options && options.stats);
    }

    // size/count is net add() minus successful remove(). It is EXACT only when you
    // remove only keys you actually added; under the documented unsound-remove misuse
    // (decisions/0009) it is an approximation, floored at 0 (never negative).
    get size() { return this._count; }
    get count() { return this._count; }
    get capacity() { return this._cap; }

    // --- hot path (zero allocation; strict on keys:'int') ---------------------

    /**
     * Record a key. Increments `k` 4-bit counters derived from two base hashes via
     * enhanced double hashing (decisions/0001). Each increment SATURATES at 15
     * (decisions/0008): a counter already at 15 stays 15, it never wraps to 0. Zero
     * allocation on the int + string paths; nibble read/modify/write is pure int ops.
     */
    add(key) {
        const m = this._m;
        let a, b;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            b = (fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0) | 1) >>> 0;
        } else {
            a = this._hashKey(key);
            b = (fmix32(a ^ this._seed2) | 1) >>> 0;
        }
        const cnts = this._cnts;
        const k = this._k;
        for (let i = 0; i < k; i++) {
            const pos = ((a + Math.imul(i, b)) >>> 0) % m;
            const bi = pos >>> 1;
            const sh = (pos & 1) << 2;
            const byte = cnts[bi];
            const nib = (byte >>> sh) & 0x0f;
            // Saturating increment: a nibble at MAX_COUNT is CLAMPED (never wraps to 0).
            if (nib < MAX_COUNT) cnts[bi] = (byte & ~(0x0f << sh)) | ((nib + 1) << sh);
        }
        this._count++;
        if (this._stats !== null) this._stats.adds++;
    }

    /**
     * The query. Returns true only if ALL `k` counters are NONZERO. One-sided: NO
     * false negatives for a key that is currently present (decisions/0009 states the
     * exception -- removing a never-added key can corrupt this). Zero allocation.
     */
    mightContain(key) {
        const m = this._m;
        let a, b;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            b = (fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0) | 1) >>> 0;
        } else {
            a = this._hashKey(key);
            b = (fmix32(a ^ this._seed2) | 1) >>> 0;
        }
        const cnts = this._cnts;
        const k = this._k;
        let hit = true;
        for (let i = 0; i < k; i++) {
            const pos = ((a + Math.imul(i, b)) >>> 0) % m;
            if (((cnts[pos >>> 1] >>> ((pos & 1) << 2)) & 0x0f) === 0) { hit = false; break; }
        }
        if (this._stats !== null) {
            this._stats.queries++;
            if (hit) this._stats.hits++; else this._stats.misses++;
        }
        return hit;
    }

    /** The SOLE alias of `mightContain` (decisions/0003), same one-sided semantics. */
    has(key) { return this.mightContain(key); }

    /**
     * Delete a key (decisions/0009). TWO passes, NO scratch storage. Pass 1 verifies
     * EVERY probed counter is > 0; if any is 0 the key is definitely absent, so we
     * return false and mutate NOTHING (a decrement here would corrupt other keys).
     * Pass 2 decrements each counter that is in 1..14; a counter at 15 is SATURATED
     * and is NEVER decremented (decisions/0008), and a 0 cannot occur (pass 1 proved
     * it). Zero allocation; the probe body is branch-identical to add so the perf gate
     * does not drift (the planner's flagged risk). Returns true on a real delete.
     */
    remove(key) {
        const m = this._m;
        let a, b;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            b = (fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0) | 1) >>> 0;
        } else {
            a = this._hashKey(key);
            b = (fmix32(a ^ this._seed2) | 1) >>> 0;
        }
        const cnts = this._cnts;
        const k = this._k;
        // Pass 1: verify presence. A single zero counter means definitely-absent ->
        // fail closed WITHOUT mutating (decisions/0009): decrementing a partial match
        // would drop a shared counter and cause a false negative for another key.
        for (let i = 0; i < k; i++) {
            const pos = ((a + Math.imul(i, b)) >>> 0) % m;
            if (((cnts[pos >>> 1] >>> ((pos & 1) << 2)) & 0x0f) === 0) return false;
        }
        // Pass 2: decrement each counter in 1..MAX_COUNT-1; leave MAX_COUNT saturated
        // (decisions/0008).
        for (let i = 0; i < k; i++) {
            const pos = ((a + Math.imul(i, b)) >>> 0) % m;
            const bi = pos >>> 1;
            const sh = (pos & 1) << 2;
            const byte = cnts[bi];
            const nib = (byte >>> sh) & 0x0f;
            if (nib >= 1 && nib <= MAX_COUNT - 1) cnts[bi] = (byte & ~(0x0f << sh)) | ((nib - 1) << sh);
        }
        // Floor the counter at 0: under the documented unsound-remove misuse (removing
        // a false-positive key that was never added, decisions/0009) size would else
        // drift negative. remove is already gated (not the measured hot loop), so this
        // guard is free of the perf concern. size stays an approximation under misuse.
        if (this._count > 0) this._count--;
        return true;
    }

    /**
     * Hash an arbitrary key to a 32-bit base (decisions/0001). A string hashes over
     * its code units (alloc-free); any other type is `String()`-encoded first (the
     * honest amortized caveat). Never called on the keys:'int' path.
     */
    _hashKey(key) {
        if (typeof key === "string") return hashStr(key, this._seed);
        return hashStr(String(key), this._seed);
    }

    // --- cold inspection ------------------------------------------------------

    /**
     * The false-positive probability (decisions/0004). Configured target while empty,
     * else the fill-derived closed-form ESTIMATE `(1 - e^(-k*n/m))^k` -- a formula,
     * NOT a measurement of your keys. Cold, O(1).
     */
    fpp() {
        if (this._count === 0) return this._fpp;
        const exponent = -(this._k * this._count) / this._m;
        return Math.pow(1 - Math.exp(exponent), this._k);
    }

    /** Reset to empty. Allocates NOTHING: zeroes the existing counter store in place,
     *  so the ArrayBuffer identity is preserved. */
    clear() {
        this._cnts.fill(0);
        this._count = 0;
    }

    // --- opt-in stats (decisions/0004) ----------------------------------------

    /** The live per-instance counter holder BY REFERENCE. Requires `{ stats: true }`;
     *  throws fail-closed otherwise (null is not zero). */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE. Requires `{ stats: true }`; else fail closed. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        this._stats.adds = 0;
        this._stats.queries = 0;
        this._stats.hits = 0;
        this._stats.misses = 0;
    }

    // --- snapshot / restore (decisions/0011) ----------------------------------

    /**
     * Serialize to a plain, structurally-cloneable snapshot (decisions/0011). COLD --
     * never a hot path -- and MAY allocate. The Uint8Array counter store IS the serial
     * form, emitted as a plain Array so it round-trips through structuredClone AND
     * JSON. `w: 4` records the counter width; `cnts` is the packed nibble store. The
     * fail-closed tag lets `restore()` reject any mismatch or corruption.
     */
    dump() {
        const keys = this._int ? "int" : null;
        const cnts = Array.from(this._cnts);
        return {
            f: SNAP_TAG,
            mem: "CountingBloom",
            w: COUNTER_WIDTH,
            m: this._m,
            k: this._k,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: keys,
            count: this._count,
            cnts: cnts,
            chk: snapChecksum("CountingBloom", keys, this._seed, this._count,
                [this._m, this._k, this._cap, this._fpp, COUNTER_WIDTH], cnts),
        };
    }

    /**
     * Reconstruct a FRESH CountingBloom from a snapshot (decisions/0011). Fail closed
     * on ANY tag / member / width / capacity / fpp / seed / keys / counter-count
     * mismatch AND on a corrupt store (REJECT, never truncate -- null is not zero).
     * EVERY element must be an exact byte 0..255 (so every packed nibble is 0..15)
     * BEFORE any instance is mutated: a `>>> 0` coercion would silently turn a garbled
     * value into a wrong counter and cause a false negative. `opts` re-derives
     * runtime-only options (stats); everything structural comes FROM the snapshot.
     */
    static restore(snap, opts) {
        if (snap === null || typeof snap !== "object") {
            throw new TypeError("[lite-filter] restore(snap): snapshot must be an object");
        }
        if (snap.f !== SNAP_TAG) {
            throw new Error(
                "[lite-filter] restore(): bad format tag " + String(snap.f) +
                " (expected " + SNAP_TAG + ")");
        }
        if (snap.mem !== "CountingBloom") {
            throw new Error(
                "[lite-filter] restore(): member mismatch " + String(snap.mem) +
                " (this is CountingBloom.restore)");
        }
        if (snap.w !== COUNTER_WIDTH) {
            throw new Error(
                "[lite-filter] restore(): counter-width mismatch " + String(snap.w) +
                " (expected " + COUNTER_WIDTH + ")");
        }
        if (!Number.isInteger(snap.seed) || snap.seed < 0 || snap.seed > 0xffffffff) {
            throw new Error(
                "[lite-filter] restore(): corrupt seed " + String(snap.seed) +
                " (must be a 32-bit unsigned integer)");
        }
        if (snap.keys !== "int" && snap.keys !== null) {
            throw new Error(
                "[lite-filter] restore(): corrupt keys mode " + String(snap.keys) +
                " (must be 'int' or null)");
        }
        const keys = snap.keys === "int" ? "int" : undefined;
        const inst = new CountingBloom(snap.cap, {
            fpp: snap.fpp,
            seed: snap.seed,
            keys: keys,
            stats: opts && opts.stats,
        });
        if (snap.m !== inst._m) {
            throw new Error(
                "[lite-filter] restore(): counter-count mismatch (snapshot m=" + String(snap.m) +
                ", derived m=" + inst._m + ")");
        }
        if (snap.k !== inst._k) {
            throw new Error(
                "[lite-filter] restore(): hash-count mismatch (snapshot k=" + String(snap.k) +
                ", derived k=" + inst._k + ")");
        }
        const cnts = snap.cnts;
        if (!Array.isArray(cnts) || cnts.length !== inst._cnts.length) {
            throw new Error(
                "[lite-filter] restore(): corrupt counter store (expected " + inst._cnts.length +
                " bytes, got " + (Array.isArray(cnts) ? cnts.length : String(cnts)) + ")");
        }
        if (!Number.isInteger(snap.count) || snap.count < 0) {
            throw new Error(
                "[lite-filter] restore(): corrupt count " + String(snap.count));
        }
        // Validate EVERY byte BEFORE mutating (REJECT never truncate; null is not
        // zero). Each element must be an exact byte 0..255 -- which makes each of its
        // two packed nibbles 0..15 by construction. A non-byte would be a corrupt or
        // foreign store and is rejected loudly rather than coerced to garbage.
        for (let i = 0; i < cnts.length; i++) {
            const v = cnts[i];
            if (!Number.isInteger(v) || v < 0 || v > 0xff) {
                throw new Error(
                    "[lite-filter] restore(): corrupt counter-store byte at index " + i +
                    " (" + String(v) + "); each element must be an integer 0..255");
            }
        }
        // Integrity gate (decisions/0021): reject a flipped keys-mode / seed / store byte.
        verifySnapChecksum(snap, "CountingBloom",
            [snap.m, snap.k, snap.cap, snap.fpp, snap.w], cnts);
        for (let i = 0; i < cnts.length; i++) inst._cnts[i] = cnts[i];
        inst._count = snap.count;
        return inst;
    }
}

/* -------------------------------------------------------------------------- *
 * BlockedBloom -- the cache-local member (decisions/0012, 0013). A Bloom whose bit
 * array is partitioned into fixed 512-bit BLOCKS: every key is routed to exactly ONE
 * block (chosen from the first base hash), and all k bits live inside that block. A
 * query therefore touches ONE 64-byte cache line instead of k scattered words -- the
 * throughput win. The honest price (decisions/0013): partitioning loses cross-block
 * independence, so the MEASURED false-positive rate runs OVER the plain-Bloom formula
 * for the same bits/item. fpp() reports the plain closed-form as an explicit FLOOR;
 * the bench prints Bloom vs BlockedBloom side by side (query ns down, FPR up). Add-only
 * like Bloom -- remove() throws (decisions/0003).
 * -------------------------------------------------------------------------- */

export class BlockedBloom {
    /**
     * @param {number} capacity  Items the filter is sized for. Integer >= 1.
     * @param {{ fpp?: number, seed?: number, keys?: 'int', stats?: boolean }} [options]
     */
    constructor(capacity, options) {
        // Cold sizing door: reuse Bloom's (n, fpp) derivation (decisions/0002) verbatim,
        // so a BlockedBloom and a Bloom sized for the same target share m and k.
        const fpp = (options && options.fpp !== undefined) ? options.fpp : DEFAULT_FPP;
        const dims = sizeFor(capacity, fpp);

        this._cap = capacity;      // items sized for (the configured capacity)
        this._fpp = fpp;           // the CONFIGURED target fpp (decisions/0004)
        this._m = dims.m;          // bit count (across all blocks)
        // k is CLAMPED to <= BLOCK_BITS: only 512 distinct positions exist inside a
        // block, so a larger k cannot set more bits (decisions/0012). Fail-safe clamp.
        this._k = dims.k > BLOCK_BITS ? BLOCK_BITS : dims.k;

        this._int = validateKeys(options && options.keys);
        this._seed = validateSeed(options && options.seed);
        this._seed2 = fmix32(this._seed ^ 0x9e3779b9);

        // Block count: ceil(m / 512). m >= 1 (sizeFor guarantees), so _nb >= 1 always;
        // assert it fail-closed regardless (null is not zero -- a 0-block filter is
        // never valid). The store is _nb * 16 words; reject a word count that would
        // overflow a safe typed-array length BEFORE the allocation throws opaquely.
        const nb = Math.ceil(this._m / BLOCK_BITS);
        if (!(nb >= 1)) {
            throw new RangeError(
                "[lite-filter] BlockedBloom requires >= 1 block, derived nb=" + String(nb));
        }
        const words = nb * BLOCK_WORDS;
        if (!Number.isFinite(words) || words > 0xffffffff) {
            throw new RangeError(
                "[lite-filter] requested filter is too large (nb=" + String(nb) +
                " blocks); lower the capacity or raise the fpp");
        }
        this._nb = nb;

        // The ONE preallocated bit store: _nb blocks x 16 words each, sized once and
        // reused forever. clear() zeroes it in place -- same ArrayBuffer identity.
        this._words = new Uint32Array(words);

        // Presence counter (decisions/0003): the number of add() calls (not distinct).
        this._count = 0;

        // Opt-in stats (decisions/0004): null when off so the hot path writes NOTHING.
        this._stats = validateStats(options && options.stats);
    }

    get size() { return this._count; }
    get count() { return this._count; }
    get capacity() { return this._cap; }

    // --- hot path (zero allocation; strict on keys:'int') ---------------------

    /**
     * Record a key. Routes the key to ONE 512-bit block (from the first base hash) and
     * sets k bits INSIDE it via an odd-stride walk (decisions/0012), so a whole add
     * touches one cache line. Zero allocation on the int + string paths. Add-only --
     * there is no remove (decisions/0003).
     */
    add(key) {
        let a, b;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            b = (fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0) | 1) >>> 0;
        } else {
            a = this._hashKey(key);
            b = (fmix32(a ^ this._seed2) | 1) >>> 0;
        }
        const words = this._words;
        const k = this._k;
        const base = (a % this._nb) << 4;          // first word of the chosen block
        const p0 = b & 511;                        // start position within the block
        const st = ((b >>> 9) | 1) & 511;          // ODD stride -> distinct positions
        for (let i = 0; i < k; i++) {
            const pos = (p0 + Math.imul(i, st)) & 511;
            words[base + (pos >>> 5)] |= (1 << (pos & 31));
        }
        this._count++;
        if (this._stats !== null) this._stats.adds++;
    }

    /**
     * The query. Returns true only if ALL k block-local bits are set. One-sided: NO
     * false negatives (an added key always reads true), only false POSITIVES -- whose
     * MEASURED rate runs OVER the plain-Bloom formula (decisions/0013). Zero allocation
     * on the int + string paths; returns false on the first unset bit (no alloc).
     */
    mightContain(key) {
        let a, b;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            b = (fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0) | 1) >>> 0;
        } else {
            a = this._hashKey(key);
            b = (fmix32(a ^ this._seed2) | 1) >>> 0;
        }
        const words = this._words;
        const k = this._k;
        const base = (a % this._nb) << 4;
        const p0 = b & 511;
        const st = ((b >>> 9) | 1) & 511;
        let hit = true;
        for (let i = 0; i < k; i++) {
            const pos = (p0 + Math.imul(i, st)) & 511;
            if ((words[base + (pos >>> 5)] & (1 << (pos & 31))) === 0) { hit = false; break; }
        }
        if (this._stats !== null) {
            this._stats.queries++;
            if (hit) this._stats.hits++; else this._stats.misses++;
        }
        return hit;
    }

    /** The SOLE alias of `mightContain` (decisions/0003), same one-sided semantics. */
    has(key) { return this.mightContain(key); }

    /**
     * Hash an arbitrary key to a 32-bit base (decisions/0001). A string hashes over its
     * code units (alloc-free); any other type is `String()`-encoded first (the honest
     * amortized caveat). Never called on the keys:'int' path.
     */
    _hashKey(key) {
        if (typeof key === "string") return hashStr(key, this._seed);
        return hashStr(String(key), this._seed);
    }

    // --- add-only door (decisions/0003) ---------------------------------------

    /** BlockedBloom is add-only. Fail closed rather than silently no-op or corrupt. */
    remove() {
        throw new Error(BB_REMOVE_MSG);
    }

    // --- cold inspection ------------------------------------------------------

    /**
     * The false-positive probability FLOOR (decisions/0004, 0013). For an EMPTY filter
     * this is the CONFIGURED target; once keys are added it is the PLAIN-Bloom
     * closed-form estimate `(1 - e^(-k*n/m))^k`. It is a LOWER BOUND, not a prediction:
     * blocking loses cross-block independence, so the MEASURED FPR runs OVER this value
     * (decisions/0013). Cold, O(1). MEASURE with the bench (`npm run bench`).
     */
    fpp() {
        if (this._count === 0) return this._fpp;
        const exponent = -(this._k * this._count) / this._m;
        return Math.pow(1 - Math.exp(exponent), this._k);
    }

    /** Reset to empty. Allocates NOTHING: zeroes the existing bit store in place, so the
     *  ArrayBuffer identity is preserved. */
    clear() {
        this._words.fill(0);
        this._count = 0;
    }

    // --- opt-in stats (decisions/0004) ----------------------------------------

    /** The live per-instance counter holder BY REFERENCE. Requires `{ stats: true }`;
     *  throws fail-closed otherwise (null is not zero). */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE. Requires `{ stats: true }`; else fail closed. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        this._stats.adds = 0;
        this._stats.queries = 0;
        this._stats.hits = 0;
        this._stats.misses = 0;
    }

    // --- snapshot / restore (decisions/0005, 0012) ----------------------------

    /**
     * Serialize to a plain, structurally-cloneable snapshot. COLD -- never a hot path --
     * and MAY allocate. The Uint32Array block store IS the serial form, emitted as a
     * plain Array so it round-trips through structuredClone AND JSON. `bb: 512` records
     * the block geometry (decisions/0012) and `nb` the block count, so a future block
     * size change is a clean, detectable break. The fail-closed tag lets `restore()`
     * reject any mismatch or corruption (REJECT, never truncate).
     */
    dump() {
        const keys = this._int ? "int" : null;
        const bits = Array.from(this._words);
        return {
            f: SNAP_TAG,
            mem: "BlockedBloom",
            bb: BLOCK_BITS,
            nb: this._nb,
            m: this._m,
            k: this._k,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: keys,
            count: this._count,
            bits: bits,
            chk: snapChecksum("BlockedBloom", keys, this._seed, this._count,
                [this._m, this._k, this._cap, this._fpp, BLOCK_BITS, this._nb], bits),
        };
    }

    /**
     * Reconstruct a FRESH BlockedBloom from a snapshot (decisions/0005, 0012). Fail
     * closed on ANY tag / member / block-size / capacity / fpp / seed / keys / bit-count
     * / block-count mismatch AND on a corrupt or wrong-length store (REJECT, never
     * truncate -- null is not zero). EVERY word must be an exact 32-bit unsigned integer
     * BEFORE any instance is mutated: a `>>> 0` coercion would silently drop set bits
     * and cause a false negative on a previously-added key. `opts` re-derives
     * runtime-only options (stats); everything structural comes FROM the snapshot.
     */
    static restore(snap, opts) {
        if (snap === null || typeof snap !== "object") {
            throw new TypeError("[lite-filter] restore(snap): snapshot must be an object");
        }
        if (snap.f !== SNAP_TAG) {
            throw new Error(
                "[lite-filter] restore(): bad format tag " + String(snap.f) +
                " (expected " + SNAP_TAG + ")");
        }
        if (snap.mem !== "BlockedBloom") {
            throw new Error(
                "[lite-filter] restore(): member mismatch " + String(snap.mem) +
                " (this is BlockedBloom.restore)");
        }
        if (snap.bb !== BLOCK_BITS) {
            throw new Error(
                "[lite-filter] restore(): block-size mismatch " + String(snap.bb) +
                " (expected " + BLOCK_BITS + ")");
        }
        if (!Number.isInteger(snap.seed) || snap.seed < 0 || snap.seed > 0xffffffff) {
            throw new Error(
                "[lite-filter] restore(): corrupt seed " + String(snap.seed) +
                " (must be a 32-bit unsigned integer)");
        }
        if (snap.keys !== "int" && snap.keys !== null) {
            throw new Error(
                "[lite-filter] restore(): corrupt keys mode " + String(snap.keys) +
                " (must be 'int' or null)");
        }
        const keys = snap.keys === "int" ? "int" : undefined;
        const inst = new BlockedBloom(snap.cap, {
            fpp: snap.fpp,
            seed: snap.seed,
            keys: keys,
            stats: opts && opts.stats,
        });
        if (snap.m !== inst._m) {
            throw new Error(
                "[lite-filter] restore(): bit-count mismatch (snapshot m=" + String(snap.m) +
                ", derived m=" + inst._m + ")");
        }
        if (snap.k !== inst._k) {
            throw new Error(
                "[lite-filter] restore(): hash-count mismatch (snapshot k=" + String(snap.k) +
                ", derived k=" + inst._k + ")");
        }
        if (snap.nb !== inst._nb) {
            throw new Error(
                "[lite-filter] restore(): block-count mismatch (snapshot nb=" + String(snap.nb) +
                ", derived nb=" + inst._nb + ")");
        }
        const bits = snap.bits;
        if (!Array.isArray(bits) || bits.length !== inst._words.length) {
            throw new Error(
                "[lite-filter] restore(): corrupt bit store (expected " + inst._words.length +
                " words, got " + (Array.isArray(bits) ? bits.length : String(bits)) + ")");
        }
        if (!Number.isInteger(snap.count) || snap.count < 0) {
            throw new Error(
                "[lite-filter] restore(): corrupt count " + String(snap.count));
        }
        // Validate EVERY word BEFORE mutating (REJECT never truncate; null is not zero).
        for (let i = 0; i < bits.length; i++) {
            const w = bits[i];
            if (!Number.isInteger(w) || w < 0 || w > 0xffffffff) {
                throw new Error(
                    "[lite-filter] restore(): corrupt bit-store word at index " + i +
                    " (" + String(w) + "); each word must be a 32-bit unsigned integer");
            }
        }
        // Integrity gate (decisions/0021): reject a flipped keys-mode / seed / store word.
        verifySnapChecksum(snap, "BlockedBloom",
            [snap.m, snap.k, snap.cap, snap.fpp, snap.bb, snap.nb], bits);
        for (let i = 0; i < bits.length; i++) inst._words[i] = bits[i];
        inst._count = snap.count;
        return inst;
    }
}

/* -------------------------------------------------------------------------- *
 * Cuckoo -- the space-lean deletable member (decisions/0014, 0015). A partial-key
 * cuckoo hash table of b=4-slot buckets, each slot holding a small NONZERO fingerprint
 * (0 = empty). A key lives in ONE of two candidate buckets:
 *     i1 = hash(key) & (nb-1)
 *     fp = nonzero fingerprint(key)
 *     i2 = (i1 XOR hash(fp)) & (nb-1)     -- an INVOLUTION: i1 = (i2 XOR hash(fp)) & mask
 * so an evicted fingerprint recovers its alternate bucket from the fingerprint alone --
 * no key needed. add scans i1 then i2 for an empty slot; a full pair KICKS a random
 * victim to its alternate bucket up to 500 times via a SINGLE scalar victim register
 * (no scratch array, zero allocation). It DELETES (remove -> boolean). Two honest
 * fail-closed rulings: 500 exhausted kicks THROW (at capacity, never a silent drop --
 * decisions/0014), and deleting a NEVER-INSERTED key whose fingerprint collides removes
 * a DIFFERENT real key's fingerprint -> a false negative for that key (decisions/0015).
 * The FPR is width-quantized to ~2b/2^f, typically BELOW the configured target because f
 * is byte-aligned UP (the family's measure-vs-configured honesty hook).
 * -------------------------------------------------------------------------- */

export class Cuckoo {
    /**
     * @param {number} capacity  Items the filter is sized for. Integer >= 1.
     * @param {{ fpp?: number, seed?: number, keys?: 'int', stats?: boolean }} [options]
     */
    constructor(capacity, options) {
        // Cold sizing door: fail closed on every impossible request (decisions/0014).
        const fpp = (options && options.fpp !== undefined) ? options.fpp : DEFAULT_FPP;
        const dims = cuckooSizeFor(capacity, fpp);

        this._cap = capacity;              // items sized for (the configured capacity)
        this._fpp = fpp;                   // the CONFIGURED target fpp (decisions/0004)
        this._f = dims.f;                  // fingerprint width in bits (derived, 1..16)
        this._b = CUCKOO_B;                // bucket size (4, pinned)
        this._nb = dims.nb;                // bucket count (power of two)
        this._mask = dims.nb - 1;          // bucket-index mask (nb is a power of two)
        this._fpMask = (1 << dims.f) - 1;  // fingerprint value mask ((1<<f)-1)

        this._int = validateKeys(options && options.keys);
        this._seed = validateSeed(options && options.seed);
        this._seed2 = fmix32(this._seed ^ 0x9e3779b9);

        // The ONE preallocated fingerprint store: nb*b slots, 8-bit or 16-bit per the
        // derived width. Slot value 0 is the empty sentinel (decisions/0014). Sized once
        // and reused forever; clear() zeroes it in place -- same ArrayBuffer identity.
        this._store = dims.bits <= 8
            ? new Uint8Array(dims.nb * CUCKOO_B)
            : new Uint16Array(dims.nb * CUCKOO_B);

        // Presence counter (decisions/0003): net add() minus successful remove(). It
        // equals the number of NONZERO slots exactly (each add stores one fingerprint,
        // each remove clears one), so validateCuckoo can cross-check it.
        this._count = 0;

        // Kick PRNG state (deterministic from the seed): a zero-alloc xorshift32 advanced
        // in place on the eviction path. Never touches the direct-insert hot path.
        this._rng = ((this._seed ^ 0x2545f491) >>> 0) || 1;

        // Preallocated eviction-chain trail (decisions/0014): the absolute slot index each
        // of the up-to-500 kicks touched. Sized ONCE, reused forever, written only while
        // kicking (zero allocation). It lets an OVERLOADED add UNWIND the chain back to the
        // exact pre-add state before it throws, so a failed add mutates NOTHING -- no
        // existing fingerprint is dropped (the no-false-negative guarantee holds even on
        // overflow). Never touched by the direct-insert path.
        this._kickPath = new Uint32Array(CUCKOO_KICKS);

        // Opt-in stats (decisions/0004): null when off so the hot path writes NOTHING.
        this._stats = validateStats(options && options.stats);
    }

    get size() { return this._count; }
    get count() { return this._count; }
    get capacity() { return this._cap; }

    // --- hot path (zero allocation; strict on keys:'int') ---------------------

    /**
     * Record a key (decisions/0014). Computes a nonzero fingerprint and two candidate
     * buckets, scans i1 then i2 for an empty slot, and on a full pair KICKS a random
     * victim to its alternate bucket up to 500 times using a SINGLE scalar victim register
     * (no scratch array -- zero allocation on the int + string paths). If 500 kicks are
     * exhausted the table is at capacity and this THROWS (fail closed -- never a silent
     * drop, decisions/0014). Uniform surface: `add(key) -> void`, headroom via size/capacity.
     */
    add(key) {
        let a, fpsrc;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            fpsrc = fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0);
        } else {
            a = this._hashKey(key);
            fpsrc = fmix32(a ^ this._seed2);
        }
        const store = this._store;
        const mask = this._mask;
        // Nonzero fingerprint: 0 is the empty-slot sentinel, so map 0 -> 1 (decisions/0014).
        let fp = fpsrc & this._fpMask;
        if (fp === 0) fp = 1;
        const hf = fmix32(Math.imul(fp, 0x5bd1e995));   // hash(fp) for the alt-bucket XOR
        const i1 = a & mask;
        const i2 = (i1 ^ hf) & mask;

        // Direct insert: scan i1 then i2 for an empty (0) slot. b=4 unrolled, no loop var.
        let base = i1 << 2;
        if (store[base] === 0) { store[base] = fp; this._count++; if (this._stats !== null) this._stats.adds++; return; }
        if (store[base + 1] === 0) { store[base + 1] = fp; this._count++; if (this._stats !== null) this._stats.adds++; return; }
        if (store[base + 2] === 0) { store[base + 2] = fp; this._count++; if (this._stats !== null) this._stats.adds++; return; }
        if (store[base + 3] === 0) { store[base + 3] = fp; this._count++; if (this._stats !== null) this._stats.adds++; return; }
        base = i2 << 2;
        if (store[base] === 0) { store[base] = fp; this._count++; if (this._stats !== null) this._stats.adds++; return; }
        if (store[base + 1] === 0) { store[base + 1] = fp; this._count++; if (this._stats !== null) this._stats.adds++; return; }
        if (store[base + 2] === 0) { store[base + 2] = fp; this._count++; if (this._stats !== null) this._stats.adds++; return; }
        if (store[base + 3] === 0) { store[base + 3] = fp; this._count++; if (this._stats !== null) this._stats.adds++; return; }

        // Both buckets full: KICK. A single scalar `victim` register carries the displaced
        // fingerprint; xorshift32 picks the eviction bucket and slot. Each kick is a SWAP of
        // store[idx] with `victim`; the touched slot indices are trailed in _kickPath so the
        // chain can be unwound if the insert fails. No scratch ALLOCATION (kickPath is
        // preallocated); the direct-insert path above never records.
        const kickPath = this._kickPath;
        let r = this._rng;
        let i = (r & 1) ? i2 : i1;
        let victim = fp;
        for (let n = 0; n < CUCKOO_KICKS; n++) {
            r ^= r << 13; r >>>= 0;
            r ^= r >> 17;
            r ^= r << 5; r >>>= 0;
            const idx = (i << 2) + (r & 3);   // absolute slot to evict from bucket i
            kickPath[n] = idx;                // trail it for a possible unwind
            const e = store[idx];             // evict a random occupant
            store[idx] = victim;              // place the carried fingerprint (bucket i is its candidate)
            victim = e;                       // now carry the evicted one
            // The evicted fingerprint was in bucket i, so its alternate is (i XOR hash(fp)).
            const vf = fmix32(Math.imul(victim, 0x5bd1e995));
            i = (i ^ vf) & mask;
            const b2 = i << 2;
            if (store[b2] === 0) { store[b2] = victim; this._rng = r; this._count++; if (this._stats !== null) this._stats.adds++; return; }
            if (store[b2 + 1] === 0) { store[b2 + 1] = victim; this._rng = r; this._count++; if (this._stats !== null) this._stats.adds++; return; }
            if (store[b2 + 2] === 0) { store[b2 + 2] = victim; this._rng = r; this._count++; if (this._stats !== null) this._stats.adds++; return; }
            if (store[b2 + 3] === 0) { store[b2 + 3] = victim; this._rng = r; this._count++; if (this._stats !== null) this._stats.adds++; return; }
        }
        // 500 kicks exhausted: the table is at capacity. UNWIND the eviction chain to the
        // EXACT pre-add state, then fail closed (decisions/0014). Each kick was a swap of
        // store[idx] with the carried victim; replaying the swaps in REVERSE order restores
        // every touched slot (correct even when a slot was touched more than once) and
        // leaves `victim` == the new fp -- unplaced and dropped. A thrown add therefore
        // mutates NOTHING: no existing fingerprint is lost, so no previously-added key can
        // read false. This is the aborting cold path (extra work here is free of the hot
        // path). count is untouched (only successful placement increments it).
        for (let n = CUCKOO_KICKS - 1; n >= 0; n--) {
            const idx = kickPath[n];
            const tmp = store[idx];
            store[idx] = victim;
            victim = tmp;
        }
        this._rng = r;
        throw new Error(CUCKOO_FULL_MSG);
    }

    /**
     * The query (decisions/0014). Returns true iff the key's fingerprint is present in
     * either candidate bucket. One-sided: NO false negatives for a key that is currently
     * present (decisions/0015 states the delete-misuse exception), only false POSITIVES
     * bounded by ~2b/2^f. Zero allocation on the int + string paths; b=4 slots unrolled.
     */
    mightContain(key) {
        let a, fpsrc;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            fpsrc = fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0);
        } else {
            a = this._hashKey(key);
            fpsrc = fmix32(a ^ this._seed2);
        }
        const store = this._store;
        const mask = this._mask;
        let fp = fpsrc & this._fpMask;
        if (fp === 0) fp = 1;
        const hf = fmix32(Math.imul(fp, 0x5bd1e995));
        const i1 = a & mask;
        const i2 = (i1 ^ hf) & mask;
        const b1 = i1 << 2;
        const b2 = i2 << 2;
        const hit =
            store[b1] === fp || store[b1 + 1] === fp || store[b1 + 2] === fp || store[b1 + 3] === fp ||
            store[b2] === fp || store[b2 + 1] === fp || store[b2 + 2] === fp || store[b2 + 3] === fp;
        if (this._stats !== null) {
            this._stats.queries++;
            if (hit) this._stats.hits++; else this._stats.misses++;
        }
        return hit;
    }

    /** The SOLE alias of `mightContain` (decisions/0003), same one-sided semantics. */
    has(key) { return this.mightContain(key); }

    /**
     * Delete a key (decisions/0014, 0015). Scans both candidate buckets for the key's
     * fingerprint and clears the FIRST matching slot (0 = empty), returning true; returns
     * false and mutates NOTHING if no slot matches. Zero allocation; b=4 slots unrolled.
     *
     * CAVEAT (decisions/0015): deleting a NEVER-INSERTED key whose fingerprint COLLIDES
     * with a real key (same fingerprint, sharing a candidate bucket) will clear the REAL
     * key's slot -> a later FALSE NEGATIVE for that other key. Only remove keys you
     * actually inserted. This is sharper than a Bloom-family remove: a Cuckoo delete does
     * not just decrement a shared counter, it removes a concrete fingerprint instance.
     */
    remove(key) {
        let a, fpsrc;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            a = fmix32((key ^ this._seed) | 0);
            fpsrc = fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0);
        } else {
            a = this._hashKey(key);
            fpsrc = fmix32(a ^ this._seed2);
        }
        const store = this._store;
        const mask = this._mask;
        let fp = fpsrc & this._fpMask;
        if (fp === 0) fp = 1;
        const hf = fmix32(Math.imul(fp, 0x5bd1e995));
        const i1 = a & mask;
        const i2 = (i1 ^ hf) & mask;
        let base = i1 << 2;
        if (store[base] === fp) { store[base] = 0; this._count--; return true; }
        if (store[base + 1] === fp) { store[base + 1] = 0; this._count--; return true; }
        if (store[base + 2] === fp) { store[base + 2] = 0; this._count--; return true; }
        if (store[base + 3] === fp) { store[base + 3] = 0; this._count--; return true; }
        base = i2 << 2;
        if (store[base] === fp) { store[base] = 0; this._count--; return true; }
        if (store[base + 1] === fp) { store[base + 1] = 0; this._count--; return true; }
        if (store[base + 2] === fp) { store[base + 2] = 0; this._count--; return true; }
        if (store[base + 3] === fp) { store[base + 3] = 0; this._count--; return true; }
        return false;
    }

    /**
     * Hash an arbitrary key to a 32-bit base (decisions/0001). A string hashes over its
     * code units (alloc-free); any other type is `String()`-encoded first (the honest
     * amortized caveat). Never called on the keys:'int' path.
     */
    _hashKey(key) {
        if (typeof key === "string") return hashStr(key, this._seed);
        return hashStr(String(key), this._seed);
    }

    // --- cold inspection ------------------------------------------------------

    /**
     * The false-positive probability (decisions/0004, 0014). Configured target while
     * EMPTY; once keys are added it is the width-quantized closed form `2b/2^f` using the
     * ACTUAL stored fingerprint width `f`. Because `f` is byte-aligned UP at construction,
     * this is typically FAR BELOW the configured target -- the family's measure-vs-configured
     * honesty hook, surfaced not hidden. It is a formula, NOT a measurement -- MEASURE with
     * the bench (`npm run bench`). Cold, O(1). Unlike Bloom's it does not vary with fill:
     * a Cuckoo's FPR is bounded by the fingerprint width, not the load factor.
     */
    fpp() {
        if (this._count === 0) return this._fpp;
        return (2 * this._b) / Math.pow(2, this._f);
    }

    /** Reset to empty. Allocates NOTHING: zeroes the existing fingerprint store in place,
     *  so the ArrayBuffer identity is preserved. */
    clear() {
        this._store.fill(0);
        this._count = 0;
    }

    // --- opt-in stats (decisions/0004) ----------------------------------------

    /** The live per-instance counter holder BY REFERENCE. Requires `{ stats: true }`;
     *  throws fail-closed otherwise (null is not zero). */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE. Requires `{ stats: true }`; else fail closed. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        this._stats.adds = 0;
        this._stats.queries = 0;
        this._stats.hits = 0;
        this._stats.misses = 0;
    }

    // --- snapshot / restore (decisions/0005, 0014) ----------------------------

    /**
     * Serialize to a plain, structurally-cloneable snapshot (decisions/0014). COLD -- never
     * a hot path -- and MAY allocate. The fingerprint store IS the serial form, emitted as
     * a plain Array (`fp`) so it round-trips through structuredClone AND JSON. `fw` records
     * the fingerprint width in bits, `b` the bucket size (4), `nb` the bucket count. The
     * fail-closed tag lets `restore()` reject any mismatch or corruption (REJECT, never
     * truncate). NOTE: `f` is the shared FORMAT tag; the fingerprint WIDTH is `fw` (a
     * separate field) to avoid colliding with it.
     */
    dump() {
        const keys = this._int ? "int" : null;
        const fp = Array.from(this._store);
        return {
            f: SNAP_TAG,
            mem: "Cuckoo",
            fw: this._f,
            b: this._b,
            nb: this._nb,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: keys,
            count: this._count,
            fp: fp,
            chk: snapChecksum("Cuckoo", keys, this._seed, this._count,
                [this._f, this._b, this._nb, this._cap, this._fpp], fp),
        };
    }

    /**
     * Reconstruct a FRESH Cuckoo from a snapshot (decisions/0014). Fail closed on ANY tag /
     * member / fingerprint-width / bucket-size / bucket-count / capacity / fpp / seed / keys
     * mismatch AND on a corrupt or wrong-length store OR an out-of-range / impossible
     * fingerprint (REJECT, never truncate -- null is not zero). EVERY slot must be an
     * integer in `0..fpMask` (0 = empty; a nonzero value must fit the width) BEFORE any
     * instance is mutated: a coercion would silently turn a garbled value into a wrong
     * fingerprint and cause a false negative. `opts` re-derives runtime-only options (stats);
     * everything structural comes FROM the snapshot.
     */
    static restore(snap, opts) {
        if (snap === null || typeof snap !== "object") {
            throw new TypeError("[lite-filter] restore(snap): snapshot must be an object");
        }
        if (snap.f !== SNAP_TAG) {
            throw new Error(
                "[lite-filter] restore(): bad format tag " + String(snap.f) +
                " (expected " + SNAP_TAG + ")");
        }
        if (snap.mem !== "Cuckoo") {
            throw new Error(
                "[lite-filter] restore(): member mismatch " + String(snap.mem) +
                " (this is Cuckoo.restore)");
        }
        if (snap.b !== CUCKOO_B) {
            throw new Error(
                "[lite-filter] restore(): bucket-size mismatch " + String(snap.b) +
                " (expected " + CUCKOO_B + ")");
        }
        if (!Number.isInteger(snap.seed) || snap.seed < 0 || snap.seed > 0xffffffff) {
            throw new Error(
                "[lite-filter] restore(): corrupt seed " + String(snap.seed) +
                " (must be a 32-bit unsigned integer)");
        }
        if (snap.keys !== "int" && snap.keys !== null) {
            throw new Error(
                "[lite-filter] restore(): corrupt keys mode " + String(snap.keys) +
                " (must be 'int' or null)");
        }
        const keys = snap.keys === "int" ? "int" : undefined;
        const inst = new Cuckoo(snap.cap, {
            fpp: snap.fpp,
            seed: snap.seed,
            keys: keys,
            stats: opts && opts.stats,
        });
        if (snap.fw !== inst._f) {
            throw new Error(
                "[lite-filter] restore(): fingerprint-width mismatch (snapshot fw=" + String(snap.fw) +
                ", derived f=" + inst._f + ")");
        }
        if (snap.nb !== inst._nb) {
            throw new Error(
                "[lite-filter] restore(): bucket-count mismatch (snapshot nb=" + String(snap.nb) +
                ", derived nb=" + inst._nb + ")");
        }
        const fp = snap.fp;
        if (!Array.isArray(fp) || fp.length !== inst._store.length) {
            throw new Error(
                "[lite-filter] restore(): corrupt fingerprint store (expected " + inst._store.length +
                " slots, got " + (Array.isArray(fp) ? fp.length : String(fp)) + ")");
        }
        if (!Number.isInteger(snap.count) || snap.count < 0) {
            throw new Error(
                "[lite-filter] restore(): corrupt count " + String(snap.count));
        }
        // Validate EVERY slot BEFORE mutating (REJECT never truncate; null is not zero).
        // A slot is 0 (empty) or a nonzero fingerprint in 1..fpMask; anything else is a
        // corrupt or foreign store and is rejected rather than coerced to garbage.
        const fpMask = inst._fpMask;
        for (let i = 0; i < fp.length; i++) {
            const v = fp[i];
            if (!Number.isInteger(v) || v < 0 || v > fpMask) {
                throw new Error(
                    "[lite-filter] restore(): corrupt fingerprint at slot " + i + " (" + String(v) +
                    "); each slot must be an integer in 0.." + fpMask);
            }
        }
        // Integrity gate (decisions/0021): reject a flipped keys-mode / seed / store slot.
        verifySnapChecksum(snap, "Cuckoo",
            [snap.fw, snap.b, snap.nb, snap.cap, snap.fpp], fp);
        for (let i = 0; i < fp.length; i++) inst._store[i] = fp[i];
        inst._count = snap.count;
        return inst;
    }
}

/* -------------------------------------------------------------------------- *
 * Quotient -- the mergeable + resizable deletable member (decisions/0016, 0017;
 * Bender, Farach-Colton, Johnson, Kraner, Kuszmaul, Medjedovic, Montes, Shetty, Spillane
 * & Zadok, "Don't Thrash: How to Cache Your Hash on Flash", VLDB 2012). ONE open-
 * addressed linear slot array. A key's 32-bit base hash splits into a QUOTIENT (the home
 * slot index, high bits) and a REMAINDER (stored, low r bits). Same-home keys form a RUN;
 * adjacent runs form a CLUSTER under linear probing. Three METADATA bits per slot encode
 * the structure (packed in the low 3 bits of each word, remainder in the high bits):
 *
 *   is_occupied     (bit0) -- this canonical slot is home to some stored key
 *   is_continuation (bit1) -- the remainder here continues a run (is not its head)
 *   is_shifted      (bit2) -- the remainder here is not in its canonical slot
 *
 * A slot is EMPTY iff all three metadata bits are 0 (remainder 0 is a LEGAL remainder --
 * emptiness is carried by metadata, never by the remainder value, decisions/0016).
 *
 * Query: !is_occupied(home) -> absent; else walk left to the cluster start, count occupied
 * homes to locate this home's run, then scan the run's (sorted) remainders for r. Insert:
 * locate the run, insert r in sorted order, shift the cluster tail FORWARD (linear -- an
 * insert that would run off the end, or push occupancy past the 0.90 ceiling, THROWS a
 * byte-identical no-op, decisions/0016 -- parallel to Cuckoo's fail-closed overload).
 * Delete: rebuild the affected cluster from its surviving (home, remainder) pairs, so the
 * shift-back metadata repair is PROVABLY correct (it reuses the insert path, not a bespoke
 * bit fixup -- the planner's flagged risk, retired by construction). remove -> boolean.
 *
 * merge() + resize() ship now as COLD paths (they may allocate; add/mightContain/remove
 * stay zero-alloc). The fingerprint bit budget `p = q0 + r` is FIXED for the filter's
 * lifetime: resize reconstructs each element's full hash as `(quotient << r) | remainder`
 * and re-splits it under the new slot count WITHOUT the original keys (decisions/0016), and
 * merge rejects any filter whose (seed, r, p, keys) differ. Both preserve membership (0
 * false negatives) and exact size. fpp() reports the configured target while empty, else
 * the honest remainder-quantized characteristic rate `load * 2^-r` (typically UNDER target
 * because r rounds up -- the family's measure-vs-configured honesty hook). Delete carries
 * the same never-added caveat as Cuckoo / CountingBloom (decisions/0017).
 * -------------------------------------------------------------------------- */

export class Quotient {
    /**
     * @param {number} capacity  Items the filter is sized for. Integer >= 1.
     * @param {{ fpp?: number, seed?: number, keys?: 'int', stats?: boolean }} [options]
     */
    constructor(capacity, options) {
        // Cold sizing door: fail closed on every impossible request (decisions/0016).
        const fpp = (options && options.fpp !== undefined) ? options.fpp : DEFAULT_FPP;
        const dims = quotientSizeFor(capacity, fpp);

        this._cap = capacity;                    // items sized for (the configured capacity)
        this._fpp = fpp;                         // the CONFIGURED target fpp (decisions/0004)
        this._r = dims.r;                         // remainder width in bits
        this._q = dims.q;                         // quotient width in bits (slot addressing)
        this._nslots = dims.nslots;               // slot count = 2^q
        this._qMask = dims.nslots - 1;            // quotient/slot-index mask (nslots is pow2)
        this._rMask = (1 << dims.r) - 1;          // remainder value mask ((1<<r)-1)
        // The fingerprint bit budget p = q + r is FIXED for the filter's lifetime so a
        // resize/merge can re-derive the split from stored (quotient, remainder) pairs
        // WITHOUT the original keys (decisions/0016). p <= 32 (guarded in quotientSizeFor).
        this._p = dims.q + dims.r;
        this._pMask = this._p >= 32 ? 0xffffffff : (((1 << this._p) >>> 0) - 1) >>> 0;
        // The load ceiling in absolute slots: an insert past this throws (decisions/0016).
        this._maxLoad = Math.floor(QF_LOAD * dims.nslots);
        // The quotient range is [0, nslots), but the PHYSICAL array carries GUARD spillover
        // slots beyond it so a cluster whose home is near the top can shift right without
        // running off the end at ordinary load (a linear -- not circular -- filter,
        // decisions/0016). A shift that still exhausts the guard THROWS fail-closed. The
        // guard is deterministic from nslots so restore() can re-derive it.
        this._bytes = dims.bits;
        this._guard = _qfGuard(dims.nslots);
        this._len = dims.nslots + this._guard;

        this._int = validateKeys(options && options.keys);
        this._seed = validateSeed(options && options.seed);

        // The ONE preallocated slot store: _len words (nslots + guard), 8-bit (r <= 5) or
        // 16-bit (r 6..13) per the byte-aligned word width. Sized once, reused forever;
        // clear() zeroes it in place -- same ArrayBuffer identity.
        this._store = dims.bits <= 8
            ? new Uint8Array(this._len)
            : new Uint16Array(this._len);

        // Preallocated delete-rebuild scratch (decisions/0016): the (home, remainder) pairs
        // of a cluster being repaired. Sized to _len (the worst-case cluster length),
        // written only inside remove() -- so remove() stays zero-alloc. Never touched by
        // add/mightContain. A Uint32Array carries both fields safely (q + r <= 32).
        this._scratchHome = new Uint32Array(this._len);
        this._scratchRem = new Uint32Array(this._len);

        // Presence counter (decisions/0016): the number of stored slots WITH MULTIPLICITY.
        // A Quotient does NOT dedup (like Cuckoo) -- every add stores one more (quotient,
        // remainder) slot and increments count (even for an already-present fingerprint),
        // and a successful remove decrements. 0017's delete-safety argument DEPENDS on this:
        // two present keys sharing a fingerprint hold two slots, so removing one leaves the
        // other resident. count equals the number of slots with any metadata bit set, so
        // validateQuotient can cross-check it.
        this._count = 0;

        // Opt-in stats (decisions/0004): null when off so the hot path writes NOTHING.
        this._stats = validateStats(options && options.stats);
    }

    get size() { return this._count; }
    get count() { return this._count; }
    get capacity() { return this._cap; }

    // --- hot path (zero allocation; strict on keys:'int') ---------------------

    /** The 32-bit base hash for a key (decisions/0016). keys:'int' mixes the int directly;
     *  otherwise a string hashes over its code units (any other type is String()-encoded).
     *  Masked to the fixed p = q + r bit budget by the caller. */
    _hash(key) {
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            return fmix32((key ^ this._seed) | 0);
        }
        if (typeof key === "string") return hashStr(key, this._seed);
        return hashStr(String(key), this._seed);
    }

    /**
     * Find the first slot of the run that belongs to home quotient `q`. Read-only, zero
     * allocation. Treats `q` as a home even if its is_occupied bit is not yet set (so the
     * insert path can locate where a brand-new run goes), by stopping the home walk at `q`.
     * Precondition for a QUERY: is_occupied(q) is set (checked by the caller).
     */
    _runStart(q) {
        const store = this._store;
        // Walk left to the cluster start (the first non-shifted slot at or left of q).
        let b = q;
        while (b > 0 && (store[b] & QF_SHIFTED)) b--;
        // Count runs from the cluster start up to q's home, advancing a run pointer `s`.
        let s = b;
        while (b !== q) {
            // Advance s to the next run start (past the current run's continuations).
            s++;
            while (s < this._len && (store[s] & QF_CONTINUATION)) s++;
            // Advance b to the next occupied home (stop at q even if q is not yet occupied).
            b++;
            while (b < q && !(store[b] & QF_OCCUPIED)) b++;
        }
        return s;
    }

    /**
     * Record a key (decisions/0016). Splits the base hash into (quotient, remainder),
     * locates the run, inserts the remainder in sorted order, and shifts the cluster tail
     * FORWARD. Zero allocation on the int + string paths. Fail-closed: an insert that would
     * push occupancy past the 0.90 ceiling, or whose shift would run off the end of the
     * slot array, THROWS a [lite-filter] Error and is a BYTE-IDENTICAL no-op (all mutations
     * happen AFTER the last throw point). A Quotient stores MULTIPLICITY (it does NOT dedup,
     * like Cuckoo), so re-adding the same key consumes another slot. add(key) -> void.
     */
    add(key) {
        const hv = this._hash(key) & this._pMask;
        const r = hv & this._rMask;
        const q = (hv >>> this._r) & this._qMask;
        // Load-ceiling door: fail closed BEFORE any mutation (byte-identical no-op).
        if (this._count >= this._maxLoad) throw new Error(QF_FULL_MSG);
        const placed = this._place(q, r);
        if (placed) {
            this._count++;
            if (this._stats !== null) this._stats.adds++;
        }
    }

    /**
     * Place a (quotient, remainder) pair; always writes one slot (multiplicity is stored,
     * decisions/0016) and returns true. THROWS a byte-identical [lite-filter] no-op when the
     * linear shift would run off the end (no write happens before the throw check). The
     * shared insert core for add() and the cold merge/resize/delete-rebuild paths.
     */
    _place(q, r) {
        const store = this._store;
        const len = this._len;
        const canonical = store[q];

        // Fast path: the home slot is empty -> place the run head in its canonical slot.
        if ((canonical & QF_META) === 0) {
            store[q] = (r << QF_RSHIFT) | QF_OCCUPIED;
            return true;
        }

        const wasOccupied = (canonical & QF_OCCUPIED) !== 0;
        const runStart = this._runStart(q);
        let s = runStart;
        let newIsCont = false;
        let makeOldHeadCont = false;

        if (wasOccupied) {
            // Scan the (sorted) run for the insert position. Duplicate remainders are
            // ALLOWED (a Quotient stores multiplicity like Cuckoo, NOT deduped -- so a
            // delete of one instance preserves any other key sharing its fingerprint; this
            // is what makes churn 0-false-negative + size==present, decisions/0016).
            s = runStart;
            while (true) {
                const rem = store[s] >>> QF_RSHIFT;
                if (rem >= r) break;                 // insert at s (keeps the run sorted)
                s++;
                if (s >= len) break;
                if (!(store[s] & QF_CONTINUATION)) break; // end of this run
            }
            if (s === runStart) {
                // The new remainder is the smallest -> it becomes the run head; the old
                // head becomes a continuation (metadata repair, done in the write phase).
                newIsCont = false;
                makeOldHeadCont = true;
            } else {
                newIsCont = true;                    // inserted mid-run or appended
            }
        } else {
            // A brand-new run for q; s = _runStart(q) is where it belongs.
            newIsCont = false;
        }

        const newIsShifted = (s !== q);

        // Find the first empty slot at or after s. If none exists in [s, nslots), the shift
        // would run off the end -> fail closed BEFORE any write (byte-identical no-op).
        let e = s;
        while (e < len && (store[e] & QF_META) !== 0) e++;
        if (e >= len) throw new Error(QF_FULL_MSG);

        // ---- write phase (past the last throw point) ----
        store[q] |= QF_OCCUPIED;                      // occupied bit is stationary at q
        if (makeOldHeadCont) store[runStart] |= QF_CONTINUATION;
        // Shift [s, e) forward into [s+1, e], preserving each slot's OWN occupied bit and
        // marking every moved element shifted (it left its canonical slot).
        for (let i = e; i > s; i--) {
            const occ = store[i] & QF_OCCUPIED;      // slot i keeps its own home bit
            const data = store[i - 1] & ~QF_OCCUPIED; // remainder + continuation + shifted
            store[i] = (occ | data | QF_SHIFTED) & 0xffffffff;
        }
        // Place the new entry at s (keeping s's own occupied bit).
        const occS = store[s] & QF_OCCUPIED;
        store[s] = occS | (r << QF_RSHIFT) |
            (newIsCont ? QF_CONTINUATION : 0) | (newIsShifted ? QF_SHIFTED : 0);
        return true;
    }

    /**
     * The query (decisions/0016). Returns true iff the key's (quotient, remainder) is
     * stored. One-sided: NO false negatives for a currently-present key (decisions/0017
     * states the delete-misuse exception), only false POSITIVES bounded by the
     * remainder-quantized rate. Zero allocation on the int + string paths.
     */
    mightContain(key) {
        const hv = this._hash(key) & this._pMask;
        const r = hv & this._rMask;
        const q = (hv >>> this._r) & this._qMask;
        const store = this._store;
        let hit = false;
        if ((store[q] & QF_OCCUPIED) !== 0) {
            let s = this._runStart(q);
            const len = this._len;
            while (true) {
                const rem = store[s] >>> QF_RSHIFT;
                if (rem === r) { hit = true; break; }
                if (rem > r) break;                  // sorted run -> not present
                s++;
                if (s >= len) break;
                if (!(store[s] & QF_CONTINUATION)) break; // end of run
            }
        }
        if (this._stats !== null) {
            this._stats.queries++;
            if (hit) this._stats.hits++; else this._stats.misses++;
        }
        return hit;
    }

    /** The SOLE alias of `mightContain` (decisions/0003), same one-sided semantics. */
    has(key) { return this.mightContain(key); }

    /**
     * Delete a key (decisions/0016, 0017). Locates the run, and on a match REBUILDS the
     * affected cluster from its surviving (home, remainder) pairs -- so the shift-back
     * metadata repair is PROVABLY correct (it reuses the verified insert path rather than a
     * bespoke bit fixup). Returns true on a real delete; returns false and mutates NOTHING
     * on a run-scan miss. Zero allocation (the cluster scratch is preallocated).
     *
     * CAVEAT (decisions/0017): deleting a NEVER-INSERTED key whose (quotient, remainder)
     * COLLIDES with a real key removes THAT key's fingerprint -> a later FALSE NEGATIVE for
     * the other key. Only remove keys you actually inserted.
     */
    remove(key) {
        const hv = this._hash(key) & this._pMask;
        const r = hv & this._rMask;
        const q = (hv >>> this._r) & this._qMask;
        const store = this._store;
        const len = this._len;
        if ((store[q] & QF_OCCUPIED) === 0) return false;
        // Locate the slot holding remainder r within q's run.
        let s = this._runStart(q);
        let found = false;
        while (true) {
            const rem = store[s] >>> QF_RSHIFT;
            if (rem === r) { found = true; break; }
            if (rem > r) break;                      // sorted run -> not present
            s++;
            if (s >= len) break;
            if (!(store[s] & QF_CONTINUATION)) break; // end of run
        }
        if (!found) return false;

        // Rebuild the whole cluster containing slot s from its survivors. The cluster is the
        // maximal run of non-empty slots [cs, ce) around s (clusters are separated by empty
        // slots), so clearing [cs, ce) touches no other cluster.
        let cs = s;
        while (cs > 0 && (store[cs - 1] & QF_META) !== 0) cs--;
        let ce = s;
        while (ce < len && (store[ce] & QF_META) !== 0) ce++;

        // Collect surviving (home, remainder) pairs. Within a cluster the homes are the
        // occupied slots in order, and the k-th run (by continuation grouping) belongs to
        // the k-th home. cs is always a home (an unshifted run start).
        const homes = this._scratchHome;
        const rems = this._scratchRem;
        let n = 0;
        let homeIdx = cs;
        for (let p = cs; p < ce; p++) {
            if (p !== cs && !(store[p] & QF_CONTINUATION)) {
                // Next run: advance the home pointer to the next occupied slot.
                homeIdx++;
                while (homeIdx < ce && !(store[homeIdx] & QF_OCCUPIED)) homeIdx++;
            }
            if (p === s) continue;                    // skip the deleted element
            homes[n] = homeIdx;
            rems[n] = store[p] >>> QF_RSHIFT;
            n++;
        }

        // Clear the cluster (metadata + remainders) and rebuild from the survivors. Every
        // survivor's home is within [cs, ce), so re-inserting them cannot run off the end
        // (one element was removed -> there is room) and touches no neighboring cluster.
        for (let p = cs; p < ce; p++) store[p] = 0;
        for (let i = 0; i < n; i++) this._place(homes[i], rems[i]);

        this._count--;
        return true;
    }

    // --- cold inspection ------------------------------------------------------

    /**
     * The false-positive probability (decisions/0004, 0016). Configured target while EMPTY;
     * once non-empty it is the honest remainder-quantized characteristic rate
     * `load * 2^-r`, where `load = size / nslots` is the fraction of occupied slots and
     * `2^-r` is the per-comparison remainder-collision probability. Because r is byte-
     * aligned UP (r = ceil(log2(1/fpp))) and load <= 0.90, this typically runs BELOW the
     * configured target -- the family's measure-vs-configured honesty hook. It is a
     * formula, NOT a measurement -- MEASURE with the bench (`npm run bench`). Cold, O(1).
     */
    fpp() {
        if (this._count === 0) return this._fpp;
        return (this._count / this._nslots) * Math.pow(2, -this._r);
    }

    /** Reset to empty. Allocates NOTHING: zeroes the existing slot store in place, so the
     *  ArrayBuffer identity is preserved (decisions/0016). */
    clear() {
        this._store.fill(0);
        this._count = 0;
    }

    // --- opt-in stats (decisions/0004) ----------------------------------------

    /** The live per-instance counter holder BY REFERENCE. Requires `{ stats: true }`;
     *  throws fail-closed otherwise (null is not zero). */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE. Requires `{ stats: true }`; else fail closed. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        this._stats.adds = 0;
        this._stats.queries = 0;
        this._stats.hits = 0;
        this._stats.misses = 0;
    }

    // --- cold rebuild helpers (merge / resize; MAY allocate) ------------------

    /**
     * Iterate every stored (quotient, remainder) pair, calling `fn(quotient, remainder)`.
     * COLD -- used by merge/resize/dump, never on a hot path. Reconstructs the full
     * fingerprint identity WITHOUT the original keys (decisions/0016): the pair itself IS
     * the stored identity. Walks each cluster assigning runs to occupied homes in order.
     */
    _forEachPair(fn) {
        const store = this._store;
        const len = this._len;
        let p = 0;
        while (p < len) {
            if ((store[p] & QF_META) === 0) { p++; continue; }
            // Cluster [cs, ce).
            const cs = p;
            let ce = p;
            while (ce < len && (store[ce] & QF_META) !== 0) ce++;
            let homeIdx = cs;
            for (let i = cs; i < ce; i++) {
                if (i !== cs && !(store[i] & QF_CONTINUATION)) {
                    homeIdx++;
                    while (homeIdx < ce && !(store[homeIdx] & QF_OCCUPIED)) homeIdx++;
                }
                fn(homeIdx, store[i] >>> QF_RSHIFT);
            }
            p = ce;
        }
    }

    /**
     * Rebuild into a fresh slot array sized for `newCapacity`, preserving membership (0
     * false negatives) and exact size WITHOUT the original keys (decisions/0016). COLD --
     * MAY allocate. Each stored element's full fingerprint is `(quotient << r) | remainder`
     * (a p-bit value; p is FIXED for the filter's lifetime), re-split under the new slot
     * count. Mutates this filter in place and returns it (uniform with clear()).
     *
     * NOTE (decisions/0016): because p = q0 + r is fixed at construction (the discarded
     * high hash bits cannot be recovered without the keys), a quotient never carries more
     * than q0 bits of entropy; resizing LARGER than the original quotient width adds empty
     * headroom (lower load, fewer collisions on the SHARED bits) but not new quotient
     * entropy, and resizing SMALLER truncates the quotient consistently for both stored
     * elements and fresh queries (so membership still holds, at a higher FPR).
     */
    resize(newCapacity) {
        // Size for at least the requested capacity AND the current occupancy under the load
        // ceiling; fail closed if the request cannot even hold what is already stored.
        const need = Math.max(newCapacity, this._count);
        const dims = quotientSizeFor(need, this._fpp);
        const r = this._r;
        // Snapshot the stored pairs before repointing the store (walk the OLD store).
        const pairs = [];
        this._forEachPair((qq, rr) => pairs.push(((qq << r) | rr) >>> 0));
        // Repoint to the fresh geometry (p, r are INVARIANT across resize; decisions/0016).
        const guard = _qfGuard(dims.nslots);
        const len = dims.nslots + guard;
        this._store = dims.bits <= 8 ? new Uint8Array(len) : new Uint16Array(len);
        this._scratchHome = new Uint32Array(len);
        this._scratchRem = new Uint32Array(len);
        this._q = dims.q;
        this._nslots = dims.nslots;
        this._qMask = dims.nslots - 1;
        this._guard = guard;
        this._len = len;
        this._maxLoad = Math.floor(QF_LOAD * dims.nslots);
        this._cap = newCapacity;
        this._count = 0;
        // Re-insert every fingerprint, re-split under the new quotient width.
        for (let i = 0; i < pairs.length; i++) {
            const fp = pairs[i] & this._pMask;
            const rr = fp & this._rMask;
            const qq = (fp >>> r) & this._qMask;
            if (this._place(qq, rr)) this._count++;
        }
        return this;
    }

    /**
     * Merge another Quotient into this one, preserving membership (0 false negatives) and
     * producing exact-size union semantics (decisions/0016). COLD -- MAY allocate. REJECTS
     * fail-closed unless `other` is an identically-configured Quotient (same seed, fpp-
     * derived remainder width r, fixed hash bit budget p, and keys mode) -- otherwise the
     * quotient/remainder split would misalign. Grows this filter as needed to hold both,
     * then re-inserts every pair from `other` (this filter's own pairs are already resident).
     * Mutates this filter in place and returns it.
     */
    merge(other) {
        if (!(other instanceof Quotient) ||
            other._seed !== this._seed || other._r !== this._r ||
            other._p !== this._p || other._int !== this._int) {
            throw new Error(QF_MERGE_MSG);
        }
        const r = this._r;
        // Collect other's pairs first (independent of this filter's mutation).
        const pairs = [];
        other._forEachPair((qq, rr) => pairs.push(((qq << r) | rr) >>> 0));
        // Grow if the combined occupancy would exceed the load ceiling. A Quotient stores
        // MULTIPLICITY (no dedup), so the merged size is EXACTLY this._count + other._count.
        const combined = this._count + other._count;
        if (combined > this._maxLoad) {
            this.resize(Math.ceil(combined / QF_LOAD));
        }
        for (let i = 0; i < pairs.length; i++) {
            const fp = pairs[i] & this._pMask;
            const rr = fp & this._rMask;
            const qq = (fp >>> r) & this._qMask;
            if (this._place(qq, rr)) {
                this._count++;
                // Defensive: a clustered layout can still fill before the flat combined
                // estimate expects it (linear probing), so grow again if the ceiling nears.
                if (this._count >= this._maxLoad && i + 1 < pairs.length) {
                    this.resize(Math.ceil((this._count + (pairs.length - i - 1)) / QF_LOAD));
                }
            }
        }
        return this;
    }

    // --- snapshot / restore (decisions/0005, 0016) ----------------------------

    /**
     * Serialize to a plain, structurally-cloneable snapshot (decisions/0016). COLD -- never
     * a hot path -- and MAY allocate. The slot store IS the serial form, emitted as a plain
     * Array (`store`) so it round-trips through structuredClone AND JSON. `r`, `q`, `p`,
     * `nslots`, and `load` record the geometry (q/nslots track a resize; p is the fixed bit
     * budget). NOTE: `f` is the shared FORMAT tag; `fpp` is the configured target.
     */
    dump() {
        const keys = this._int ? "int" : null;
        const store = Array.from(this._store);
        return {
            f: SNAP_TAG,
            mem: "Quotient",
            r: this._r,
            q: this._q,
            p: this._p,
            nslots: this._nslots,
            load: QF_LOAD,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: keys,
            count: this._count,
            store: store,
            chk: snapChecksum("Quotient", keys, this._seed, this._count,
                [this._r, this._q, this._p, this._nslots, QF_LOAD, this._cap, this._fpp], store),
        };
    }

    /**
     * Reconstruct a FRESH Quotient from a snapshot (decisions/0016). Fail closed on ANY tag
     * / member / remainder-width / geometry / capacity / fpp / seed / keys mismatch AND on a
     * corrupt or wrong-length store OR any malformed slot word (REJECT, never truncate --
     * null is not zero). EVERY slot word is validated BEFORE any instance is mutated: the
     * remainder must fit r bits, an EMPTY slot (metadata 0) must have a 0 remainder (a
     * stored remainder with no metadata is unreachable garbage). `opts` re-derives
     * runtime-only options (stats); everything structural comes FROM the snapshot.
     */
    static restore(snap, opts) {
        if (snap === null || typeof snap !== "object") {
            throw new TypeError("[lite-filter] restore(snap): snapshot must be an object");
        }
        if (snap.f !== SNAP_TAG) {
            throw new Error(
                "[lite-filter] restore(): bad format tag " + String(snap.f) +
                " (expected " + SNAP_TAG + ")");
        }
        if (snap.mem !== "Quotient") {
            throw new Error(
                "[lite-filter] restore(): member mismatch " + String(snap.mem) +
                " (this is Quotient.restore)");
        }
        if (!Number.isInteger(snap.seed) || snap.seed < 0 || snap.seed > 0xffffffff) {
            throw new Error(
                "[lite-filter] restore(): corrupt seed " + String(snap.seed) +
                " (must be a 32-bit unsigned integer)");
        }
        if (snap.keys !== "int" && snap.keys !== null) {
            throw new Error(
                "[lite-filter] restore(): corrupt keys mode " + String(snap.keys) +
                " (must be 'int' or null)");
        }
        const keys = snap.keys === "int" ? "int" : undefined;
        const inst = new Quotient(snap.cap, {
            fpp: snap.fpp,
            seed: snap.seed,
            keys: keys,
            stats: opts && opts.stats,
        });
        // r depends only on fpp -> a mismatch means a corrupt or foreign snapshot.
        if (snap.r !== inst._r) {
            throw new Error(
                "[lite-filter] restore(): remainder-width mismatch (snapshot r=" + String(snap.r) +
                ", derived r=" + inst._r + ")");
        }
        // Geometry: q/nslots may differ from the capacity-derived defaults (a resized
        // filter), but must be internally consistent (nslots === 2^q) and within budget.
        if (!Number.isInteger(snap.q) || snap.q < 1 || snap.q > 32) {
            throw new Error("[lite-filter] restore(): corrupt quotient width q=" + String(snap.q));
        }
        if (snap.nslots !== Math.pow(2, snap.q)) {
            throw new Error(
                "[lite-filter] restore(): slot-count mismatch (snapshot nslots=" +
                String(snap.nslots) + " != 2^q=" + Math.pow(2, snap.q) + ")");
        }
        // The fixed bit budget p MUST leave at least ONE quotient bit (decisions/0016):
        // p = q0 + r with q0 >= 1, so p > r ALWAYS. p === r (quotient width 0) would make
        // quotient = (hv >>> r) & qMask ALWAYS 0, collapsing every key onto slot 0 and causing
        // wholesale FALSE NEGATIVES -- REJECT it. (p is INVARIANT across resize -- it stays
        // q0 + r while the current q/nslots change -- so it CANNOT be cross-checked against the
        // snapshot's current q; it only needs to be a valid budget in (r, 32].) Never truncate.
        if (!Number.isInteger(snap.p) || snap.p <= snap.r || snap.p > 32) {
            throw new Error(
                "[lite-filter] restore(): corrupt bit budget p=" + String(snap.p) +
                " (must be an integer in " + (snap.r + 1) + "..32; quotient width 0 is impossible)");
        }
        // The physical store carries GUARD spillover slots beyond nslots (decisions/0016),
        // deterministic from nslots -- so re-derive the expected physical length here.
        const guard = _qfGuard(snap.nslots);
        const physLen = snap.nslots + guard;
        const store = snap.store;
        if (!Array.isArray(store) || store.length !== physLen) {
            throw new Error(
                "[lite-filter] restore(): corrupt slot store (expected " + physLen +
                " slots, got " + (Array.isArray(store) ? store.length : String(store)) + ")");
        }
        if (!Number.isInteger(snap.count) || snap.count < 0) {
            throw new Error("[lite-filter] restore(): corrupt count " + String(snap.count));
        }
        // Validate EVERY slot word BEFORE mutating (REJECT never truncate; null is not zero).
        const rMask = (1 << snap.r) - 1;
        const maxWord = ((rMask << QF_RSHIFT) | QF_META) >>> 0;
        let occ = 0;
        for (let i = 0; i < store.length; i++) {
            const w = store[i];
            if (!Number.isInteger(w) || w < 0 || w > maxWord) {
                throw new Error(
                    "[lite-filter] restore(): corrupt slot word at index " + i + " (" + String(w) +
                    "); each word must be an integer in 0.." + maxWord);
            }
            const meta = w & QF_META;
            if (meta === 0) {
                // An empty slot (metadata 0) must carry a 0 remainder -- a remainder with no
                // metadata is unreachable garbage (emptiness is carried by metadata).
                if ((w >>> QF_RSHIFT) !== 0) {
                    throw new Error(
                        "[lite-filter] restore(): slot " + i + " has a remainder but no metadata " +
                        "(" + String(w) + "); an empty slot must be exactly 0");
                }
            } else {
                occ++;
            }
        }
        // The count of slots with any metadata bit set must equal the recorded size.
        if (occ !== snap.count) {
            throw new Error(
                "[lite-filter] restore(): metadata-set slot count " + occ + " != count " +
                String(snap.count));
        }
        // Deep structural check (REJECT never truncate): per-word ranges alone let a lone
        // continuation or a shifted/continuation cluster start slip through -- reject a
        // corrupt-but-in-range snapshot BEFORE any instance is mutated (decisions/0016).
        const structErr = _qfStructureError(store, store.length);
        if (structErr !== null) {
            throw new Error("[lite-filter] restore(): corrupt slot structure -- " + structErr);
        }
        // Integrity gate (decisions/0021): reject a flipped keys-mode / seed / store word --
        // recompute over the snapshot's own fields, BEFORE any instance geometry is mutated.
        verifySnapChecksum(snap, "Quotient",
            [snap.r, snap.q, snap.p, snap.nslots, snap.load, snap.cap, snap.fpp], store);
        // Repoint geometry to the snapshot's (a resized filter differs from the cap default).
        if (inst._len !== physLen) {
            inst._store = inst._store.BYTES_PER_ELEMENT === 1
                ? new Uint8Array(physLen) : new Uint16Array(physLen);
            inst._scratchHome = new Uint32Array(physLen);
            inst._scratchRem = new Uint32Array(physLen);
            inst._q = snap.q;
            inst._nslots = snap.nslots;
            inst._qMask = snap.nslots - 1;
            inst._guard = guard;
            inst._len = physLen;
            inst._maxLoad = Math.floor(QF_LOAD * snap.nslots);
        }
        inst._p = snap.p;
        inst._pMask = snap.p >= 32 ? 0xffffffff : (((1 << snap.p) >>> 0) - 1) >>> 0;
        for (let i = 0; i < store.length; i++) inst._store[i] = store[i];
        inst._count = snap.count;
        return inst;
    }
}

/* -------------------------------------------------------------------------- *
 * XorFilter -- the space-optimal STATIC member (decisions/0018, 0019, 0020; Graf &
 * Lemire, "Xor Filters", ACM JEA 2020). The FIRST immutable member: built ONCE from a
 * KNOWN key set via the static `XorFilter.from(iterable, options)` (or the `.build`
 * alias), then FROZEN. It approaches the ~1.23x information-theoretic space lower bound
 * by peeling a 3-uniform hypergraph -- each key touches 3 fingerprint slots (one per
 * segment), and the slots are assigned so a key's three slots XOR to its fingerprint.
 *
 * QUERY (the hot body, decisions/0018): compute the key's fingerprint and its 3 slot
 * positions, then `fp === (arr[h0] ^ arr[h1] ^ arr[h2])`. Zero allocation, no branch on
 * build state (the instance is always fully built once `from()` returns). One-sided: a
 * key in the set ALWAYS reads true (0 false negatives, guaranteed by the complete-peel
 * assignment); a never-added key reads true only on a fingerprint collision (~2^-fw).
 *
 * NO MUTATION (decisions/0019): a static filter is built once and has no add/remove/
 * clear -- all three throw `[lite-filter]` fail-closed, as does `new XorFilter()` (use
 * the factory). Rebuild with `XorFilter.from(newKeys)` to change membership.
 *
 * WIDTH (decisions/0020): the fingerprint is byte-aligned -- 8 bits when `fpp >= 2^-8`
 * (~0.0039), else 16 bits; `fpp < 2^-16` throws (the 16-bit floor, parallel to Cuckoo /
 * Quotient). The delivered FPR is the width-quantized `2^-fw`, typically UNDER the
 * configured target -- `fpp()` reports it (the measure-vs-configured honesty hook).
 *
 * KEYS ARE A SET (decisions/0018): `from()` DEDUPES its input (contrast Cuckoo / Quotient,
 * which store multiplicity). `size` is the deduped key count.
 * -------------------------------------------------------------------------- */

export class XorFilter {
    /**
     * NOT a public constructor (decisions/0018). A static member is built via the
     * factory; `new XorFilter()` throws `[lite-filter]`. The static `from`/`build`/
     * `restore` factories construct a bare instance internally via the private brand.
     */
    constructor(token) {
        if (token !== XOR_BUILD_TOKEN) {
            throw new Error(XOR_CTOR_MSG);
        }
        // Bare instance: the factory fills every field before returning. Initialized to
        // fail-closed sentinels so a half-built instance can never read as valid.
        this._fp = null;      // the fingerprint array (Uint8Array | Uint16Array), length 3*bl
        this._seed = 0;       // the winning hash seed (32-bit unsigned)
        this._seed2 = 0;      // the derived second seed word
        this._bl = 0;         // per-segment length; the array is 3*bl slots
        this._fw = 0;         // fingerprint width in bits (8 or 16)
        this._fpMask = 0;     // fingerprint value mask ((1<<fw)-1)
        this._int = false;    // keys:'int' backing (strict zero-alloc query)
        this._count = 0;      // the deduped key count (a SET, not multiplicity)
        this._cap = 0;        // capacity == count (built from exactly this set)
        this._fpp = 0;        // the CONFIGURED target fpp (decisions/0004)
        this._stats = null;   // opt-in stats holder (null when off)
    }

    /**
     * Build a frozen XOR filter from a known key set (decisions/0018). DEDUPES the input
     * to a Set (XOR keys are a SET, not multiplicity), sizes the array to `3*(ceil(1.23*
     * n/3)+32)` slots, then PEELS the 3-uniform hypergraph. On a peel failure it RESEEDS
     * deterministically (`seed ^ (attempt * 0x9e3779b1)`) up to 100 times; if every
     * attempt fails (a degenerate key set) it THROWS `[lite-filter]` -- never a partial
     * build (fail closed). Cold; allocates the peeling scaffold. Returns a new XorFilter.
     *
     * @param {Iterable} iterable  the key set (deduped internally)
     * @param {{ fpp?: number, seed?: number, keys?: 'int', stats?: boolean }} [options]
     * @returns {XorFilter}
     */
    static from(iterable, options) {
        if (iterable === null || iterable === undefined || typeof iterable[Symbol.iterator] !== "function") {
            throw new TypeError(
                "[lite-filter] XorFilter.from(iterable): the first argument must be iterable");
        }
        const fpp = (options && options.fpp !== undefined) ? options.fpp : DEFAULT_FPP;
        const fw = _xorSizeError(fpp);                     // width door (decisions/0020)
        const int = validateKeys(options && options.keys); // keys door (decisions/0001)
        const baseSeed = validateSeed(options && options.seed);
        const stats = validateStats(options && options.stats);

        // Dedupe to a Set (decisions/0018). On the int backing every key is validated to
        // the 32-bit signed domain FIRST (fail closed) -- a bad key never enters the set.
        const set = new Set();
        for (const key of iterable) {
            if (int && (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX)) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            set.add(key);
        }
        const n = set.size;
        const bl = _xorGuard(n);                           // empty-set + too-large door
        const keys = Array.from(set);

        // Peel with deterministic reseed (decisions/0018). Only a COMPLETE peel returns a
        // fingerprint array; a short stack returns null and we reseed. 100 exhausted throws.
        let arr = null;
        let seed = baseSeed;
        let seed2 = 0;
        for (let attempt = 0; attempt < XOR_MAX_ATTEMPTS; attempt++) {
            const trySeed = (baseSeed ^ Math.imul(attempt, 0x9e3779b1)) >>> 0;
            const trySeed2 = fmix32(trySeed ^ 0x9e3779b9);
            const built = _xorTryBuild(keys, int, trySeed, trySeed2, n, bl, fw);
            if (built !== null) { arr = built; seed = trySeed; seed2 = trySeed2; break; }
        }
        if (arr === null) {
            throw new Error(XOR_CONSTRUCT_MSG);
        }

        const inst = new XorFilter(XOR_BUILD_TOKEN);
        inst._fp = arr;
        inst._seed = seed;
        inst._seed2 = seed2;
        inst._bl = bl;
        inst._fw = fw;
        inst._fpMask = (1 << fw) - 1;
        inst._int = int;
        inst._count = n;
        inst._cap = n;
        inst._fpp = fpp;
        inst._stats = stats;
        return inst;
    }

    /** The `.build` alias of `from` (decisions/0018): the family's static-build verb, same
     *  contract. Some callers prefer "build" for the peeling connotation. */
    static build(iterable, options) {
        return XorFilter.from(iterable, options);
    }

    get size() { return this._count; }
    get count() { return this._count; }
    get capacity() { return this._cap; }

    // --- hot path (zero allocation; strict on keys:'int') ---------------------

    /**
     * The query (decisions/0018). Computes the key's fingerprint and its 3 slot positions
     * (one per segment), then tests `fp === (arr[h0] ^ arr[h1] ^ arr[h2])`. One-sided: a
     * key in the built set ALWAYS reads true (the complete-peel assignment guarantees it --
     * 0 false negatives); a never-added key reads true only on a fingerprint collision
     * (~2^-fw). Zero allocation on the int + string paths; NO branch on build state (a
     * returned instance is always fully built).
     */
    mightContain(key) {
        const bl = this._bl;
        let h, g;
        if (this._int) {
            if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
                throw new TypeError(INT_KEY_MSG + String(key));
            }
            h = fmix32((key ^ this._seed) | 0);
            g = fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0);
        } else {
            h = this._hashKey(key);
            g = fmix32((h ^ this._seed2) | 0);
        }
        const t = fmix32((h ^ g) | 0);
        const fp = fmix32((h + g) | 0) & this._fpMask;
        const arr = this._fp;
        const h0 = h % bl;
        const h1 = bl + (g % bl);
        const h2 = 2 * bl + (t % bl);
        const hit = fp === (arr[h0] ^ arr[h1] ^ arr[h2]);
        if (this._stats !== null) {
            this._stats.queries++;
            if (hit) this._stats.hits++; else this._stats.misses++;
        }
        return hit;
    }

    /** The SOLE alias of `mightContain` (decisions/0003), same one-sided semantics. */
    has(key) { return this.mightContain(key); }

    /** A static filter has no incremental add (decisions/0019). THROWS `[lite-filter]`
     *  fail-closed -- rebuild with XorFilter.from(newKeys) to change membership. */
    add(key) { throw new Error(XOR_STATIC_MSG); }

    /** A static filter cannot delete (decisions/0019). THROWS `[lite-filter]` fail-closed. */
    remove(key) { throw new Error(XOR_STATIC_MSG); }

    /** A static filter has nothing to clear TO (decisions/0019): its identity IS its key
     *  set. THROWS `[lite-filter]` fail-closed rather than silently emptying a member whose
     *  whole contract is "the set it was built from" -- a cleared XOR filter is undefined. */
    clear() { throw new Error(XOR_STATIC_MSG); }

    /**
     * Hash an arbitrary key to a 32-bit base (decisions/0001). A string hashes over its
     * code units (alloc-free); any other type is `String()`-encoded first (the honest
     * amortized caveat). Never called on the keys:'int' path.
     */
    _hashKey(key) {
        if (typeof key === "string") return hashStr(key, this._seed);
        return hashStr(String(key), this._seed);
    }

    // --- cold inspection ------------------------------------------------------

    /**
     * The false-positive probability (decisions/0004, 0020). The width-quantized `2^-fw`
     * using the ACTUAL stored fingerprint width. Because `fw` is byte-aligned, this is
     * typically BELOW the configured target -- the family's measure-vs-configured honesty
     * hook, surfaced not hidden. It is a formula, NOT a measurement -- MEASURE with the
     * bench (`npm run bench`). Cold, O(1). Does not vary with fill (an XOR filter is
     * always fully built from its set).
     */
    fpp() {
        return Math.pow(2, -this._fw);
    }

    // --- opt-in stats (decisions/0004) ----------------------------------------

    /** The live per-instance counter holder BY REFERENCE. Requires `{ stats: true }`;
     *  throws fail-closed otherwise (null is not zero). */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the counters IN PLACE. Requires `{ stats: true }`; else fail closed. NOTE: a
     *  static filter has no `adds` (build is not add()); adds stays 0. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        this._stats.adds = 0;
        this._stats.queries = 0;
        this._stats.hits = 0;
        this._stats.misses = 0;
    }

    // --- snapshot / restore (decisions/0005, 0018) ----------------------------

    /**
     * Serialize to a plain, structurally-cloneable snapshot (decisions/0018). COLD -- never
     * a hot path -- and MAY allocate. The fingerprint array IS the serial form, emitted as
     * a plain Array (`fp`) so it round-trips through structuredClone AND JSON. `fw` records
     * the fingerprint width, `bl` the per-segment length (the array is 3*bl). The
     * fail-closed tag lets `restore()` reject any mismatch or corruption (REJECT, never
     * truncate). `f` is the shared FORMAT tag; the fingerprint WIDTH is `fw` (a separate
     * field) to avoid colliding with it.
     */
    dump() {
        const keys = this._int ? "int" : null;
        const fp = Array.from(this._fp);
        return {
            f: SNAP_TAG,
            mem: "Xor",
            fw: this._fw,
            bl: this._bl,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: keys,
            count: this._count,
            fp: fp,
            chk: snapChecksum("Xor", keys, this._seed, this._count,
                [this._fw, this._bl, this._cap, this._fpp], fp),
        };
    }

    /**
     * Reconstruct a FRESH XorFilter from a snapshot (decisions/0018). Fail closed on ANY
     * tag / member / seed / keys / fingerprint-width / segment-length / count mismatch AND
     * on a corrupt or wrong-length fingerprint array OR an out-of-range fingerprint word
     * (REJECT, never truncate -- null is not zero). Every consistency tie is re-derived and
     * cross-checked BEFORE any instance is populated: the width from the fpp, the segment
     * length from the count (`bl === ceil(1.23*count/3)+32`), the array length (`=== 3*bl`),
     * and every word (`0 <= word <= fpMask`). A coercion would silently turn a garbled value
     * into a wrong fingerprint and cause a false negative. `opts` re-derives runtime-only
     * options (stats); everything structural comes FROM the snapshot.
     */
    static restore(snap, opts) {
        if (snap === null || typeof snap !== "object") {
            throw new TypeError("[lite-filter] restore(snap): snapshot must be an object");
        }
        if (snap.f !== SNAP_TAG) {
            throw new Error(
                "[lite-filter] restore(): bad format tag " + String(snap.f) +
                " (expected " + SNAP_TAG + ")");
        }
        if (snap.mem !== "Xor") {
            throw new Error(
                "[lite-filter] restore(): member mismatch " + String(snap.mem) +
                " (this is XorFilter.restore)");
        }
        if (!Number.isInteger(snap.seed) || snap.seed < 0 || snap.seed > 0xffffffff) {
            throw new Error(
                "[lite-filter] restore(): corrupt seed " + String(snap.seed) +
                " (must be a 32-bit unsigned integer)");
        }
        if (snap.keys !== "int" && snap.keys !== null) {
            throw new Error(
                "[lite-filter] restore(): corrupt keys mode " + String(snap.keys) +
                " (must be 'int' or null)");
        }
        // The fingerprint width must be exactly the one the fpp re-derives (decisions/0020):
        // a tampered fw is caught here rather than silently trusted.
        const fw = _xorSizeError(snap.fpp);
        if (snap.fw !== fw) {
            throw new Error(
                "[lite-filter] restore(): fingerprint-width mismatch (snapshot fw=" +
                String(snap.fw) + ", derived fw=" + fw + ")");
        }
        if (!Number.isInteger(snap.count) || snap.count < 1) {
            throw new Error(
                "[lite-filter] restore(): corrupt count " + String(snap.count) +
                " (an XOR filter is built over >= 1 key)");
        }
        // The segment length is a deterministic function of the count (decisions/0018): a
        // tampered bl (or count) is caught by re-deriving and comparing.
        const bl = _xorGuard(snap.count);
        if (snap.bl !== bl) {
            throw new Error(
                "[lite-filter] restore(): segment-length mismatch (snapshot bl=" +
                String(snap.bl) + ", derived bl=" + bl + ")");
        }
        const m = XOR_ARITY * bl;
        const fp = snap.fp;
        if (!Array.isArray(fp) || fp.length !== m) {
            throw new Error(
                "[lite-filter] restore(): corrupt fingerprint store (expected " + m +
                " slots, got " + (Array.isArray(fp) ? fp.length : String(fp)) + ")");
        }
        // Validate EVERY word BEFORE mutating (REJECT never truncate; null is not zero). A
        // word is an integer in 0..fpMask; anything else is a corrupt or foreign store and
        // is rejected rather than coerced to garbage (a coercion would be a false negative).
        const fpMask = (1 << fw) - 1;
        for (let i = 0; i < m; i++) {
            const v = fp[i];
            if (!Number.isInteger(v) || v < 0 || v > fpMask) {
                throw new Error(
                    "[lite-filter] restore(): corrupt fingerprint at slot " + i + " (" + String(v) +
                    "); each slot must be an integer in 0.." + fpMask);
            }
        }
        // Integrity gate (decisions/0021): the seed + keys-mode CANNOT be re-derived from
        // the fingerprint array, so a flipped `keys` ("int" <-> null) or `seed` -- the QA
        // fail-open repro -- is caught here. Recompute over the snapshot's own fields and
        // REJECT on a mismatch, BEFORE any instance is built.
        verifySnapChecksum(snap, "Xor", [snap.fw, snap.bl, snap.cap, snap.fpp], fp);
        const inst = new XorFilter(XOR_BUILD_TOKEN);
        inst._fp = fw <= 8 ? new Uint8Array(m) : new Uint16Array(m);
        for (let i = 0; i < m; i++) inst._fp[i] = fp[i];
        inst._seed = snap.seed >>> 0;
        inst._seed2 = fmix32(inst._seed ^ 0x9e3779b9);
        inst._bl = bl;
        inst._fw = fw;
        inst._fpMask = fpMask;
        inst._int = snap.keys === "int";
        inst._count = snap.count;
        inst._cap = snap.count;
        inst._fpp = snap.fpp;
        inst._stats = validateStats(opts && opts.stats);
        return inst;
    }
}

export default Bloom;
