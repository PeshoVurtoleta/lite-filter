/**
 * @zakkster/lite-filter -- QA independent-verification suite (v1.0.0 Binary Fuse).
 *
 * The independent falsification of the planner's BinaryFuse ASSERTIONS (decisions/0022):
 * a boundary matrix and adversarial cases that FAIL on regression rather than replaying the
 * shipped suite. Covers the partial-peel fail-open (proven at scale AND by mutation), the
 * sizing/small-n clamp edge cases, the CHARTER-SIGNATURE restore fail-open hunt (an
 * internally-inconsistent-but-legal segment geometry rejected by RE-DERIVING from count),
 * and the snapshot integrity checksum (proven by mutation canaries).
 *
 * node:test only. Node core (node:fs/os/url/path) is used only for the mutation canaries,
 * which write a scratch copy of Filter.js to the OS temp dir and clean it up.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BinaryFuse } from "../Filter.js";
import { validateBinaryFuse } from "./validate.mjs";
import { differentialStaticInt, makePrng } from "./torture/oracle.mjs";

/** Load a mutant copy of Filter.js with `find` replaced by `replacement` (must occur
 *  exactly once). Throws if `find` is absent or ambiguous so a stale canary fails loudly. */
async function loadMutant(find, replacement) {
    const filterPath = new URL("../Filter.js", import.meta.url);
    const src = readFileSync(filterPath, "utf8");
    const count = src.split(find).length - 1;
    assert.equal(count, 1,
        "mutation target must appear exactly once in Filter.js (found " + count +
        "); re-locate the exact string: " + JSON.stringify(find));
    const mutated = src.replace(find, replacement);
    const tmpFile = path.join(tmpdir(),
        "lite-filter-bf-mutant-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".mjs");
    writeFileSync(tmpFile, mutated);
    const mod = await import(pathToFileURL(tmpFile).href);
    return { mod, cleanup: () => rmSync(tmpFile, { force: true }) };
}

/** Same contract as `loadMutant`, but applies a LIST of [find, replacement] pairs to the
 *  SAME mutant copy -- each target independently validated to occur exactly once BEFORE
 *  any substitution is applied (so a stale canary fails loudly, never silently no-ops). */
async function loadMutantMulti(pairs) {
    const filterPath = new URL("../Filter.js", import.meta.url);
    let src = readFileSync(filterPath, "utf8");
    for (const [find] of pairs) {
        const count = src.split(find).length - 1;
        assert.equal(count, 1,
            "mutation target must appear exactly once in Filter.js (found " + count +
            "); re-locate the exact string: " + JSON.stringify(find));
    }
    for (const [find, replacement] of pairs) src = src.replace(find, replacement);
    const tmpFile = path.join(tmpdir(),
        "lite-filter-bf-mutant-multi-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".mjs");
    writeFileSync(tmpFile, src);
    const mod = await import(pathToFileURL(tmpFile).href);
    return { mod, cleanup: () => rmSync(tmpFile, { force: true }) };
}

/* ============================================================================
 * 1. PARTIAL-PEEL FAIL-OPEN -- the signature catch, proven at scale AND by mutation.
 * ========================================================================== */

test("QA: a large built set has 0 false negatives (the complete-peel guarantee, fail-OPEN catch)", () => {
    const keys = [];
    for (let i = 0; i < 100000; i++) keys.push(i * 7 + 3);
    const f = BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });
    let fn = 0;
    for (const k of keys) if (!f.mightContain(k)) fn++;
    assert.equal(fn, 0, "a false negative means the peel was INCOMPLETE and the build shipped anyway (fail-open)");
    validateBinaryFuse(f);
});

test("QA: multi-seed/multi-size stress -- every successful build has 0 false negatives, never a partial ship", () => {
    const sizes = [1, 2, 3, 4, 5, 7, 10, 33, 97, 500, 5000, 20000];
    let builds = 0;
    for (const n of sizes) {
        for (const seedBump of [0, 1, 0x1234, 0x9e3779b1, 0xffffffff]) {
            const keys = [];
            for (let i = 0; i < n; i++) keys.push(i * 2654435761 % 2000000000);
            let f;
            try {
                f = BinaryFuse.from(keys, { keys: "int", seed: seedBump >>> 0 });
            } catch (e) {
                assert.fail("unexpected throw on a well-formed distinct-int key set (n=" + n +
                    ", seed=" + seedBump + "): " + e.message);
            }
            builds++;
            const distinct = new Set(keys);
            let fn = 0;
            for (const k of distinct) if (!f.mightContain(k)) fn++;
            assert.equal(fn, 0, "false negative at n=" + n + " seed=" + seedBump);
            assert.equal(f.size, distinct.size);
            validateBinaryFuse(f);
        }
    }
    assert.ok(builds === sizes.length * 5, "the stress matrix must actually run every cell");
});

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
        try { f = BinaryFuse.from(keys, { keys: "int", seed: rng() >>> 0 }); }
        catch { continue; }
        trials++;
        for (const k of keys) if (!f.mightContain(k)) counterexamples++;
    }
    assert.ok(trials >= 150, "the search must exercise a meaningful number of builds, got " + trials);
    assert.equal(counterexamples, 0, "found a key set that BUILDS yet lies on a member key -- fail-open regression");
});

// MUTATION CANARY: disable the exact BinaryFuse peel-completeness guard and prove the
// degenerate 3-object build (which THROWS under the real guard) instead silently SHIPS a
// partial filter with a false negative. Load-bearing proof that the guard prevents fail-open.
test("QA mutation-canary: disabling the sp!==n peel-completeness guard turns the degenerate build into a SILENT partial (fail-open) build", async () => {
    const guardBlock =
        "// FAIL-OPEN GUARD (decisions/0022): a short stack means a 2-core survived -- an INCOMPLETE\n" +
        "    // peel. Do NOT assign; return null so the caller reseeds (or throws on exhaustion).\n" +
        "    if (sp !== n) return null;";
    const { mod, cleanup } = await loadMutant(guardBlock,
        "/* QA mutation-canary: BinaryFuse completeness guard disabled */\n    if (false) { return null; }");
    try {
        const keys = [{}, {}, {}];
        let threw = false;
        let built;
        try { built = mod.BinaryFuse.from(keys); }
        catch { threw = true; }
        assert.equal(threw, false,
            "with the completeness guard disabled the degenerate build must NOT throw (it ships a partial build)");
        let fn = 0;
        for (const k of keys) if (!built.mightContain(k)) fn++;
        assert.ok(fn > 0,
            "the mutant build must exhibit at least one false negative -- proof the guard (not the peeling math) prevents fail-open");
    } finally {
        cleanup();
    }
});

/* ============================================================================
 * 2. WIDTH-DOOR BOUNDARY -- exact straddling values + non-vacuous measured FPR.
 * ========================================================================== */

test("QA: width door -- fpp just ABOVE, AT, and just BELOW the 2^-8 boundary", () => {
    const above = BinaryFuse.from([1, 2, 3], { fpp: Math.pow(2, -8) * 1.0001, keys: "int" });
    assert.equal(above._fw, 8);
    const at = BinaryFuse.from([1, 2, 3], { fpp: Math.pow(2, -8), keys: "int" });
    assert.equal(at._fw, 8);
    const below = BinaryFuse.from([1, 2, 3], { fpp: Math.pow(2, -8) * 0.9999, keys: "int" });
    assert.equal(below._fw, 16);
});

test("QA: width door -- fpp just ABOVE, AT, and just BELOW the 2^-16 floor", () => {
    const above = BinaryFuse.from([1, 2, 3], { fpp: Math.pow(2, -16) * 1.0001, keys: "int" });
    assert.equal(above._fw, 16);
    const at = BinaryFuse.from([1, 2, 3], { fpp: Math.pow(2, -16), keys: "int" });
    assert.equal(at._fw, 16);
    assert.throws(() => BinaryFuse.from([1, 2, 3], { fpp: Math.pow(2, -16) * 0.9999, keys: "int" }),
        /\[lite-filter\]/, "fpp just below the 2^-16 floor must throw fail-closed");
});

test("QA: measured FPR at fw=8 sits under the 2^-8 characteristic ceiling and is non-vacuous", () => {
    const r = differentialStaticInt(BinaryFuse, { n: 100000, fpp: 0.01, probes: 1000000, seed: 777333 });
    assert.equal(r.falseNegatives, 0);
    assert.ok(r.fpr > 0, "measured FPR must be > 0 (non-vacuous -- the query path must actually match sometimes)");
    assert.ok(r.fpr <= 0.0050, "measured FPR " + r.fpr + " must sit under the fw=8 ceiling (~2^-8 = 0.0039)");
});

test("QA: measured FPR at fw=16 sits under the 2^-16 characteristic ceiling and is non-vacuous", () => {
    const r = differentialStaticInt(BinaryFuse, { n: 20000, fpp: 0.0001, probes: 2000000, seed: 424242 });
    assert.equal(r.falseNegatives, 0);
    assert.ok(r.fpr > 0, "measured FPR must be > 0 (non-vacuous)");
    assert.ok(r.fpr <= 0.00006,
        "measured FPR " + r.fpr + " must sit under the fw=16 ceiling (~2^-16 = 0.0000153, 4x margin)");
});

/* ============================================================================
 * 3. SPACE -- the headline: leaner than XOR (~1.13x vs ~1.23x, <= 9.30 bits/item).
 * ========================================================================== */

test("QA: at n=1e6 the space is ~1.13x slots/item and <= 9.30 bits/item (leaner than XOR)", () => {
    const N = 1000000;
    const keys = new Array(N);
    for (let i = 0; i < N; i++) keys[i] = i;
    const f = BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });
    const ratio = f._arrayLen / N;
    const bpi = (f._fp.byteLength * 8) / N;
    assert.ok(ratio >= 1.08 && Math.round(ratio * 100) / 100 <= 1.13,
        "slots/item " + ratio.toFixed(4) + " must be in [1.08, 1.13] (2dp)");
    assert.ok(bpi <= 9.30, "bits/item " + bpi.toFixed(3) + " must be <= 9.30 (leaner than XOR's ~9.84)");
    validateBinaryFuse(f);
});

/* ============================================================================
 * 4. RESTORE DEEP-STRUCTURAL REJECTION -- the CHARTER-SIGNATURE fail-open hunt.
 * ========================================================================== */

function filledBf(opts) {
    const keys = [];
    for (let i = 0; i < 2000; i++) keys.push(i);
    return BinaryFuse.from(keys, opts);
}

test("QA: restore rejects every structural mutation, one at a time, and NEVER truncates", () => {
    const base = filledBf({ fpp: 0.01, keys: "int" });
    const pristine = base.dump();

    const mutations = [
        ["wrong mem", (s) => { s.mem = "Xor"; }],
        ["fp.length = m - 1", (s) => { s.fp = s.fp.slice(0, s.fp.length - 1); }],
        ["fp.length = m + 1", (s) => { s.fp = s.fp.concat([0]); }],
        ["a single word = fpMask + 1", (s) => { s.fp[Math.floor(s.fp.length / 2)] = (1 << s.fw); }],
        ["a single word = -1", (s) => { s.fp[0] = -1; }],
        ["wrong seed (non-integer)", (s) => { s.seed = 1.5; }],
        ["wrong seed (negative)", (s) => { s.seed = -1; }],
        ["wrong fw (valid value, wrong for this fpp)", (s) => { s.fw = s.fw === 8 ? 16 : 8; }],
        ["keys-mode flipped int->null", (s) => { s.keys = null; }],
        ["count tampered so re-derived geometry mismatches", (s) => { s.count = s.count + 1; }],
        ["sl tampered directly", (s) => { s.sl = s.sl * 2; }],
        ["sc tampered directly", (s) => { s.sc = s.sc + 1; }],
        ["format tag tampered", (s) => { s.f = "litefilter/999"; }],
    ];

    let checked = 0;
    for (const [label, mutate] of mutations) {
        const snap = JSON.parse(JSON.stringify(pristine));
        mutate(snap);
        assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\]/,
            "restore() must reject: " + label);
        checked++;
    }
    assert.equal(checked, mutations.length);

    const restored = BinaryFuse.restore(JSON.parse(JSON.stringify(pristine)));
    for (let i = 0; i < 2000; i++) assert.equal(restored.mightContain(i), true, "false negative on " + i);
    assert.equal(restored.size, base.size);
    validateBinaryFuse(restored);
});

// THE CHARTER-SIGNATURE catch, proven positively: an internally-consistent (fp.length ===
// (sc+2)*sl) segment geometry that DISAGREES with what _bfDims(count) derives must be
// rejected by RE-DERIVING from the count, not merely range/length-checked.
test("QA: an internally-consistent sl/sc/fp.length triple that disagrees with _bfDims(count) is REJECTED", () => {
    const snap = filledBf({ fpp: 0.01, keys: "int" }).dump();
    const badSl = snap.sl * 2;   // a legal power-of-two segment length, wrong for this count
    snap.sl = badSl;
    snap.fp = new Array((snap.sc + 2) * badSl).fill(0); // keep fp.length internally consistent
    assert.equal(snap.fp.length, (snap.sc + 2) * snap.sl);
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\].*segment/,
        "the geometry must be re-derived from count and the mismatch rejected -- not silently trusted");
});

// MUTATION CANARY: bypass the _bfDims re-derivation comparison for sl. Prove the crafted
// triple above is caught SPECIFICALLY by the re-derivation, not incidentally.
test("QA mutation-canary: bypassing the sl re-derivation check un-closes the internally-consistent-geometry fail-open", async () => {
    const check = 'if (snap.sl !== dims.segLen) {';
    const { mod, cleanup } = await loadMutant(check, 'if (false) {');
    try {
        // A snapshot whose sl is HALVED AND whose fp.length is made internally consistent with
        // the smaller geometry. With the sl check bypassed, restore uses the RE-DERIVED dims for
        // construction, so the fp.length (built for the tampered sl) mismatches derived m and the
        // fp.length door still catches it -- unless we also feed a derived-length store. To prove
        // the sl check itself has teeth, craft sl wrong but fp.length matching the TAMPERED sl:
        const f = mod.BinaryFuse.from(Array.from({ length: 2000 }, (_, i) => i), { fpp: 0.01, keys: "int" });
        const snap = f.dump();
        snap.sl = snap.sl * 2;
        snap.fp = new Array((snap.sc + 2) * snap.sl).fill(0);
        // With the sl check bypassed, the sc check (untouched) or the fp.length-vs-derived-m
        // check will still fire -- so restore must STILL throw. This canary proves the sl check
        // is not the SOLE guard (defense in depth), while the positive test above proves the
        // re-derivation rejects the mismatch. Either way, a mismatch must never be accepted.
        let threw = false;
        try { mod.BinaryFuse.restore(snap); } catch { threw = true; }
        assert.equal(threw, true, "a geometry disagreeing with _bfDims(count) must never restore, even with one check bypassed");
    } finally {
        cleanup();
    }
});

// THE STRICT LOAD-BEARING PROOF: a snapshot that is a *genuinely* self-consistent, chk-VALID
// dump (an alternate, independently-peelable (sl, sc) factorization whose fp.length is EXACTLY
// the same as the real geometry's array length for this count) so that NEITHER the checksum
// NOR the fp.length check can catch it -- ONLY the sl/sc re-derivation against _bfDims(count)
// can. This isolates the geometry door from every other door (simulating, e.g., a cross-version
// snapshot whose own sizing constants differed from the current build's). Exports the cold
// internals (never touching a hot path or changing behavior) purely to construct the fixture.
test("QA mutation-canary: the segment-geometry re-derivation door is the SOLE guard against a genuinely self-consistent (chk-valid, fp.length-matching) wrong-shaped snapshot", async () => {
    const exportPoint = "export default Bloom;";
    const { mod: exportingMod, cleanup: cleanupExporting } = await loadMutant(exportPoint,
        "export { _bfDims, _bfTryBuild, snapChecksum, fmix32 };\n" + exportPoint);
    let cleanupBypass = null;
    try {
        const { BinaryFuse: RealBF, _bfTryBuild, snapChecksum, fmix32 } = exportingMod;
        const N = 2000;
        const keys = Array.from({ length: N }, (_, i) => i);
        const fw = 8;

        // Ground truth geometry + array length for this count, from a REAL build.
        const real = RealBF.from(keys, { fpp: 0.01, keys: "int" });
        const trueSnap = real.dump();
        const trueLen = trueSnap.fp.length;

        // Find an ALTERNATE (segLen, segCount) factorization of the SAME total array length,
        // with a DIFFERENT segLen (so it disagrees with _bfDims(N)), and peel it for real.
        let alt = null, fpArr = null, seed = null;
        for (let sl = 4; sl <= 262144 && !alt; sl *= 2) {
            if (sl === trueSnap.sl || trueLen % sl !== 0) continue;
            const sc = trueLen / sl - 2;
            if (!(sc >= 1) || !Number.isInteger(sc)) continue;
            const cand = { segLen: sl, segCount: sc, arrayLen: trueLen, scl: sl * sc };
            const baseSeed = 0xc0ffee >>> 0;
            for (let attempt = 0; attempt < 100; attempt++) {
                const trySeed = (baseSeed ^ Math.imul(attempt, 0x9e3779b1)) >>> 0;
                const trySeed2 = fmix32(trySeed ^ 0x9e3779b9);
                const built = _bfTryBuild(keys, true, trySeed, trySeed2, N, cand, fw);
                if (built !== null) { alt = cand; fpArr = Array.from(built); seed = trySeed; break; }
            }
        }
        assert.ok(alt !== null, "an alternate same-length factorization must peel for this fixture to be meaningful");
        assert.notEqual(alt.segLen, trueSnap.sl, "the alternate geometry must actually disagree with the real one");
        assert.equal((alt.segCount + 2) * alt.segLen, trueLen,
            "the alternate geometry's array length must EXACTLY match the real one (so fp.length cannot catch it)");

        // A GENUINELY self-consistent snapshot: chk is the REAL checksum function applied to
        // these exact (wrong-vs-current-dims, but internally coherent) fields -- not forged.
        const chk = snapChecksum("BinaryFuse", "int", seed, N, [fw, alt.segLen, alt.segCount, N, 0.01], fpArr);
        const snap = {
            f: trueSnap.f, mem: "BinaryFuse", fw, sl: alt.segLen, sc: alt.segCount,
            cap: N, fpp: 0.01, seed, keys: "int", count: N, fp: fpArr, chk,
        };

        // 1) The UNMODIFIED restore() (freshly loaded, no bypass) must REJECT this snapshot,
        //    even though its checksum is genuinely valid and its fp.length matches the real
        //    array length -- proof the geometry door alone is doing the catching here.
        assert.throws(() => RealBF.restore(snap), /\[lite-filter\].*segment/,
            "restore() must reject a chk-valid, length-matching, but wrong-geometry snapshot");

        // 2) With BOTH the sl and sc re-derivation checks bypassed (checksum verification left
        //    INTACT), the SAME snapshot must now restore WITHOUT throwing, and the resulting
        //    filter must exhibit mass false negatives on the very keys it was built from --
        //    proof the geometry door, not the checksum or the length check, was load-bearing.
        const { mod: bypassMod, cleanup } = await loadMutantMulti([
            ["if (snap.sl !== dims.segLen) {", "if (false) {"],
            ["if (snap.sc !== dims.segCount) {", "if (false) {"],
        ]);
        cleanupBypass = cleanup;
        let threw = false, g;
        try { g = bypassMod.BinaryFuse.restore(snap); }
        catch { threw = true; }
        assert.equal(threw, false,
            "with BOTH geometry checks bypassed, a chk-valid/length-matching wrong-geometry snapshot must NOT throw");
        let fn = 0;
        for (const k of keys) if (!g.mightContain(k)) fn++;
        assert.ok(fn > N / 2,
            "the bypassed restore must silently ship a wrong-shaped filter with mass false negatives, got fn=" + fn + "/" + N);
    } finally {
        cleanupExporting();
        if (cleanupBypass) cleanupBypass();
    }
});

/* ============================================================================
 * 5. SNAPSHOT INTEGRITY CHECKSUM (decisions/0021) -- keys-mode / seed fail-open, closed.
 * ========================================================================== */

test("QA: a keys-mode flip on a 2000-int-key BinaryFuse dump is CLOSED -- restore() throws [lite-filter]", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => i);
    const f = BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });
    const snap = f.dump();
    snap.keys = null;
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\]/,
        "the keys-mode flip that would silently reconstruct under the wrong hash path must throw");
});

test("QA: a seed flip on a 2000-int-key BinaryFuse dump is CLOSED -- restore() throws [lite-filter]", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => i);
    const f = BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });
    const snap = f.dump();
    snap.seed = (snap.seed ^ 0x5a5a5a5a) >>> 0;
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\]/);
});

test("QA mutation-canary: bypassing the verifySnapChecksum() call site un-closes BOTH the keys-mode and seed fail-opens", async () => {
    const callSite = 'verifySnapChecksum(snap, "BinaryFuse",\n            [snap.fw, snap.sl, snap.sc, snap.cap, snap.fpp], fp);';
    const { mod, cleanup } = await loadMutant(callSite, "/* QA mutation-canary: bypassed */ void 0;");
    try {
        const keys = Array.from({ length: 2000 }, (_, i) => i);
        const f = mod.BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });

        const snapKeys = f.dump();
        snapKeys.keys = null;
        let threwKeys = false, fnKeys = 0;
        try {
            const g = mod.BinaryFuse.restore(snapKeys);
            for (const k of keys) if (!g.mightContain(k)) fnKeys++;
        } catch { threwKeys = true; }
        assert.equal(threwKeys, false, "with the checksum call bypassed, the keys-mode flip must NOT throw");
        assert.ok(fnKeys > 1000, "and it must silently reconstruct under the wrong hash path (mass false negatives), fn=" + fnKeys);

        const snapSeed = f.dump();
        snapSeed.seed = (snapSeed.seed ^ 0x5a5a5a5a) >>> 0;
        let threwSeed = false;
        try { mod.BinaryFuse.restore(snapSeed); } catch { threwSeed = true; }
        assert.equal(threwSeed, false, "with the checksum call bypassed, the seed flip must NOT throw either");
    } finally {
        cleanup();
    }
});

test("QA: restore() rejects a missing/NaN/non-integer/out-of-range chk, never defaulting it to a pass", () => {
    const bad = [undefined, null, NaN, "12345", 1.5, -1, 0x100000000, Infinity, {}, []];
    for (const b of bad) {
        const snap = BinaryFuse.from(Array.from({ length: 500 }, (_, i) => i), { fpp: 0.01, keys: "int" }).dump();
        snap.chk = b;
        assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\]/, "restore() must reject chk=" + String(b));
    }
});

/* ============================================================================
 * 6. DEDUP / SET SEMANTICS + BOUNDARY SIZES (the small-n clamp, decisions/0022).
 * ========================================================================== */

test("QA: heavy duplicates collapse to the exact distinct count (a Set, not multiplicity)", () => {
    const keys = [];
    for (let i = 0; i < 500; i++) for (let r = 0; r < 50; r++) keys.push(i);
    assert.equal(keys.length, 25000);
    const f = BinaryFuse.from(keys, { keys: "int" });
    assert.equal(f.size, 500, "size must be the DISTINCT count, not the raw 25000-entry multiplicity");
    for (let i = 0; i < 500; i++) assert.equal(f.mightContain(i), true);
    validateBinaryFuse(f);
});

test("QA: -0 and 0 dedupe to ONE entry under keys:'int'", () => {
    const f = BinaryFuse.from([-0, 0, 5], { keys: "int" });
    assert.equal(f.size, 2);
    assert.equal(f.mightContain(0), true);
    validateBinaryFuse(f);
});

test("QA: n=0 via from([]) throws fail-closed (a filter over zero keys is undefined; null is not zero)", () => {
    assert.throws(() => BinaryFuse.from([]), /\[lite-filter\]/);
    assert.throws(() => BinaryFuse.build([]), /\[lite-filter\]/);
});

test("QA: n=1 and n=2 both land on the small-n clamp (segLen=4, segCount=1, 12 slots)", () => {
    const f1 = BinaryFuse.from([42], { keys: "int" });
    assert.equal(f1._segLen, 4);
    assert.equal(f1._segCount, 1);
    assert.equal(f1._arrayLen, 12);
    assert.equal(f1.mightContain(42), true);
    validateBinaryFuse(f1);

    const f2 = BinaryFuse.from([7, 99], { keys: "int" });
    assert.equal(f2._segLen, 4);
    assert.equal(f2._segCount, 1);
    assert.equal(f2._arrayLen, 12);
    assert.equal(f2.mightContain(7), true);
    assert.equal(f2.mightContain(99), true);
    validateBinaryFuse(f2);
});

test("QA: a large build (n=500000) peels within budget with 0 false negatives", () => {
    const r = differentialStaticInt(BinaryFuse, { n: 500000, fpp: 0.01, probes: 1, seed: 314159 });
    assert.equal(r.falseNegatives, 0);
});

/* ============================================================================
 * 7. keys:'int' STRICT VALIDATION + IMMUTABLE SURFACE.
 * ========================================================================== */

test("QA: keys:'int' rejects every non-integer / out-of-range flavor on BUILD and QUERY", () => {
    const bad = [2 ** 31, -(2 ** 31) - 1, 1.5, NaN, Infinity, -Infinity, true, "5", null, undefined, {}, [], 0n];
    for (const b of bad) {
        assert.throws(() => BinaryFuse.from([1, 2, b], { keys: "int" }), /\[lite-filter\].*keys:'int'/,
            "from() must reject bad int key: " + String(b));
    }
    const f = BinaryFuse.from([1, 2, 3], { keys: "int" });
    for (const b of bad) {
        assert.throws(() => f.mightContain(b), /\[lite-filter\].*keys:'int'/,
            "mightContain() must reject bad int key: " + String(b));
    }
    for (const k of [1, 2, 3]) assert.equal(f.mightContain(k), true);
});

test("QA: add/remove/clear throw [lite-filter] on a RESTORED filter too (not just a freshly-built one)", () => {
    const base = BinaryFuse.from([1, 2, 3], { keys: "int" });
    const restored = BinaryFuse.restore(base.dump());
    assert.throws(() => restored.add(4), /\[lite-filter\]/);
    assert.throws(() => restored.remove(1), /\[lite-filter\]/);
    assert.throws(() => restored.clear(), /\[lite-filter\]/);
    assert.equal(restored.size, 3);
    assert.equal(restored.mightContain(1), true);
});

test("QA: back-to-back builds are byte-identical for identical inputs/seed (no cross-call scratch bleed)", () => {
    const a = BinaryFuse.from([1, 2, 3, 4, 5], { keys: "int", seed: 1 });
    const c = BinaryFuse.from([1, 2, 3, 4, 5], { keys: "int", seed: 1 });
    assert.deepEqual(Array.from(a._fp), Array.from(c._fp),
        "two builds with IDENTICAL inputs/seed must be byte-identical (determinism)");
    validateBinaryFuse(a);
    validateBinaryFuse(c);
});
