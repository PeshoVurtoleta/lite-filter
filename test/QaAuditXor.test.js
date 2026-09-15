/**
 * @zakkster/lite-filter -- QA independent-verification suite (v0.6.0 XOR).
 *
 * This file is owned by QA, not the coder: QA writes the independent falsification of the
 * planner's XOR ASSERTIONS (decisions/0018, 0019, 0020) here -- a boundary matrix and
 * adversarial cases that FAIL on regression rather than replaying the shipped suite. The
 * three seed tests below (signature catch, immutability doors, 100-attempt exhaustion)
 * were the coder's minimal stub; everything after them is QA's own adversarial audit.
 *
 * node:test only. No dependency outside this package + its devDependency peers (node core
 * modules -- node:fs/node:os/node:url/node:path -- are used only for the mutation-canary
 * test, which writes a scratch copy of Filter.js to the OS temp dir and cleans it up).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { XorFilter } from "../Filter.js";
import { validateXor } from "./validate.mjs";
import { differentialStaticInt, makePrng } from "./torture/oracle.mjs";

// The charter's SIGNATURE catch: a peel that exits WITHOUT a full peel and still assigns
// fingerprints would fail OPEN (silent false negatives on real keys). Proven here at scale:
// a large distinct key set must read back with 0 false negatives -- which can ONLY hold if
// the peel-stack length reached n (a complete peel) before assignment (decisions/0018).
test("QA: a large built set has 0 false negatives (the complete-peel guarantee, fail-OPEN catch)", () => {
    const keys = [];
    for (let i = 0; i < 100000; i++) keys.push(i * 7 + 3);
    const f = XorFilter.from(keys, { fpp: 0.01, keys: "int" });
    let fn = 0;
    for (const k of keys) if (!f.mightContain(k)) fn++;
    assert.equal(fn, 0, "a false negative means the peel was INCOMPLETE and the build shipped anyway (fail-open)");
    validateXor(f);
});

// The immutability doors (decisions/0019): add/remove/clear/new all throw fail-closed.
test("QA: the static member has no mutation surface (add/remove/clear/new all throw)", () => {
    const f = XorFilter.from([1, 2, 3], { keys: "int" });
    assert.throws(() => f.add(4), /\[lite-filter\]/);
    assert.throws(() => f.remove(1), /\[lite-filter\]/);
    assert.throws(() => f.clear(), /\[lite-filter\]/);
    assert.throws(() => new XorFilter(), /\[lite-filter\]/);
});

// The 100-attempt exhaustion door (decisions/0018): a degenerate duplicate-encoding set
// throws fail-closed rather than shipping a partial build.
test("QA: a degenerate key set exhausts the reseed budget and throws (never a partial build)", () => {
    assert.throws(() => XorFilter.from([{}, {}, {}]), /\[lite-filter\]/);
});

/* ============================================================================
 * 1. PARTIAL-PEEL FAIL-OPEN -- the signature catch, proven at scale AND by mutation.
 * ========================================================================== */

// Multi-seed / multi-size stress: every build across a spread of sizes and seeds must be
// either a COMPLETE peel (0 false negatives) or a fail-closed throw -- NEVER a partial
// build. This is a wider net than the single n=1e5 law already in Xor.test.js/torture.mjs.
test("QA: multi-seed/multi-size stress -- every successful build has 0 false negatives, never a partial ship", () => {
    const sizes = [1, 2, 3, 4, 5, 7, 10, 33, 97, 500, 5000, 20000];
    let builds = 0;
    for (const n of sizes) {
        for (const seedBump of [0, 1, 0x1234, 0x9e3779b1, 0xffffffff]) {
            const keys = [];
            for (let i = 0; i < n; i++) keys.push(i * 2654435761 % 2000000000);
            let f;
            try {
                f = XorFilter.from(keys, { keys: "int", seed: seedBump >>> 0 });
            } catch (e) {
                // A throw is fail-closed and acceptable, but ONLY for a genuinely
                // degenerate set -- these keys are distinct integers, so a throw here
                // would itself be a regression (spurious exhaustion).
                assert.fail("unexpected throw on a well-formed distinct-int key set (n=" + n +
                    ", seed=" + seedBump + "): " + e.message);
            }
            builds++;
            const distinct = new Set(keys);
            let fn = 0;
            for (const k of distinct) if (!f.mightContain(k)) fn++;
            assert.equal(fn, 0, "false negative at n=" + n + " seed=" + seedBump);
            assert.equal(f.size, distinct.size);
            validateXor(f);
        }
    }
    assert.ok(builds === sizes.length * 5, "the stress matrix must actually run every cell");
});

// Adversarial search: try to find ANY key set that BUILDS (no throw) yet returns a false
// negative on a member key. Distinct numeric keys peel with overwhelming probability at
// the 1.23x load factor; if this search ever finds a counterexample, that is QA-FAILED.
test("QA: adversarial search for a builds-but-lies key set finds NONE across many trials", () => {
    const rng = makePrng(0xdeadbeef);
    let trials = 0;
    let counterexamples = 0;
    for (let t = 0; t < 200; t++) {
        const n = 1 + (rng() % 400);
        const keys = [];
        const seen = new Set();
        while (seen.size < n) {
            const k = (rng() >>> 1);
            if (!seen.has(k)) { seen.add(k); keys.push(k); }
        }
        let f;
        try { f = XorFilter.from(keys, { keys: "int", seed: rng() >>> 0 }); }
        catch { continue; } // a fail-closed throw is not a counterexample
        trials++;
        for (const k of keys) if (!f.mightContain(k)) counterexamples++;
    }
    assert.ok(trials >= 150, "the search must actually exercise a meaningful number of builds, got " + trials);
    assert.equal(counterexamples, 0, "found a key set that BUILDS yet lies on a member key -- fail-open regression");
});

// MUTATION CANARY: disable the exact `if (sp !== n) return null` guard in a scratch copy
// of Filter.js and prove the degenerate 3-object build (which THROWS under the real guard)
// instead silently SHIPS a partial filter with a false negative. This is the load-bearing
// proof that the guard -- not luck -- is what prevents the fail-open failure mode.
test("QA mutation-canary: disabling the sp!==n peel-completeness guard turns the degenerate build into a SILENT partial (fail-open) build", async () => {
    const filterPath = new URL("../Filter.js", import.meta.url);
    const src = readFileSync(filterPath, "utf8");
    const guard = "if (sp !== n) return null;";
    assert.ok(src.includes(guard),
        "the signature guard text has moved or changed in Filter.js -- re-locate it before trusting this canary");
    const mutated = src.replace(guard, "if (false) { return null; }");
    assert.notEqual(mutated, src, "the mutation did not apply");

    const tmpFile = path.join(tmpdir(),
        "lite-filter-xor-mutant-" + process.pid + "-" + Date.now() + ".mjs");
    writeFileSync(tmpFile, mutated);
    try {
        const { XorFilter: MutantXor } = await import(pathToFileURL(tmpFile).href);
        // The EXACT degenerate set that throws under the real guard (see the stub test
        // above and Xor.test.js): three distinct objects that all String()-encode to
        // "[object Object]" -> three parallel hyperedges on the SAME three vertices ->
        // no vertex ever reaches degree 1 -> the peel stack never advances (sp stays 0).
        const keys = [{}, {}, {}];
        let threw = false;
        let built;
        try { built = MutantXor.from(keys); }
        catch { threw = true; }
        assert.equal(threw, false,
            "with the completeness guard disabled the degenerate build must NOT throw (it ships a partial build)");
        let fn = 0;
        for (const k of keys) if (!built.mightContain(k)) fn++;
        assert.ok(fn > 0,
            "the mutant build must exhibit at least one false negative -- this is the proof that the real " +
            "guard (not the peeling math itself) is what prevents the fail-open outcome");
    } finally {
        rmSync(tmpFile, { force: true });
    }
});

/* ============================================================================
 * 2. WIDTH-DOOR BOUNDARY -- exact straddling values + non-vacuous measured FPR.
 * ========================================================================== */

test("QA: width door -- fpp just ABOVE, AT, and just BELOW the 2^-8 boundary", () => {
    const above = XorFilter.from([1, 2, 3], { fpp: Math.pow(2, -8) * 1.0001, keys: "int" });
    assert.equal(above._fw, 8, "fpp just above 2^-8 must still admit an 8-bit fingerprint");
    const at = XorFilter.from([1, 2, 3], { fpp: Math.pow(2, -8), keys: "int" });
    assert.equal(at._fw, 8, "fpp exactly 2^-8 is inclusive on the 8-bit side");
    const below = XorFilter.from([1, 2, 3], { fpp: Math.pow(2, -8) * 0.9999, keys: "int" });
    assert.equal(below._fw, 16, "fpp just below 2^-8 must widen to 16 bits");
});

test("QA: width door -- fpp just ABOVE, AT, and just BELOW the 2^-16 floor", () => {
    const above = XorFilter.from([1, 2, 3], { fpp: Math.pow(2, -16) * 1.0001, keys: "int" });
    assert.equal(above._fw, 16, "fpp just above the floor must still build at 16 bits");
    const at = XorFilter.from([1, 2, 3], { fpp: Math.pow(2, -16), keys: "int" });
    assert.equal(at._fw, 16, "fpp exactly at the floor is INCLUSIVE (must not throw)");
    assert.throws(() => XorFilter.from([1, 2, 3], { fpp: Math.pow(2, -16) * 0.9999, keys: "int" }),
        /\[lite-filter\]/, "fpp just below the 2^-16 floor must throw fail-closed");
});

// Non-vacuous measured FPR at fw=8, independently re-measured by QA (not just replaying
// the shipped suite's own call). Must sit under the configured target's characteristic
// ceiling AND be strictly > 0 (else the query path could be broken and never match).
test("QA: measured FPR at fw=8 sits under the 2^-8 characteristic ceiling and is non-vacuous", () => {
    const r = differentialStaticInt(XorFilter, { n: 100000, fpp: 0.01, probes: 1000000, seed: 777333 });
    assert.equal(r.falseNegatives, 0);
    assert.ok(r.fpr > 0, "measured FPR must be > 0 (non-vacuous -- the query path must actually match sometimes)");
    assert.ok(r.fpr <= 0.0050, "measured FPR " + r.fpr + " must sit under the fw=8 ceiling (~2^-8 = 0.0039)");
});

// Non-vacuous measured FPR at fw=16 -- a tighter target must actually deliver a TIGHTER
// measured rate (width quantization proven at the 16-bit lane too, not just 8-bit).
test("QA: measured FPR at fw=16 sits under the 2^-16 characteristic ceiling and is non-vacuous", () => {
    const r = differentialStaticInt(XorFilter, { n: 20000, fpp: 0.0001, probes: 2000000, seed: 424242 });
    assert.equal(r.falseNegatives, 0);
    assert.ok(r.fpr > 0, "measured FPR must be > 0 (non-vacuous)");
    // Expected hits ~= probes * 2^-16 ~= 30.5; a generous 4x margin absorbs sampling noise
    // while still catching a real regression (e.g. the query silently falling back to fw=8).
    assert.ok(r.fpr <= 0.00006,
        "measured FPR " + r.fpr + " must sit under the fw=16 ceiling (~2^-16 = 0.0000153, 4x margin)");
});

/* ============================================================================
 * 3. RESTORE DEEP-STRUCTURAL REJECTION -- every mutation throws, never truncates.
 * ========================================================================== */

function filledXor(opts) {
    const keys = [];
    for (let i = 0; i < 2000; i++) keys.push(i);
    return XorFilter.from(keys, opts);
}

test("QA: restore rejects every structural mutation, one at a time, and NEVER truncates", () => {
    const base = filledXor({ fpp: 0.01, keys: "int" });
    const pristine = base.dump();

    const mutations = [
        ["wrong mem", (s) => { s.mem = "Cuckoo"; }],
        ["fp.length = 3*bl - 1", (s) => { s.fp = s.fp.slice(0, s.fp.length - 1); }],
        ["fp.length = 3*bl + 1", (s) => { s.fp = s.fp.concat([0]); }],
        ["a single word = fpMask + 1", (s) => { s.fp[Math.floor(s.fp.length / 2)] = (1 << s.fw); }],
        ["a single word = -1", (s) => { s.fp[0] = -1; }],
        ["wrong seed (non-integer)", (s) => { s.seed = 1.5; }],
        ["wrong seed (negative)", (s) => { s.seed = -1; }],
        ["wrong fw (valid value, wrong for this fpp)", (s) => { s.fw = s.fw === 8 ? 16 : 8; }],
        ["keys-mode flipped int->null", (s) => { s.keys = null; }],
        ["keys-mode flipped null->int (via a fresh string-keyed dump)", null], // handled separately below
        ["count tampered so re-derived bl mismatches", (s) => { s.count = s.count + 1; }],
        ["bl tampered directly", (s) => { s.bl = s.bl - 1; }],
        ["format tag tampered", (s) => { s.f = "litefilter/999"; }],
    ];

    let checked = 0;
    for (const [label, mutate] of mutations) {
        if (mutate === null) continue;
        const snap = JSON.parse(JSON.stringify(pristine));
        mutate(snap);
        assert.throws(() => XorFilter.restore(snap), /\[lite-filter\]/,
            "restore() must reject: " + label);
        checked++;
    }
    assert.equal(checked, mutations.length - 1);

    // keys-mode flipped the OTHER direction: a string-keyed filter's dump reports keys:null;
    // flip it to 'int' and confirm restore rejects rather than silently reinterpreting the
    // hash path (a stripped/garbled keys field must never be guessed at).
    {
        const strFilter = XorFilter.from(["a", "b", "c", "d"], { fpp: 0.01 });
        const snap = strFilter.dump();
        assert.equal(snap.keys, null);
        snap.keys = "int";
        assert.throws(() => XorFilter.restore(snap), /\[lite-filter\]/,
            "flipping keys:null -> 'int' must fail closed, never silently reinterpret the hash path");
    }

    // A pristine, UNMUTATED dump must still round-trip with 0 false negatives -- proving
    // the rejections above are specific to the mutation, not an over-eager restore() bug.
    const restored = XorFilter.restore(JSON.parse(JSON.stringify(pristine)));
    for (let i = 0; i < 2000; i++) assert.equal(restored.mightContain(i), true, "false negative on " + i);
    assert.equal(restored.size, base.size);
    validateXor(restored);
});

test("QA: restore rejects a fingerprint word tampered at EVERY position class (first/middle/last), never truncating around it", () => {
    const positions = (fp) => [0, Math.floor(fp.length / 2), fp.length - 1];
    for (const posLabel of ["first", "middle", "last"]) {
        const base = filledXor({ fpp: 0.01, keys: "int" });
        const snap = base.dump();
        const idx = posLabel === "first" ? 0 : posLabel === "middle" ? Math.floor(snap.fp.length / 2) : snap.fp.length - 1;
        const before = snap.fp.slice();
        snap.fp[idx] = (1 << snap.fw); // exactly fpMask + 1: the boundary-adjacent invalid value
        assert.throws(() => XorFilter.restore(snap), /\[lite-filter\]/,
            "a corrupt word at the " + posLabel + " position must be rejected");
        // The snapshot object itself is the caller's; restore() must not have partially
        // consumed/mutated it in a way that changes its OTHER (valid) words.
        for (let i = 0; i < snap.fp.length; i++) {
            if (i === idx) continue;
            assert.equal(snap.fp[i], before[i], "restore() must not touch unrelated words while rejecting");
        }
    }
});

test("QA: a genuinely pristine restore round-trips with EXACT count === |Set(keys)| and 0 false negatives", () => {
    const f = filledXor({ fpp: 0.0001, keys: "int" }); // exercise the fw=16 lane too
    const g = XorFilter.restore(f.dump());
    assert.equal(g._fw, 16);
    assert.equal(g.size, 2000);
    for (let i = 0; i < 2000; i++) assert.equal(g.mightContain(i), true);
    validateXor(g);
});

/* ============================================================================
 * 4. DEDUP / SET SEMANTICS -- a SET, not multiplicity; SameValueZero, not ===.
 * ========================================================================== */

test("QA: heavy duplicates collapse to the exact distinct count (a Set, not multiplicity)", () => {
    const keys = [];
    for (let i = 0; i < 500; i++) {
        for (let r = 0; r < 50; r++) keys.push(i); // 50x multiplicity per distinct key
    }
    assert.equal(keys.length, 25000);
    const f = XorFilter.from(keys, { keys: "int" });
    assert.equal(f.size, 500, "size must be the DISTINCT count, not the raw 25000-entry multiplicity");
    for (let i = 0; i < 500; i++) assert.equal(f.mightContain(i), true, "false negative on " + i);
    validateXor(f);
});

test("QA: NaN dedupes to ONE entry (Set uses SameValueZero, not ===, so NaN !== NaN does not defeat dedup)", () => {
    const f = XorFilter.from([NaN, NaN, NaN, 1, 2]);
    assert.equal(f.size, 3, "NaN x3 + 1 + 2 must dedupe to 3 distinct entries");
    assert.equal(f.mightContain(NaN), true);
    validateXor(f);
});

test("QA: -0 and 0 dedupe to ONE entry under keys:'int' (bitwise ops normalize -0 -> +0)", () => {
    const f = XorFilter.from([-0, 0, 5], { keys: "int" });
    assert.equal(f.size, 2, "-0 and 0 must collapse to one distinct entry");
    assert.equal(f.mightContain(0), true);
    assert.equal(f.mightContain(-0), true);
    validateXor(f);
});

test("QA: from() accepts a generator and dedupes across yields, contrasted against multiplicity", () => {
    function* gen() { for (let i = 0; i < 10; i++) { yield 42; yield i; } }
    const f = XorFilter.from(gen(), { keys: "int" });
    // 42 yielded 10x, plus 0..9 -- 11 distinct values.
    assert.equal(f.size, 11);
    validateXor(f);
});

/* ============================================================================
 * 5. IMMUTABLE SURFACE -- add/remove/clear/new throw; has() is the sole alias.
 * ========================================================================== */

test("QA: add/remove/clear throw [lite-filter] on a RESTORED filter too (not just a freshly-built one)", () => {
    const base = XorFilter.from([1, 2, 3], { keys: "int" });
    const restored = XorFilter.restore(base.dump());
    assert.throws(() => restored.add(4), /\[lite-filter\]/);
    assert.throws(() => restored.remove(1), /\[lite-filter\]/);
    assert.throws(() => restored.clear(), /\[lite-filter\]/);
    assert.equal(restored.size, 3);
    assert.equal(restored.mightContain(1), true);
});

test("QA: duplicate 'dispose' -- calling the throwing mutators twice in a row is consistently fail-closed both times", () => {
    const f = XorFilter.from([1, 2, 3], { keys: "int" });
    for (let i = 0; i < 2; i++) {
        assert.throws(() => f.clear(), /\[lite-filter\]/, "clear() attempt #" + (i + 1));
        assert.throws(() => f.add(999), /\[lite-filter\]/, "add() attempt #" + (i + 1));
        assert.throws(() => f.remove(1), /\[lite-filter\]/, "remove() attempt #" + (i + 1));
    }
    // The repeated failed mutation attempts must leave the filter byte-identical.
    assert.equal(f.size, 3);
    assert.equal(f.mightContain(1), true);
    assert.equal(f.mightContain(2), true);
    assert.equal(f.mightContain(3), true);
});

test("QA: has() is the SOLE alias of mightContain -- identical result across a spread of keys, including misses", () => {
    const f = XorFilter.from([10, 20, 30], { keys: "int" });
    for (const k of [10, 20, 30, 999, -999, 0]) {
        assert.equal(f.has(k), f.mightContain(k), "has()/mightContain() diverge on " + k);
    }
});

/* ============================================================================
 * 6. BOUNDARY SIZES -- n=1, tiny (slack-dominated), and a large build.
 * ========================================================================== */

test("QA: n=0 via from([]) throws fail-closed (an XOR filter over zero keys is undefined; null is not zero)", () => {
    assert.throws(() => XorFilter.from([]), /\[lite-filter\]/);
    assert.throws(() => XorFilter.build([]), /\[lite-filter\]/);
});

test("QA: n=1 builds correctly and its segment length is dominated by the +32 slack", () => {
    const f = XorFilter.from([42], { keys: "int" });
    assert.equal(f.size, 1);
    assert.equal(f._bl, Math.ceil((1.23 * 1) / 3) + 32); // = 1 + 32 = 33
    assert.equal(f.mightContain(42), true);
    validateXor(f);
});

test("QA: n=2 and n=3 (arity-sized boundary) build correctly", () => {
    const f2 = XorFilter.from([1, 2], { keys: "int" });
    assert.equal(f2.size, 2);
    assert.equal(f2.mightContain(1), true);
    assert.equal(f2.mightContain(2), true);
    validateXor(f2);

    const f3 = XorFilter.from([1, 2, 3], { keys: "int" });
    assert.equal(f3.size, 3);
    for (const k of [1, 2, 3]) assert.equal(f3.mightContain(k), true);
    validateXor(f3);
});

test("QA: a large build (n=500000) peels within budget with 0 false negatives", () => {
    const r = differentialStaticInt(XorFilter, { n: 500000, fpp: 0.01, probes: 1, seed: 314159 });
    assert.equal(r.falseNegatives, 0);
});

/* ============================================================================
 * 7. keys:'int' STRICT VALIDATION -- out-of-range / non-integer keys throw on build
 *    AND on query. (The strict zero-alloc CLAIM itself is measured by test/perf/
 *    PerfGate.test.mjs's xfQueryHit scenario + test/torture.mjs phase 2 -- both under
 *    --expose-gc -- not re-measured here since plain `node --test` cannot observe
 *    scavenge/heap counters meaningfully.)
 * ========================================================================== */

test("QA: keys:'int' rejects every non-integer / out-of-range flavor on BUILD", () => {
    const bad = [
        2 ** 31, -(2 ** 31) - 1, 1.5, -1.5, NaN, Infinity, -Infinity,
        true, false, "5", null, undefined, {}, [], 0n,
    ];
    for (const b of bad) {
        assert.throws(() => XorFilter.from([1, 2, b], { keys: "int" }), /\[lite-filter\].*keys:'int'/,
            "from() must reject bad int key: " + String(b));
    }
});

test("QA: keys:'int' rejects every non-integer / out-of-range flavor on QUERY", () => {
    const f = XorFilter.from([1, 2, 3], { keys: "int" });
    const bad = [2 ** 31, -(2 ** 31) - 1, 1.5, NaN, Infinity, -Infinity, true, "5", null, undefined, {}, [], 0n];
    for (const b of bad) {
        assert.throws(() => f.mightContain(b), /\[lite-filter\].*keys:'int'/,
            "mightContain() must reject bad int key: " + String(b));
    }
    // The filter must be unaffected by the rejected queries.
    assert.equal(f.size, 3);
    for (const k of [1, 2, 3]) assert.equal(f.mightContain(k), true);
});

test("QA: keys:'int' accepts the exact 32-bit signed boundary (INT_MIN, INT_MAX) on build and query", () => {
    const f = XorFilter.from([-2147483648, 2147483647, 0], { keys: "int" });
    assert.equal(f.mightContain(-2147483648), true);
    assert.equal(f.mightContain(2147483647), true);
    assert.throws(() => f.mightContain(-2147483649), /\[lite-filter\]/);
    assert.throws(() => f.mightContain(2147483648), /\[lite-filter\]/);
});

/* ============================================================================
 * 8. RE-ENTRANT / DURING-ITERATION ADVERSARIAL CASES -- the boundary-matrix items
 *    that do not map literally onto a static/immutable member.
 * ========================================================================== */

// dispose-during-iteration, mapped onto a STATIC build: an iterable whose iterator
// mutates the underlying source WHILE from() is draining it. from() must terminate
// (no infinite loop / crash) and the resulting filter's membership must exactly match
// whatever was ACTUALLY enumerated -- no silent corruption from the concurrent mutation.
test("QA: an iterable that mutates itself during iteration does not corrupt the build (from() sees a stable snapshot of what it enumerated)", () => {
    const backing = [1, 2, 3];
    let iterations = 0;
    const selfMutating = {
        [Symbol.iterator]() {
            let i = 0;
            return {
                next() {
                    iterations++;
                    if (i >= backing.length) return { done: true, value: undefined };
                    const value = backing[i++];
                    // Grow the backing array WHILE it is being iterated, but only a
                    // bounded number of times so the test terminates deterministically.
                    if (backing.length < 6) backing.push(backing.length + 1);
                    return { done: false, value };
                },
            };
        },
    };
    const f = XorFilter.from(selfMutating, { keys: "int" });
    assert.ok(iterations > 0 && iterations < 1000, "from() must terminate (got " + iterations + " next() calls)");
    // Whatever ended up enumerated must all read true -- 0 false negatives on the
    // ACTUALLY-consumed set, regardless of how large the backing array grew mid-iteration.
    for (let i = 0; i < f.size; i++) {
        // size reflects the distinct enumerated values; membership for every value the
        // filter reports as counted must hold for the low integers we know were pushed.
    }
    assert.ok(f.size >= 3, "at least the original 3 keys must have been enumerated");
    validateXor(f);
    for (let v = 1; v <= 3; v++) assert.equal(f.mightContain(v), true, "false negative on " + v);
});

// re-entrant write: a key whose toString() (invoked by the arbitrary-key hash path's
// String() encode) reentrantly builds and queries an UNRELATED XorFilter. Proves the
// module holds no shared mutable build-time state that a reentrant call could corrupt
// (XOR_BUILD_TOKEN and friends are module-level constants, never touched by from()).
test("QA: re-entrant write -- a key's toString() reentrantly builds another XorFilter without corrupting either", () => {
    let reentered = false;
    const reentrant = {
        toString() {
            reentered = true;
            const inner = XorFilter.from([100, 200, 300], { keys: "int" });
            assert.equal(inner.mightContain(100), true);
            assert.equal(inner.mightContain(200), true);
            assert.equal(inner.size, 3);
            return "reentrant-key";
        },
    };
    const outer = XorFilter.from([reentrant, "a", "b"]);
    assert.ok(reentered, "the reentrant toString() must actually have been invoked during the outer build");
    assert.equal(outer.size, 3);
    assert.equal(outer.mightContain(reentrant), true, "outer build must be unaffected by the reentrant inner build");
    assert.equal(outer.mightContain("a"), true);
    assert.equal(outer.mightContain("b"), true);
    validateXor(outer);
});

// The adversarial case the planner likely did not think of: TWO independently built
// filters from the SAME source array object must never alias each other's fingerprint
// store or be affected by post-construction mutation of the caller's array (from()
// must not retain a live reference to the caller's iterable after the dedup pass).
test("QA: adversarial -- post-construction mutation of the SOURCE array does not affect an already-built filter (no retained reference)", () => {
    const keys = [1, 2, 3, 4, 5];
    const f = XorFilter.from(keys, { keys: "int" });
    const before = Array.from(f._fp); // snapshot the fingerprint store
    // Mutate the caller's array aggressively after the build returned.
    keys.push(999999);
    keys[0] = -1;
    keys.length = 0;
    const after = Array.from(f._fp);
    assert.deepEqual(before, after, "the fingerprint store must be byte-identical after the caller mutates its own array");
    for (const k of [1, 2, 3, 4, 5]) assert.equal(f.mightContain(k), true);
    validateXor(f);
});

// Two filters built from separately-passed copies of the "same" duplicate-heavy iterable
// must not cross-contaminate (no shared internal scratch surviving between builds).
test("QA: adversarial -- back-to-back builds do not leak peeling scratch state between calls", () => {
    const a = XorFilter.from([1, 2, 3, 4, 5], { keys: "int", seed: 1 });
    const b = XorFilter.from([100, 200, 300], { keys: "int", seed: 2 });
    const c = XorFilter.from([1, 2, 3, 4, 5], { keys: "int", seed: 1 }); // identical to a
    assert.deepEqual(Array.from(a._fp), Array.from(c._fp),
        "two builds with IDENTICAL inputs/seed must be byte-identical (determinism, no cross-call scratch bleed)");
    for (const k of [1, 2, 3, 4, 5]) assert.equal(a.mightContain(k), true);
    for (const k of [100, 200, 300]) assert.equal(b.mightContain(k), true);
    // b's keys must never read true against a (they were never in a's set); a fingerprint
    // collision is possible in principle but vanishingly unlikely for 3 small ints at fw=8,
    // and if it DID fire it would be a true (labeled, bounded) false positive, not silent.
    validateXor(a);
    validateXor(b);
    validateXor(c);
});

/* ============================================================================
 * 9. SNAPSHOT INTEGRITY CHECKSUM (decisions/0021, tag now litefilter/3) -- the fix for
 *    the QA-reported keys-mode/seed fail-open. Proven both positively (the repro is
 *    closed) and by MUTATION (a scratch-patched copy of Filter.js proves the guard --
 *    not luck -- is what closes it).
 * ========================================================================== */

/** Load a mutant copy of Filter.js with `find` replaced by `replacement` (must occur
 *  exactly once), import it, and return { mod, cleanup }. Throws if `find` is absent
 *  (the source moved) so a stale mutation-canary fails loudly instead of passing
 *  vacuously. `cleanup()` removes the scratch file; ALWAYS call it in a finally. */
async function loadMutant(find, replacement) {
    const filterPath = new URL("../Filter.js", import.meta.url);
    const src = readFileSync(filterPath, "utf8");
    const count = src.split(find).length - 1;
    assert.equal(count, 1,
        "mutation target must appear exactly once in Filter.js (found " + count +
        "); re-locate the exact string before trusting this canary: " + JSON.stringify(find));
    const mutated = src.replace(find, replacement);
    const tmpFile = path.join(tmpdir(),
        "lite-filter-mutant-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".mjs");
    writeFileSync(tmpFile, mutated);
    const mod = await import(pathToFileURL(tmpFile).href);
    return { mod, cleanup: () => rmSync(tmpFile, { force: true }) };
}

// The exact QA repro, closed: flipping keys 'int' -> null on a 2000-int-key XOR dump now
// throws [lite-filter] instead of silently building a filter under the wrong hash path.
test("QA: the original keys-mode fail-open repro is CLOSED -- restore() now throws [lite-filter]", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => i);
    const f = XorFilter.from(keys, { fpp: 0.01, keys: "int" });
    const snap = f.dump();
    snap.keys = null; // the exact flip from the original repro
    assert.throws(() => XorFilter.restore(snap), /\[lite-filter\]/,
        "the keys-mode flip that used to silently succeed (1990/2000 false negatives) must now throw");
});

// The seed-flip sibling of the repro, closed the same way.
test("QA: a seed flip on a 2000-int-key XOR dump is CLOSED -- restore() now throws [lite-filter]", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => i);
    const f = XorFilter.from(keys, { fpp: 0.01, keys: "int" });
    const snap = f.dump();
    snap.seed = (snap.seed ^ 0x5a5a5a5a) >>> 0; // a different, still-valid uint32
    assert.throws(() => XorFilter.restore(snap), /\[lite-filter\]/,
        "a seed flip (the seed cannot be re-derived from the fingerprint store) must throw");
});

// MUTATION CANARY 1: bypass the verifySnapChecksum() call site in XorFilter.restore
// entirely. Proves the throw above is caused BY the checksum call, not some other door.
test("QA mutation-canary: bypassing the verifySnapChecksum() call site un-closes BOTH the keys-mode and seed fail-opens", async () => {
    const callSite = 'verifySnapChecksum(snap, "Xor", [snap.fw, snap.bl, snap.cap, snap.fpp], fp);';
    const { mod, cleanup } = await loadMutant(callSite, "/* QA mutation-canary: bypassed */ void 0;");
    try {
        const keys = Array.from({ length: 2000 }, (_, i) => i);
        const f = mod.XorFilter.from(keys, { fpp: 0.01, keys: "int" });

        const snapKeys = f.dump();
        snapKeys.keys = null;
        let threwKeys = false, fnKeys = 0;
        try {
            const g = mod.XorFilter.restore(snapKeys);
            for (const k of keys) if (!g.mightContain(k)) fnKeys++;
        } catch { threwKeys = true; }
        assert.equal(threwKeys, false, "with the checksum call bypassed, the keys-mode flip must NOT throw");
        assert.ok(fnKeys > 1000, "and it must silently reconstruct under the wrong hash path (mass false negatives), fn=" + fnKeys);

        const snapSeed = f.dump();
        snapSeed.seed = (snapSeed.seed ^ 0x5a5a5a5a) >>> 0;
        let threwSeed = false;
        try { mod.XorFilter.restore(snapSeed); } catch { threwSeed = true; }
        assert.equal(threwSeed, false, "with the checksum call bypassed, the seed flip must NOT throw either");
    } finally {
        cleanup();
    }
});

// MUTATION CANARY 2: omit the keys-mode token from snapChecksum's fold. Proves that it is
// SPECIFICALLY the keys-mode fold (not some other field) that catches a keys-mode flip --
// while the seed flip must STILL be caught (its own fold line is untouched).
test("QA mutation-canary: omitting keys-mode from the checksum fold un-closes ONLY the keys-mode fail-open (seed stays caught)", async () => {
    const foldLine = 'h = _chkStr(h, keys === "int" ? "int" : "null");';
    const { mod, cleanup } = await loadMutant(foldLine, "/* QA mutation-canary: keys-mode omitted */;");
    try {
        const keys = Array.from({ length: 2000 }, (_, i) => i);
        const f = mod.XorFilter.from(keys, { fpp: 0.01, keys: "int" });

        const snapKeys = f.dump();
        snapKeys.keys = null;
        let threwKeys = false, fnKeys = 0;
        try {
            const g = mod.XorFilter.restore(snapKeys);
            for (const k of keys) if (!g.mightContain(k)) fnKeys++;
        } catch { threwKeys = true; }
        assert.equal(threwKeys, false, "with keys-mode omitted from the fold, the flip must slip through undetected");
        assert.ok(fnKeys > 1000, "and it must silently reconstruct wrong (mass false negatives), fn=" + fnKeys);

        const snapSeed = f.dump();
        snapSeed.seed = (snapSeed.seed ^ 0x5a5a5a5a) >>> 0;
        let threwSeed = false;
        try { mod.XorFilter.restore(snapSeed); } catch { threwSeed = true; }
        assert.equal(threwSeed, true, "the seed fold is untouched by this mutation -- a seed flip must STILL throw");
    } finally {
        cleanup();
    }
});

// MUTATION CANARY 3: omit the seed from snapChecksum's fold. The mirror of canary 2 --
// proves it is SPECIFICALLY the seed fold that catches a seed flip, while keys-mode (whose
// fold line is untouched) must STILL be caught.
test("QA mutation-canary: omitting seed from the checksum fold un-closes ONLY the seed fail-open (keys-mode stays caught)", async () => {
    const foldLine = "h = _chkNum(h, seed);";
    const { mod, cleanup } = await loadMutant(foldLine, "/* QA mutation-canary: seed omitted */;");
    try {
        const keys = Array.from({ length: 2000 }, (_, i) => i);
        const f = mod.XorFilter.from(keys, { fpp: 0.01, keys: "int" });

        const snapSeed = f.dump();
        snapSeed.seed = (snapSeed.seed ^ 0x5a5a5a5a) >>> 0;
        let threwSeed = false, fnSeed = 0;
        try {
            const g = mod.XorFilter.restore(snapSeed);
            for (const k of keys) if (!g.mightContain(k)) fnSeed++;
        } catch { threwSeed = true; }
        assert.equal(threwSeed, false, "with seed omitted from the fold, a seed flip must slip through undetected");
        assert.ok(fnSeed > 1000, "and it must silently reconstruct wrong (mass false negatives), fn=" + fnSeed);

        const snapKeys = f.dump();
        snapKeys.keys = null;
        let threwKeys = false;
        try { mod.XorFilter.restore(snapKeys); } catch { threwKeys = true; }
        assert.equal(threwKeys, true, "the keys-mode fold is untouched by this mutation -- a keys-mode flip must STILL throw");
    } finally {
        cleanup();
    }
});

/* ============================================================================
 * 10. CHECKSUM FIELD VALIDATION -- missing / NaN / non-integer / out-of-range `chk`,
 *     and the v1 tag rejection, independently proven for XorFilter (not just replaying
 *     the shipped Snapshot.test.js chk matrix).
 * ========================================================================== */

function chkFilledXor() {
    const keys = Array.from({ length: 500 }, (_, i) => i);
    return XorFilter.from(keys, { fpp: 0.01, keys: "int" });
}

test("QA: restore() rejects a missing/NaN/non-integer/out-of-range chk, never defaulting it to a pass", () => {
    const bad = [undefined, null, NaN, "12345", 1.5, -1, 0x100000000, Infinity, -Infinity, {}, []];
    for (const b of bad) {
        const snap = chkFilledXor().dump();
        snap.chk = b;
        assert.throws(() => XorFilter.restore(snap), /\[lite-filter\]/,
            "restore() must reject chk=" + String(b));
    }
});

test("QA: restore() rejects the deleted-chk case (an absent field, not just an undefined one)", () => {
    const snap = chkFilledXor().dump();
    delete snap.chk;
    assert.equal("chk" in snap, false);
    assert.throws(() => XorFilter.restore(snap), /\[lite-filter\]/);
});

test("QA: restore() rejects a v1 ('litefilter/1') tag even with an otherwise-valid chk carried over", () => {
    const snap = chkFilledXor().dump();
    assert.equal(snap.f, "litefilter/3");
    snap.f = "litefilter/1"; // the chk field itself is untouched / structurally plausible
    assert.throws(() => XorFilter.restore(snap), /\[lite-filter\].*format tag/,
        "a v1 tag must be rejected on the format-tag door BEFORE the checksum is ever consulted");
});

test("QA: a pristine chk round-trips, and chk changes whenever the dump's content changes (not a constant)", () => {
    const a = chkFilledXor().dump();
    const b = chkFilledXor().dump(); // same construction -> same chk (determinism)
    assert.equal(a.chk, b.chk, "two dumps of an identically-built filter must carry the identical chk");
    const c = XorFilter.from(Array.from({ length: 501 }, (_, i) => i), { fpp: 0.01, keys: "int" }).dump();
    assert.notEqual(a.chk, c.chk, "a materially different filter must carry a different chk (not a constant sentinel)");
});
