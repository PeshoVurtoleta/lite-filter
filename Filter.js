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
 * Design decisions live in decisions/ (0001 hashing; 0002 sizing; 0003 remove +
 * count; 0004 fpp; 0005 snapshot; 0006 deferred static-build API; 0007 counter
 * width; 0008 saturation; 0009 remove caveat; 0010 count deferred; 0011 CBF
 * snapshot) and are summarized in ROADMAP.md.
 *
 * @license MIT
 */

export const VERSION = "0.2.0";

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
     *  gate). The presence counter and stats-adds semantics reset too. */
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

export default Bloom;
