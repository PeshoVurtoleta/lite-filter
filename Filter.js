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
 * Design decisions live in decisions/ (0001 hashing; 0002 sizing; 0003 remove +
 * count; 0004 fpp; 0005 snapshot; 0006 deferred static-build API) and are
 * summarized in ROADMAP.md.
 *
 * @license MIT
 */

export const VERSION = "0.1.0";

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
        const keys = snap.keys === "int" ? "int" : (snap.keys === null ? undefined : snap.keys);
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
        if ((snap.seed >>> 0) !== inst._seed) {
            throw new Error(
                "[lite-filter] restore(): seed mismatch (snapshot seed=" + String(snap.seed) +
                ", derived seed=" + inst._seed + ")");
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
        for (let i = 0; i < bits.length; i++) inst._words[i] = bits[i] >>> 0;
        inst._count = snap.count;
        return inst;
    }
}

export default Bloom;
