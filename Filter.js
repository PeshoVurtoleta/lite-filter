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
 * Design decisions live in decisions/ (0001 hashing; 0002 sizing; 0003 remove +
 * count; 0004 fpp; 0005 snapshot; 0006 deferred static-build API; 0007 counter
 * width; 0008 saturation; 0009 remove caveat; 0010 count deferred; 0011 CBF
 * snapshot; 0012 block size; 0013 FPR locality; 0014 Cuckoo sizing/overload; 0015
 * Cuckoo delete caveat) and are summarized in ROADMAP.md.
 *
 * @license MIT
 */

export const VERSION = "0.4.0";

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

/** The snapshot format tag (decisions/0005). A `dump()` carries it; `restore()`
 *  rejects any other value fail-closed. Versioned so a future layout change is a
 *  clean, detectable break rather than a silent misread. */
const SNAP_TAG = "litefilter/1";

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

/** Default target false-positive probability when the caller omits `fpp`
 *  (decisions/0002): the textbook 1% baseline. Explicit and documented, never a
 *  hidden magic number smuggled onto a hot path. */
const DEFAULT_FPP = 0.01;

/** Default hash seed (decisions/0001). A fixed constant so a filter's behavior is
 *  deterministic across runs; overridable via `{ seed }` for A/B hashing. */
const DEFAULT_SEED = 0x9e3779b1;

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
        return {
            f: SNAP_TAG,
            mem: "Bloom",
            m: this._m,
            k: this._k,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: this._int ? "int" : null,
            count: this._count,
            bits: Array.from(this._words),
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
        return {
            f: SNAP_TAG,
            mem: "CountingBloom",
            w: COUNTER_WIDTH,
            m: this._m,
            k: this._k,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: this._int ? "int" : null,
            count: this._count,
            cnts: Array.from(this._cnts),
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
            keys: this._int ? "int" : null,
            count: this._count,
            bits: Array.from(this._words),
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
        return {
            f: SNAP_TAG,
            mem: "Cuckoo",
            fw: this._f,
            b: this._b,
            nb: this._nb,
            cap: this._cap,
            fpp: this._fpp,
            seed: this._seed,
            keys: this._int ? "int" : null,
            count: this._count,
            fp: Array.from(this._store),
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
        for (let i = 0; i < fp.length; i++) inst._store[i] = fp[i];
        inst._count = snap.count;
        return inst;
    }
}

export default Bloom;
