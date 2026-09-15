/**
 * @zakkster/lite-filter -- Bench.mjs: the shipped measurement tool.
 *
 * A runnable ESM tool AND an importable module. Two entry paths, both supported:
 *
 *   node benchmark/Bench.mjs
 *   npm run bench
 *   import { runBench, makePrng } from '@zakkster/lite-filter/benchmark/Bench.mjs'
 *
 * It imports ONLY ../Filter.js (the single implementation) -- zero runtime deps. It
 * is a TOOL, not a hot path: zero-alloc is NOT required of the bench itself; it must
 * only stay dependency-free and never mutate global state.
 *
 * WHY IT EXISTS (ROADMAP section 5, the honesty hook). The textbook
 * `fpp = (1 - e^(-k*n/m))^k` assumes independent, uniform hash positions. Under real
 * key distributions -- and especially at HIGH load factor (near-full) -- the MEASURED
 * FPR runs OVER the formula. The headline column is `% over theoretical`, so the
 * divergence the whole library is honest about is the FIRST thing you see. A number
 * from a paper is a starting hypothesis, not your filter's behavior on YOUR keys:
 * MEASURE with this bench against the real `Set` ground-truth oracle.
 *
 * WHAT IT REPORTS per workload: bits/item, k, measured FPR vs theoretical FPR,
 * `% over`, add ns/op, query ns/op -- all machine-local wall-clock, an EXAMPLE only,
 * never a cross-library headline. False positives are counted against a real `Set`,
 * so a positive on a never-added key is unambiguous.
 *
 * @license MIT
 */

import { Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter, VERSION } from "../Filter.js";

/** Seeded xorshift32 -- byte-reproducible from its seed. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5;  x >>>= 0;
        return x >>> 0;
    };
}

/* -------------------------------------------------------------------------- *
 * Seeded workload generators. Each returns { keys, probes } of DISJOINT integer
 * arrays: `keys` are added, `probes` are guaranteed non-members (drawn from the
 * negative half of the int32 domain), so a probe `true` is unambiguously a false
 * positive. `keys` may contain duplicates (zipfian/adversarial) on purpose.
 * -------------------------------------------------------------------------- */

/** UNIFORM random keys over the low (non-negative) int32 half. */
export function uniform(n, probes, seed) {
    const rng = makePrng(seed);
    const keys = new Array(n);
    for (let i = 0; i < n; i++) keys[i] = rng() >>> 1;
    const p = new Array(probes);
    for (let i = 0; i < probes; i++) p[i] = -1 - (rng() >>> 1);
    return { keys, probes: p };
}

/** ZIPFIAN keys: a small hot set dominates a long tail (skewed popularity). */
export function zipfian(n, probes, seed) {
    const rng = makePrng(seed);
    const keyspace = Math.max(16, Math.floor(n / 4));
    // Precompute a cumulative weight table for rank r ~ 1 / (r+1).
    const cum = new Float64Array(keyspace);
    let total = 0;
    for (let r = 0; r < keyspace; r++) { total += 1 / (r + 1); cum[r] = total; }
    const keys = new Array(n);
    for (let i = 0; i < n; i++) {
        const t = (rng() / 0xffffffff) * total;
        let lo = 0, hi = keyspace - 1;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (cum[mid] < t) lo = mid + 1; else hi = mid; }
        keys[i] = lo;
    }
    const p = new Array(probes);
    for (let i = 0; i < probes; i++) p[i] = -1 - (rng() >>> 1);
    return { keys, probes: p };
}

/** SEQUENTIAL integers 0..n-1 -- the pattern a weak hash clusters on. */
export function sequential(n, probes, seed) {
    const keys = new Array(n);
    for (let i = 0; i < n; i++) keys[i] = i;
    const p = new Array(probes);
    for (let i = 0; i < probes; i++) p[i] = -1 - i;
    return { keys, probes: p };
}

/** ADVERSARIAL near-full: fill the filter to ~1.5x its sized capacity with a
 *  clustered key distribution -- the load-factor case where measured FPR runs
 *  FAR over theory. Returns keys sized to the caller's n (the driver oversizes). */
export function adversarial(n, probes, seed) {
    const rng = makePrng(seed);
    const keys = new Array(n);
    // Clustered: many keys share high bits, stressing the low-entropy input case.
    for (let i = 0; i < n; i++) keys[i] = (rng() & 0xffff) | ((i & 0x7fff) << 16);
    const p = new Array(probes);
    for (let i = 0; i < probes; i++) p[i] = -1 - (rng() >>> 1);
    return { keys, probes: p };
}

/* -------------------------------------------------------------------------- *
 * The measurement core.
 * -------------------------------------------------------------------------- */

/**
 * Measure one workload against a fresh Bloom sized (cap, fpp). Returns a plain row
 * of numbers. Checked against a real `Set` oracle so a false positive is unambiguous.
 */
export function measure(name, gen, cap, fpp, seed) {
    const { keys, probes } = gen(cap, Math.max(cap * 10, 100000), seed);
    const filter = new Bloom(cap, { fpp, keys: "int" });
    const truth = new Set();

    const t0 = performance.now();
    for (let i = 0; i < keys.length; i++) filter.add(keys[i]);
    const addNs = ((performance.now() - t0) * 1e6) / keys.length;
    for (let i = 0; i < keys.length; i++) truth.add(keys[i]);

    // No false negatives: every added key must read true.
    let falseNeg = 0;
    for (const key of truth) if (!filter.mightContain(key)) falseNeg++;

    // Measured FPR against the oracle.
    const t1 = performance.now();
    let acc = 0;
    for (let i = 0; i < probes.length; i++) acc += filter.mightContain(probes[i]) ? 1 : 0;
    const queryNs = ((performance.now() - t1) * 1e6) / probes.length;
    let falsePos = 0, probed = 0;
    for (let i = 0; i < probes.length; i++) {
        if (truth.has(probes[i])) continue;
        probed++;
        if (filter.mightContain(probes[i])) falsePos++;
    }

    const distinct = truth.size;
    const m = filter._m;
    const k = filter._k;
    const measuredFpr = probed === 0 ? 0 : falsePos / probed;
    const theoretical = Math.pow(1 - Math.exp(-(k * distinct) / m), k);
    const overPct = theoretical === 0 ? 0 : ((measuredFpr - theoretical) / theoretical) * 100;
    const bitsPerItem = m / distinct;

    return {
        name, added: keys.length, distinct, bitsPerItem, k,
        measuredFpr, theoretical, overPct, addNs, queryNs, falseNeg,
    };
}

/**
 * Measure one workload against a fresh CountingBloom sized (cap, fpp). Same row shape
 * as `measure`, so the two members print into the same table for a direct comparison.
 */
export function measureCounting(name, gen, cap, fpp, seed) {
    const { keys, probes } = gen(cap, Math.max(cap * 10, 100000), seed);
    const filter = new CountingBloom(cap, { fpp, keys: "int" });
    const truth = new Set();

    const t0 = performance.now();
    for (let i = 0; i < keys.length; i++) filter.add(keys[i]);
    const addNs = ((performance.now() - t0) * 1e6) / keys.length;
    for (let i = 0; i < keys.length; i++) truth.add(keys[i]);

    let falseNeg = 0;
    for (const key of truth) if (!filter.mightContain(key)) falseNeg++;

    const t1 = performance.now();
    let acc = 0;
    for (let i = 0; i < probes.length; i++) acc += filter.mightContain(probes[i]) ? 1 : 0;
    const queryNs = ((performance.now() - t1) * 1e6) / probes.length;
    let falsePos = 0, probed = 0;
    for (let i = 0; i < probes.length; i++) {
        if (truth.has(probes[i])) continue;
        probed++;
        if (filter.mightContain(probes[i])) falsePos++;
    }

    const distinct = truth.size;
    const m = filter._m;
    const k = filter._k;
    const measuredFpr = probed === 0 ? 0 : falsePos / probed;
    const theoretical = Math.pow(1 - Math.exp(-(k * distinct) / m), k);
    const overPct = theoretical === 0 ? 0 : ((measuredFpr - theoretical) / theoretical) * 100;
    // CountingBloom's nibble store is 4 bits/counter -> 4x a plain Bloom's bits/item.
    const bitsPerItem = (m * 4) / distinct;

    return {
        name, added: keys.length, distinct, bitsPerItem, k,
        measuredFpr, theoretical, overPct, addNs, queryNs, falseNeg,
    };
}

/**
 * Measure one workload against a fresh BlockedBloom sized (cap, fpp). Same row shape as
 * `measure` so the two members print into the same side-by-side table. bits/item is 1x
 * (same store size as Bloom); the honest deltas are query ns (LOWER -- one cache miss)
 * and measured FPR (HIGHER -- lost cross-block independence, decisions/0013).
 */
export function measureBlocked(name, gen, cap, fpp, seed) {
    const { keys, probes } = gen(cap, Math.max(cap * 10, 100000), seed);
    const filter = new BlockedBloom(cap, { fpp, keys: "int" });
    const truth = new Set();

    const t0 = performance.now();
    for (let i = 0; i < keys.length; i++) filter.add(keys[i]);
    const addNs = ((performance.now() - t0) * 1e6) / keys.length;
    for (let i = 0; i < keys.length; i++) truth.add(keys[i]);

    let falseNeg = 0;
    for (const key of truth) if (!filter.mightContain(key)) falseNeg++;

    const t1 = performance.now();
    let acc = 0;
    for (let i = 0; i < probes.length; i++) acc += filter.mightContain(probes[i]) ? 1 : 0;
    const queryNs = ((performance.now() - t1) * 1e6) / probes.length;
    if (acc === -1) process.stdout.write(""); // keep acc observable
    let falsePos = 0, probed = 0;
    for (let i = 0; i < probes.length; i++) {
        if (truth.has(probes[i])) continue;
        probed++;
        if (filter.mightContain(probes[i])) falsePos++;
    }

    const distinct = truth.size;
    const m = filter._m;
    const k = filter._k;
    const measuredFpr = probed === 0 ? 0 : falsePos / probed;
    const theoretical = Math.pow(1 - Math.exp(-(k * distinct) / m), k);
    const overPct = theoretical === 0 ? 0 : ((measuredFpr - theoretical) / theoretical) * 100;
    const bitsPerItem = m / distinct;

    return {
        name, added: keys.length, distinct, bitsPerItem, k,
        measuredFpr, theoretical, overPct, addNs, queryNs, falseNeg,
    };
}

/**
 * Measure one workload against a fresh Cuckoo sized (cap, fpp). Same row shape as
 * `measure` so it prints into the same side-by-side table. Cuckoo's FPR is width-quantized
 * to `2b/2^f` (independent of fill), so `theoretical` is that closed form -- NOT Bloom's
 * fill-derived one -- and bits/item is the ACTUAL store (nb*b slots, byte-aligned to 8 or
 * 16 bits per slot), which is why it can run WIDER than Bloom's `~1.44*log2(1/fpp)`. add()
 * is FAIL-CLOSED at capacity (decisions/0014): if a workload oversizes past the load
 * target the excess adds THROW, so we stop at the first overflow and measure over the keys
 * that actually landed (the honest capacity limit, surfaced not hidden).
 */
export function measureCuckoo(name, gen, cap, fpp, seed) {
    const { keys, probes } = gen(cap, Math.max(cap * 10, 100000), seed);
    const filter = new Cuckoo(cap, { fpp, keys: "int" });
    const truth = new Set();

    const t0 = performance.now();
    let added = 0;
    let overflowed = false;
    for (let i = 0; i < keys.length; i++) {
        try { filter.add(keys[i]); } catch (e) { overflowed = true; break; }
        added++;
    }
    const addNs = added === 0 ? 0 : ((performance.now() - t0) * 1e6) / added;
    for (let i = 0; i < added; i++) truth.add(keys[i]);

    let falseNeg = 0;
    for (const key of truth) if (!filter.mightContain(key)) falseNeg++;

    const t1 = performance.now();
    let acc = 0;
    for (let i = 0; i < probes.length; i++) acc += filter.mightContain(probes[i]) ? 1 : 0;
    const queryNs = ((performance.now() - t1) * 1e6) / probes.length;
    if (acc === -1) process.stdout.write(""); // keep acc observable
    let falsePos = 0, probed = 0;
    for (let i = 0; i < probes.length; i++) {
        if (truth.has(probes[i])) continue;
        probed++;
        if (filter.mightContain(probes[i])) falsePos++;
    }

    const distinct = truth.size;
    // The fingerprint width f is the row's "k" column (Cuckoo has no k probes).
    const k = filter._f;
    const measuredFpr = probed === 0 ? 0 : falsePos / probed;
    // Cuckoo FPR is width-quantized: 2b/2^f, independent of load.
    const theoretical = (2 * filter._b) / Math.pow(2, filter._f);
    const overPct = theoretical === 0 ? 0 : ((measuredFpr - theoretical) / theoretical) * 100;
    // ACTUAL store: nb*b slots byte-aligned to 8 or 16 bits per slot.
    const bitsPerItem = distinct === 0 ? 0 : (filter._store.byteLength * 8) / distinct;

    return {
        name, added, distinct, bitsPerItem, k,
        measuredFpr, theoretical, overPct, addNs, queryNs, falseNeg, overflowed,
    };
}

/**
 * Measure one workload against a fresh Quotient sized (cap, fpp). Same row shape as
 * `measure` so it prints into the same side-by-side table. A Quotient's FPR is remainder-
 * quantized to `load * 2^-r`, so `theoretical` is that load-scaled closed form (NOT Bloom's
 * fill-derived one), and bits/item is the ACTUAL store (nslots + guard words, byte-aligned
 * to the r+3 slot width). add() is FAIL-CLOSED at the 0.90 load ceiling / off the linear end
 * (decisions/0016): if a workload oversizes past the ceiling the excess adds THROW, so we
 * stop at the first overflow and measure over the keys that actually landed.
 */
export function measureQuotient(name, gen, cap, fpp, seed) {
    const { keys, probes } = gen(cap, Math.max(cap * 10, 100000), seed);
    const filter = new Quotient(cap, { fpp, keys: "int" });
    const truth = new Set();

    const t0 = performance.now();
    let added = 0;
    let overflowed = false;
    for (let i = 0; i < keys.length; i++) {
        try { filter.add(keys[i]); } catch (e) { overflowed = true; break; }
        added++;
    }
    const addNs = added === 0 ? 0 : ((performance.now() - t0) * 1e6) / added;
    for (let i = 0; i < added; i++) truth.add(keys[i]);

    let falseNeg = 0;
    for (const key of truth) if (!filter.mightContain(key)) falseNeg++;

    const t1 = performance.now();
    let acc = 0;
    for (let i = 0; i < probes.length; i++) acc += filter.mightContain(probes[i]) ? 1 : 0;
    const queryNs = ((performance.now() - t1) * 1e6) / probes.length;
    if (acc === -1) process.stdout.write(""); // keep acc observable
    let falsePos = 0, probed = 0;
    for (let i = 0; i < probes.length; i++) {
        if (truth.has(probes[i])) continue;
        probed++;
        if (filter.mightContain(probes[i])) falsePos++;
    }

    const distinct = truth.size;
    // The remainder width r is the row's "k" column (a Quotient has no k probes).
    const k = filter._r;
    const measuredFpr = probed === 0 ? 0 : falsePos / probed;
    // Quotient FPR is remainder-quantized: load * 2^-r.
    const theoretical = (filter.size / filter._nslots) * Math.pow(2, -filter._r);
    const overPct = theoretical === 0 ? 0 : ((measuredFpr - theoretical) / theoretical) * 100;
    // ACTUAL store: (nslots + guard) slots byte-aligned to the r+3 slot word width.
    const bitsPerItem = distinct === 0 ? 0 : (filter._store.byteLength * 8) / distinct;

    return {
        name, added, distinct, bitsPerItem, k,
        measuredFpr, theoretical, overPct, addNs, queryNs, falseNeg, overflowed,
    };
}

/**
 * Measure one workload against a fresh XorFilter BUILT from (cap, fpp). Same row shape as
 * `measure` so it prints into the same side-by-side table. An XOR filter is STATIC: it is
 * built ONCE from the deduped key set (not incrementally), so there is no per-add timing --
 * `addNs` reports the amortized BUILD ns/key instead. Its FPR is the width-quantized `2^-fw`
 * (fw=8 or 16, byte-aligned), independent of fill, typically UNDER the configured target --
 * the measure-vs-configured honesty hook. bits/item is the ACTUAL store (3*bl slots byte-
 * aligned to fw), which is close to the ~1.23x information-theoretic space bound. `from()`
 * DEDUPES the input (contrast Cuckoo / Quotient), so `distinct` drives every rate.
 */
export function measureXor(name, gen, cap, fpp, seed) {
    const { keys, probes } = gen(cap, Math.max(cap * 10, 100000), seed);
    const truth = new Set(keys);

    const t0 = performance.now();
    const filter = XorFilter.from(keys, { fpp, keys: "int" });
    const distinct = filter.size;
    const addNs = distinct === 0 ? 0 : ((performance.now() - t0) * 1e6) / distinct;

    let falseNeg = 0;
    for (const key of truth) if (!filter.mightContain(key)) falseNeg++;

    const t1 = performance.now();
    let acc = 0;
    for (let i = 0; i < probes.length; i++) acc += filter.mightContain(probes[i]) ? 1 : 0;
    const queryNs = ((performance.now() - t1) * 1e6) / probes.length;
    if (acc === -1) process.stdout.write(""); // keep acc observable
    let falsePos = 0, probed = 0;
    for (let i = 0; i < probes.length; i++) {
        if (truth.has(probes[i])) continue;
        probed++;
        if (filter.mightContain(probes[i])) falsePos++;
    }

    // The fingerprint width fw is the row's "k" column (an XOR filter has no k probes).
    const k = filter._fw;
    const measuredFpr = probed === 0 ? 0 : falsePos / probed;
    // XOR FPR is width-quantized: 2^-fw, independent of fill.
    const theoretical = Math.pow(2, -filter._fw);
    const overPct = theoretical === 0 ? 0 : ((measuredFpr - theoretical) / theoretical) * 100;
    // ACTUAL store: 3*bl slots byte-aligned to fw bits per slot.
    const bitsPerItem = distinct === 0 ? 0 : (filter._fp.byteLength * 8) / distinct;

    return {
        name, added: distinct, distinct, bitsPerItem, k,
        measuredFpr, theoretical, overPct, addNs, queryNs, falseNeg,
    };
}

/**
 * The remove/churn workload (CountingBloom only): add N distinct keys, remove HALF,
 * then requery -- the still-present half MUST show 0 false negatives, and the removed
 * half should mostly read absent. Reports remove ns/op and the two counts. This is the
 * property Bloom cannot offer at all (its remove() throws).
 */
export function measureRemove(cap, fpp, seed) {
    const { keys } = uniform(cap, 1, seed);
    // De-duplicate so "remove half" is well-defined on distinct keys.
    const distinct = Array.from(new Set(keys));
    const filter = new CountingBloom(cap, { fpp, keys: "int" });
    for (let i = 0; i < distinct.length; i++) filter.add(distinct[i]);

    const half = distinct.length >> 1;
    const t0 = performance.now();
    for (let i = 0; i < half; i++) filter.remove(distinct[i]);
    const removeNs = half === 0 ? 0 : ((performance.now() - t0) * 1e6) / half;

    // The still-present half: 0 false negatives is the law.
    let falseNegPresent = 0;
    for (let i = half; i < distinct.length; i++) {
        if (!filter.mightContain(distinct[i])) falseNegPresent++;
    }
    // The removed half: how many still read present (residue from shared counters).
    let residual = 0;
    for (let i = 0; i < half; i++) if (filter.mightContain(distinct[i])) residual++;

    return {
        name: "remove-churn", added: distinct.length, removed: half,
        stillPresent: distinct.length - half, falseNegPresent, residual,
        residualRate: half === 0 ? 0 : residual / half, removeNs, size: filter.size,
    };
}

/** Run the full workload matrix. Returns an array of rows. */
export function runBench(opts) {
    const cap = (opts && opts.cap) || 100000;
    const fpp = (opts && opts.fpp) || 0.01;
    const seed = (opts && opts.seed) || 0xC0FFEE;
    const rows = [];
    rows.push(measure("uniform", uniform, cap, fpp, seed));
    rows.push(measure("zipfian", zipfian, cap, fpp, seed ^ 0x11));
    rows.push(measure("sequential", sequential, cap, fpp, seed ^ 0x22));
    // adversarial: oversize the key set to ~1.5x cap -> near-full load factor.
    rows.push(measure("adversarial", (n, p, s) => adversarial(Math.floor(cap * 1.5), p, s),
        cap, fpp, seed ^ 0x33));
    return rows;
}

/** Run the BlockedBloom workload matrix (FPR-vs-theory across the 4 workloads). */
export function runBenchBlocked(opts) {
    const cap = (opts && opts.cap) || 100000;
    const fpp = (opts && opts.fpp) || 0.01;
    const seed = (opts && opts.seed) || 0xC0FFEE;
    const rows = [];
    rows.push(measureBlocked("uniform", uniform, cap, fpp, seed));
    rows.push(measureBlocked("zipfian", zipfian, cap, fpp, seed ^ 0x11));
    rows.push(measureBlocked("sequential", sequential, cap, fpp, seed ^ 0x22));
    rows.push(measureBlocked("adversarial", (n, p, s) => adversarial(Math.floor(cap * 1.5), p, s),
        cap, fpp, seed ^ 0x33));
    return rows;
}

/** Run the CountingBloom workload matrix (FPR-vs-theory across the 4 workloads). */
export function runBenchCounting(opts) {
    const cap = (opts && opts.cap) || 100000;
    const fpp = (opts && opts.fpp) || 0.01;
    const seed = (opts && opts.seed) || 0xC0FFEE;
    const rows = [];
    rows.push(measureCounting("uniform", uniform, cap, fpp, seed));
    rows.push(measureCounting("zipfian", zipfian, cap, fpp, seed ^ 0x11));
    rows.push(measureCounting("sequential", sequential, cap, fpp, seed ^ 0x22));
    rows.push(measureCounting("adversarial", (n, p, s) => adversarial(Math.floor(cap * 1.5), p, s),
        cap, fpp, seed ^ 0x33));
    return rows;
}

/** Run the Cuckoo workload matrix (FPR-vs-theory across the 4 workloads). */
export function runBenchCuckoo(opts) {
    const cap = (opts && opts.cap) || 100000;
    const fpp = (opts && opts.fpp) || 0.01;
    const seed = (opts && opts.seed) || 0xC0FFEE;
    const rows = [];
    rows.push(measureCuckoo("uniform", uniform, cap, fpp, seed));
    rows.push(measureCuckoo("zipfian", zipfian, cap, fpp, seed ^ 0x11));
    rows.push(measureCuckoo("sequential", sequential, cap, fpp, seed ^ 0x22));
    rows.push(measureCuckoo("adversarial", (n, p, s) => adversarial(Math.floor(cap * 1.5), p, s),
        cap, fpp, seed ^ 0x33));
    return rows;
}

/** Run the Quotient workload matrix (FPR-vs-theory across the 4 workloads). */
export function runBenchQuotient(opts) {
    const cap = (opts && opts.cap) || 100000;
    const fpp = (opts && opts.fpp) || 0.01;
    const seed = (opts && opts.seed) || 0xC0FFEE;
    const rows = [];
    rows.push(measureQuotient("uniform", uniform, cap, fpp, seed));
    rows.push(measureQuotient("zipfian", zipfian, cap, fpp, seed ^ 0x11));
    rows.push(measureQuotient("sequential", sequential, cap, fpp, seed ^ 0x22));
    rows.push(measureQuotient("adversarial", (n, p, s) => adversarial(Math.floor(cap * 1.5), p, s),
        cap, fpp, seed ^ 0x33));
    return rows;
}

/** Run the XOR workload matrix (FPR-vs-theory across the 4 workloads). */
export function runBenchXor(opts) {
    const cap = (opts && opts.cap) || 100000;
    const fpp = (opts && opts.fpp) || 0.01;
    const seed = (opts && opts.seed) || 0xC0FFEE;
    const rows = [];
    rows.push(measureXor("uniform", uniform, cap, fpp, seed));
    rows.push(measureXor("zipfian", zipfian, cap, fpp, seed ^ 0x11));
    rows.push(measureXor("sequential", sequential, cap, fpp, seed ^ 0x22));
    rows.push(measureXor("adversarial", (n, p, s) => adversarial(Math.floor(cap * 1.5), p, s),
        cap, fpp, seed ^ 0x33));
    return rows;
}

/* -------------------------------------------------------------------------- *
 * CLI table.
 * -------------------------------------------------------------------------- */

function pad(s, w) { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; }

function printRows(rows) {
    process.stdout.write(
        pad("workload", 12) + pad("bits/item", 11) + pad("k", 3) +
        pad("measFPR", 11) + pad("theoFPR", 11) + pad("% over", 9) +
        pad("add ns", 9) + pad("query ns", 10) + pad("falseNeg", 10) + "\n");
    for (const r of rows) {
        process.stdout.write(
            pad(r.name, 12) +
            pad(r.bitsPerItem.toFixed(2), 11) +
            pad(r.k, 3) +
            pad(r.measuredFpr.toFixed(5), 11) +
            pad(r.theoretical.toFixed(5), 11) +
            pad(r.overPct.toFixed(1) + "%", 9) +
            pad(r.addNs.toFixed(1), 9) +
            pad(r.queryNs.toFixed(1), 10) +
            pad(r.falseNeg, 10) + "\n");
    }
}

function printTable(rows, cap, fpp) {
    process.stdout.write(
        "\n@zakkster/lite-filter v" + VERSION + " -- Bloom bench (cap=" + cap +
        ", target fpp=" + fpp + ")\n" +
        "Measured FPR vs theoretical closed-form, checked against a real Set oracle.\n" +
        "ns/op is machine-local wall-clock -- an EXAMPLE, not a headline.\n\n");
    printRows(rows);
    process.stdout.write(
        "\nThe GOLDEN RULE (GUIDE.md): a formula is a hypothesis. MEASURE your own keys.\n\n");
}

function printCountingTable(rows, remove, cap, fpp) {
    process.stdout.write(
        "@zakkster/lite-filter v" + VERSION + " -- CountingBloom bench (cap=" + cap +
        ", target fpp=" + fpp + ")\n" +
        "Same FPR-vs-theory columns; bits/item is 4x Bloom (4-bit counters).\n\n");
    printRows(rows);
    process.stdout.write(
        "\nremove-churn: add " + remove.added + " distinct, remove " + remove.removed +
        " -> stillPresent=" + remove.stillPresent +
        " falseNegPresent=" + remove.falseNegPresent +
        " (MUST be 0) residual=" + remove.residual +
        " residualRate=" + remove.residualRate.toFixed(5) +
        " remove ns/op=" + remove.removeNs.toFixed(1) +
        " size=" + remove.size + "\n" +
        "residual = removed keys that still read present (shared-counter residue), a\n" +
        "false-POSITIVE effect; the never-false-negative law is falseNegPresent=0.\n\n");
}

/**
 * The MANDATORY honesty output (decisions/0013): Bloom vs BlockedBloom SIDE BY SIDE at
 * the same bits/item across the four workloads. The two columns that tell the whole
 * story: query ns (BlockedBloom should be LOWER -- one cache miss) and measured FPR
 * (BlockedBloom should be HIGHER -- the locality penalty). No "same fpp for free".
 */
function printBlockedTable(bloomRows, blockedRows, cap, fpp) {
    process.stdout.write(
        "@zakkster/lite-filter v" + VERSION + " -- Bloom vs BlockedBloom (cap=" + cap +
        ", target fpp=" + fpp + ")\n" +
        "Same bits/item. BlockedBloom trades a HIGHER measured FPR (lost cross-block\n" +
        "independence, decisions/0013) for a LOWER query ns (one 64-byte cache line).\n\n");
    process.stdout.write(
        pad("workload", 12) + pad("bits/item", 11) +
        pad("Bloom FPR", 12) + pad("Blkd FPR", 12) + pad("FPR delta", 11) +
        pad("Bloom qns", 11) + pad("Blkd qns", 11) + pad("qns delta", 11) + "\n");
    for (let i = 0; i < bloomRows.length; i++) {
        const bl = bloomRows[i];
        const bb = blockedRows[i];
        const fprDelta = bb.measuredFpr - bl.measuredFpr;
        const qnsDelta = bb.queryNs - bl.queryNs;
        process.stdout.write(
            pad(bl.name, 12) +
            pad(bl.bitsPerItem.toFixed(2), 11) +
            pad(bl.measuredFpr.toFixed(5), 12) +
            pad(bb.measuredFpr.toFixed(5), 12) +
            pad((fprDelta >= 0 ? "+" : "") + fprDelta.toFixed(5), 11) +
            pad(bl.queryNs.toFixed(1), 11) +
            pad(bb.queryNs.toFixed(1), 11) +
            pad((qnsDelta >= 0 ? "+" : "") + qnsDelta.toFixed(1), 11) + "\n");
    }
    process.stdout.write(
        "\nBlkd FPR > Bloom FPR is the PENALTY (decisions/0013); Blkd qns < Bloom qns is\n" +
        "the WIN. fpp() reports the plain-Bloom FLOOR -- MEASURE your own keys.\n\n");
}

/**
 * Bloom vs Cuckoo SIDE BY SIDE across the four workloads: bits/item (Cuckoo is byte-aligned
 * so it can run WIDER), measured FPR and its THEORETICAL closed form (Bloom's fill-derived
 * `(1-e^(-kn/m))^k` vs Cuckoo's width-quantized `2b/2^f`). Cuckoo's measured FPR typically
 * lands BELOW its configured target because the fingerprint width is byte-aligned UP -- the
 * measure-vs-configured honesty hook. The `k` column is Bloom's hash count / Cuckoo's
 * fingerprint width f.
 */
function printCuckooTable(bloomRows, cuckooRows, cap, fpp) {
    process.stdout.write(
        "@zakkster/lite-filter v" + VERSION + " -- Bloom vs Cuckoo (cap=" + cap +
        ", target fpp=" + fpp + ")\n" +
        "Cuckoo stores a nonzero fingerprint (b=4 slots/bucket); its FPR is width-quantized\n" +
        "to 2b/2^f (independent of fill), typically UNDER the configured target. add() is\n" +
        "fail-closed at capacity (decisions/0014) -- an oversized workload overflows.\n\n");
    process.stdout.write(
        pad("workload", 12) + pad("Bl b/item", 11) + pad("Ck b/item", 11) +
        pad("Bloom FPR", 12) + pad("Ckoo FPR", 12) + pad("Ck theoFPR", 12) +
        pad("Bl add", 9) + pad("Ck add", 9) + pad("added", 9) + "\n");
    for (let i = 0; i < bloomRows.length; i++) {
        const bl = bloomRows[i];
        const ck = cuckooRows[i];
        process.stdout.write(
            pad(bl.name, 12) +
            pad(bl.bitsPerItem.toFixed(2), 11) +
            pad(ck.bitsPerItem.toFixed(2), 11) +
            pad(bl.measuredFpr.toFixed(5), 12) +
            pad(ck.measuredFpr.toFixed(5), 12) +
            pad(ck.theoretical.toFixed(5), 12) +
            pad(bl.addNs.toFixed(1), 9) +
            pad(ck.addNs.toFixed(1), 9) +
            pad(ck.added + (ck.overflowed ? "*" : ""), 9) + "\n");
    }
    process.stdout.write(
        "\n* = add() hit the fail-closed capacity door (decisions/0014); metrics are over\n" +
        "the keys that landed. Cuckoo deletes (remove -> boolean) and its FPR is quantized\n" +
        "by the byte-aligned fingerprint width -- MEASURE your own keys.\n\n");
}

/**
 * Bloom vs Quotient SIDE BY SIDE across the four workloads: bits/item (a Quotient carries
 * metadata + shift + guard overhead on top of r bits/item, so it runs WIDER than Bloom),
 * measured FPR and its THEORETICAL closed form (Bloom's fill-derived `(1-e^(-kn/m))^k` vs
 * the Quotient's remainder-quantized `load * 2^-r`). The Quotient measured FPR typically
 * lands BELOW its configured target because r is byte-aligned UP -- the measure-vs-
 * configured honesty hook. The `k` column is Bloom's hash count / the Quotient's remainder
 * width r. `add ns` rises toward the 0.90 load ceiling as clusters lengthen.
 */
function printQuotientTable(bloomRows, qfRows, cap, fpp) {
    process.stdout.write(
        "@zakkster/lite-filter v" + VERSION + " -- Bloom vs Quotient (cap=" + cap +
        ", target fpp=" + fpp + ")\n" +
        "A Quotient stores a remainder + 3 metadata bits per slot (linear probing); its FPR\n" +
        "is remainder-quantized to load*2^-r, typically UNDER target. It DELETES, MERGES and\n" +
        "RESIZES; add() is fail-closed at the 0.90 load ceiling (decisions/0016).\n\n");
    process.stdout.write(
        pad("workload", 12) + pad("Bl b/item", 11) + pad("Qf b/item", 11) +
        pad("Bloom FPR", 12) + pad("Qtnt FPR", 12) + pad("Qf theoFPR", 12) +
        pad("Bl add", 9) + pad("Qf add", 9) + pad("added", 9) + "\n");
    for (let i = 0; i < bloomRows.length; i++) {
        const bl = bloomRows[i];
        const qf = qfRows[i];
        process.stdout.write(
            pad(bl.name, 12) +
            pad(bl.bitsPerItem.toFixed(2), 11) +
            pad(qf.bitsPerItem.toFixed(2), 11) +
            pad(bl.measuredFpr.toFixed(5), 12) +
            pad(qf.measuredFpr.toFixed(5), 12) +
            pad(qf.theoretical.toFixed(5), 12) +
            pad(bl.addNs.toFixed(1), 9) +
            pad(qf.addNs.toFixed(1), 9) +
            pad(qf.added + (qf.overflowed ? "*" : ""), 9) + "\n");
    }
    process.stdout.write(
        "\n* = add() hit the fail-closed 0.90 load ceiling (decisions/0016); metrics are over\n" +
        "the keys that landed. The Quotient deletes (remove -> boolean), merges and resizes;\n" +
        "its FPR is remainder-quantized by the byte-aligned width -- MEASURE your own keys.\n\n");
}

/**
 * Bloom vs XOR SIDE BY SIDE across the four workloads: bits/item (an XOR filter approaches
 * the ~1.23x information-theoretic space bound -- fw bits/item plus the ~1.23x factor, so at
 * fw=8 it runs ~9.8 bits/item, LEANER than Cuckoo/Quotient and competitive with Bloom while
 * delivering a LOWER FPR), measured FPR and its THEORETICAL closed form (Bloom's fill-derived
 * `(1-e^(-kn/m))^k` vs XOR's width-quantized `2^-fw`). The XOR measured FPR typically lands
 * BELOW its configured target because fw is byte-aligned UP -- the measure-vs-configured
 * honesty hook. The `k` column is Bloom's hash count / the XOR fingerprint width fw. XOR is
 * STATIC: `add ns` reports the amortized BUILD ns/key (it is built once, not incrementally).
 */
function printXorTable(bloomRows, xfRows, cap, fpp) {
    process.stdout.write(
        "@zakkster/lite-filter v" + VERSION + " -- Bloom vs XOR (cap=" + cap +
        ", target fpp=" + fpp + ")\n" +
        "An XOR filter is STATIC: built ONCE from a known key set (peeling a 3-uniform\n" +
        "hypergraph), no add/remove. Its FPR is width-quantized to 2^-fw, typically UNDER\n" +
        "target; it approaches the ~1.23x space lower bound. add ns = amortized build ns/key.\n\n");
    process.stdout.write(
        pad("workload", 12) + pad("Bl b/item", 11) + pad("Xf b/item", 11) +
        pad("Bloom FPR", 12) + pad("Xor FPR", 12) + pad("Xf theoFPR", 12) +
        pad("Bl add", 9) + pad("Xf build", 10) + pad("distinct", 10) + "\n");
    for (let i = 0; i < bloomRows.length; i++) {
        const bl = bloomRows[i];
        const xf = xfRows[i];
        process.stdout.write(
            pad(bl.name, 12) +
            pad(bl.bitsPerItem.toFixed(2), 11) +
            pad(xf.bitsPerItem.toFixed(2), 11) +
            pad(bl.measuredFpr.toFixed(5), 12) +
            pad(xf.measuredFpr.toFixed(5), 12) +
            pad(xf.theoretical.toFixed(5), 12) +
            pad(bl.addNs.toFixed(1), 9) +
            pad(xf.addNs.toFixed(1), 10) +
            pad(xf.distinct, 10) + "\n");
    }
    process.stdout.write(
        "\nAn XOR filter DEDUPES its input (keys are a SET, not multiplicity -- contrast\n" +
        "Cuckoo / Quotient); it cannot delete or grow. Its FPR is quantized by the byte-\n" +
        "aligned fingerprint width -- MEASURE your own keys.\n\n");
}

// Runnable entry: `node benchmark/Bench.mjs`.
if (import.meta.url === "file://" + process.argv[1] ||
    import.meta.url === new URL("file://" + process.argv[1]).href) {
    const cap = 100000;
    const fpp = 0.01;
    const bloomRows = runBench({ cap, fpp });
    printTable(bloomRows, cap, fpp);
    printCountingTable(runBenchCounting({ cap, fpp }), measureRemove(cap, fpp, 0xC0FFEE ^ 0x44), cap, fpp);
    printBlockedTable(bloomRows, runBenchBlocked({ cap, fpp }), cap, fpp);
    printCuckooTable(bloomRows, runBenchCuckoo({ cap, fpp }), cap, fpp);
    printQuotientTable(bloomRows, runBenchQuotient({ cap, fpp }), cap, fpp);
    printXorTable(bloomRows, runBenchXor({ cap, fpp }), cap, fpp);
}
