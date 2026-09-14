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

import { Bloom, VERSION } from "../Filter.js";

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

/* -------------------------------------------------------------------------- *
 * CLI table.
 * -------------------------------------------------------------------------- */

function pad(s, w) { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; }

function printTable(rows, cap, fpp) {
    process.stdout.write(
        "\n@zakkster/lite-filter v" + VERSION + " -- Bloom bench (cap=" + cap +
        ", target fpp=" + fpp + ")\n" +
        "Measured FPR vs theoretical closed-form, checked against a real Set oracle.\n" +
        "ns/op is machine-local wall-clock -- an EXAMPLE, not a headline.\n\n");
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
    process.stdout.write(
        "\nThe GOLDEN RULE (GUIDE.md): a formula is a hypothesis. MEASURE your own keys.\n\n");
}

// Runnable entry: `node benchmark/Bench.mjs`.
if (import.meta.url === "file://" + process.argv[1] ||
    import.meta.url === new URL("file://" + process.argv[1]).href) {
    const cap = 100000;
    const fpp = 0.01;
    printTable(runBench({ cap, fpp }), cap, fpp);
}
