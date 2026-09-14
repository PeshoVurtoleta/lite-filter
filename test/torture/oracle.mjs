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
 * Run the differential oracle for an integer-keyed member.
 *
 * @param {Function} Ctor  the member constructor (e.g. Bloom)
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
