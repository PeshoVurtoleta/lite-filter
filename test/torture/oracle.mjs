/**
 * @zakkster/lite-filter -- the Set-differential oracle (test only).
 *
 * A Bloom filter's two falsifiable laws, checked against a real `Set` ground truth
 * so a false positive / false negative is UNAMBIGUOUS (ROADMAP section 9, point 3):
 *
 *   1. NO FALSE NEGATIVES. Every key that was added MUST read `true`, always. A
 *      single `false` on an added key is a hard failure -- the whole one-sided
 *      guarantee is void.
 *   2. BOUNDED FALSE-POSITIVE RATE. Query a large DISJOINT set of never-added keys
 *      (verified disjoint via the Set oracle) and count `mightContain` trues. The
 *      measured FPR must sit within a tolerance of the configured target.
 *
 * Seeded + deterministic: the same seed replays byte-for-byte. Pure -- imports only
 * the member under test -- so it drops into torture, the boundary suite, and the
 * bench alike.
 */

/** Seeded xorshift32 -- returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5;  x >>>= 0;
        return x >>> 0;
    };
}

/**
 * Run the differential oracle for an integer-keyed ADD-ONLY member. Generic over the
 * member: `Bloom` and `BlockedBloom` both pass through unchanged (same add / query
 * surface). The two laws below -- 0 false negatives, bounded FPR -- hold for both; the
 * FPR CEILING differs (BlockedBloom runs OVER the plain-Bloom form, decisions/0013), so
 * the caller applies the member-appropriate limit to `.fpr`, not this function.
 *
 * @param {Function} Ctor  the member constructor (e.g. Bloom, BlockedBloom)
 * @param {{ n:number, fpp:number, probes:number, seed:number }} opts
 * @returns {{ falseNegatives:number, falsePositives:number, fpr:number,
 *             target:number, added:number, probed:number }}
 */
export function differentialInt(Ctor, opts) {
    const n = opts.n;
    const fpp = opts.fpp;
    const probes = opts.probes;
    const rng = makePrng(opts.seed >>> 0);

    const filter = new Ctor(n, { fpp: fpp, keys: "int" });
    const truth = new Set();

    // Fill with n distinct 32-bit keys drawn from the LOW half of the domain, so the
    // disjoint probe set can live entirely in the HIGH half (guaranteed non-members).
    while (truth.size < n) {
        const key = (rng() >>> 1); // [0, 2^31) -- the low half
        if (!truth.has(key)) { truth.add(key); filter.add(key); }
    }

    // Law 1: no false negatives -- every added key must read true.
    let falseNegatives = 0;
    for (const key of truth) {
        if (!filter.mightContain(key)) falseNegatives++;
    }

    // Law 2: bounded FPR -- probe never-added keys and count trues. The probe keys
    // are NEGATIVE (high bit set), disjoint from the [0, 2^31) added domain, so any
    // true is unambiguously a false positive. The oracle Set double-checks disjoint.
    let falsePositives = 0;
    let probed = 0;
    for (let i = 0; i < probes; i++) {
        const key = -1 - (rng() >>> 1); // [-2^31, -1] -- the high half, all non-members
        if (truth.has(key)) continue;   // impossible by construction, but assert it
        probed++;
        if (filter.mightContain(key)) falsePositives++;
    }

    return {
        falseNegatives: falseNegatives,
        falsePositives: falsePositives,
        fpr: probed === 0 ? 0 : falsePositives / probed,
        target: fpp,
        added: truth.size,
        probed: probed,
    };
}

/**
 * Run the DELETE differential oracle for a deletable integer-keyed member (e.g.
 * CountingBloom). A `Set` mirrors add AND remove so a false negative on a key that is
 * CURRENTLY present is unambiguous.
 *
 * Each op picks a key from the low int32 half; if the oracle says it is present the op
 * REMOVES it (and asserts the filter agreed it was present), otherwise it ADDS it.
 * Every key is at multiplicity 1 while present, so no counter saturates and a present
 * key never reads false (decisions/0008, 0009). At the end, EVERY key still present in
 * the oracle must read true -- 0 false negatives is the hard law.
 *
 * `opts.keyspace` (optional) bounds the key domain to `[0, keyspace)`, so removes RECUR
 * and the present set equilibrates near keyspace/2 instead of growing unbounded. A
 * CAPACITY-bounded member (Cuckoo, whose add() throws when full, decisions/0014) needs
 * this so the churn stays under the load target; CountingBloom (no capacity cap) omits it
 * and draws from the full [0, 2^31) half, unchanged.
 *
 * @param {Function} Ctor  the member constructor (e.g. CountingBloom, Cuckoo)
 * @param {{ n:number, fpp:number, ops:number, seed:number, keyspace?:number }} opts
 * @returns {{ falseNegatives:number, present:number, filterSize:number }}
 */
export function differentialChurnInt(Ctor, opts) {
    const n = opts.n;
    const fpp = opts.fpp;
    const ops = opts.ops;
    const keyspace = (opts.keyspace >>> 0) || 0;
    const rng = makePrng(opts.seed >>> 0);

    const filter = new Ctor(n, { fpp: fpp, keys: "int" });
    const present = new Set();
    let falseNegatives = 0;

    for (let i = 0; i < ops; i++) {
        // Bounded keyspace (Cuckoo) recurs keys so removes fire; else the low int32 half.
        const key = keyspace ? (rng() % keyspace) : (rng() >>> 1);
        if (present.has(key)) {
            // The oracle says present, so remove() MUST agree (return true) and MUST
            // not have read the key as absent -- a false negative on a live key.
            const removed = filter.remove(key);
            if (!removed) falseNegatives++;
            present.delete(key);
        } else {
            filter.add(key);
            present.add(key);
        }
    }

    // Law: every key CURRENTLY present must read true -- 0 false negatives.
    for (const key of present) {
        if (!filter.mightContain(key)) falseNegatives++;
    }

    return {
        falseNegatives: falseNegatives,
        present: present.size,
        filterSize: filter.size,
    };
}

/**
 * The RESIZE differential (Quotient): add `n` distinct int keys, `resize()` to a different
 * capacity, then requery -- membership MUST be preserved (0 false negatives) and the size
 * MUST be unchanged (resize re-inserts every stored fingerprint without the original keys).
 * `opts.factor` scales the resize target relative to n (e.g. 4 = grow, 0.4 = shrink but
 * still >= the current occupancy). Seeded + deterministic.
 *
 * @param {Function} Ctor  a resizable member constructor (e.g. Quotient)
 * @param {{ n:number, fpp:number, seed:number, factor:number }} opts
 * @returns {{ falseNegatives:number, sizeBefore:number, sizeAfter:number }}
 */
export function differentialResizeInt(Ctor, opts) {
    const rng = makePrng(opts.seed >>> 0);
    const filter = new Ctor(opts.n, { fpp: opts.fpp, keys: "int" });
    const truth = new Set();
    while (truth.size < opts.n) {
        const key = (rng() >>> 1);
        if (!truth.has(key)) { truth.add(key); filter.add(key); }
    }
    const sizeBefore = filter.size;
    filter.resize(Math.max(1, Math.floor(opts.n * opts.factor)));
    let falseNegatives = 0;
    for (const key of truth) if (!filter.mightContain(key)) falseNegatives++;
    return { falseNegatives: falseNegatives, sizeBefore: sizeBefore, sizeAfter: filter.size };
}

/**
 * The MERGE differential (Quotient): fill two identically-configured filters with DISJOINT
 * int key sets (A in the low quarter, B in the high quarter of the non-negative half),
 * `A.merge(B)`, then requery both sets -- membership MUST be preserved (0 false negatives)
 * and the merged size MUST equal `A.size + B.size` exactly (disjoint -> the additive union).
 * Seeded + deterministic.
 *
 * @param {Function} Ctor  a mergeable member constructor (e.g. Quotient)
 * @param {{ n:number, fpp:number, seed:number }} opts
 * @returns {{ falseNegatives:number, expectedSize:number, mergedSize:number }}
 */
export function differentialMergeInt(Ctor, opts) {
    const rng = makePrng(opts.seed >>> 0);
    const A = new Ctor(opts.n * 3, { fpp: opts.fpp, keys: "int" });
    const B = new Ctor(opts.n * 3, { fpp: opts.fpp, keys: "int" });
    const aKeys = new Set();
    const bKeys = new Set();
    // A: keys in [0, 2^30); B: keys in [2^30, 2^31) -- DISJOINT by construction.
    while (aKeys.size < opts.n) {
        const key = (rng() >>> 2);              // [0, 2^30)
        if (!aKeys.has(key)) { aKeys.add(key); A.add(key); }
    }
    while (bKeys.size < opts.n) {
        const key = (rng() >>> 2) + 0x40000000; // [2^30, 2^31)
        if (!bKeys.has(key)) { bKeys.add(key); B.add(key); }
    }
    const expectedSize = A.size + B.size;
    A.merge(B);
    let falseNegatives = 0;
    for (const key of aKeys) if (!A.mightContain(key)) falseNegatives++;
    for (const key of bKeys) if (!A.mightContain(key)) falseNegatives++;
    return { falseNegatives: falseNegatives, expectedSize: expectedSize, mergedSize: A.size };
}
