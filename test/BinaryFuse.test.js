/**
 * @zakkster/lite-filter -- node:test boundary suite (Binary Fuse semantics, decisions/0022).
 *
 * Mirrors XorFilter's suite: the FINAL static member is a construction-algorithm swap over
 * XOR (overlapping fuse segments, multiply-shift selection, ~1.13x space) with the SAME
 * static build factory (from/build), the one-sided LAW (0 false negatives, which can ONLY
 * hold if the peel was COMPLETE), the width-quantized fpp() honesty, the dedup contract
 * (keys are a SET), and every fail-closed door -- the immutability throws (add/remove/clear/
 * new), the fpp floor, the empty-set door, and the 100-attempt exhaustion door.
 * validateBinaryFuse() (the structural conservation invariant) runs after building tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { BinaryFuse, VERSION } from "../Filter.js";
import { validateBinaryFuse } from "./validate.mjs";
import { differentialStaticInt } from "./torture/oracle.mjs";

test("exports: BinaryFuse is a named export; VERSION is a string", async () => {
    const mod = await import("../Filter.js");
    assert.equal(mod.BinaryFuse, BinaryFuse);
    assert.equal(typeof VERSION, "string");
});

// --- construction: static factory only ----------------------------------------

test("from: builds from a known key set; getters reflect the deduped count", () => {
    const f = BinaryFuse.from([1, 2, 3, 4, 5], { keys: "int" });
    assert.equal(f.size, 5);
    assert.equal(f.count, 5);
    assert.equal(f.capacity, 5);
    validateBinaryFuse(f);
});

test("build: is the alias of from (same contract)", () => {
    const f = BinaryFuse.build([10, 20, 30], { keys: "int" });
    assert.equal(f.size, 3);
    assert.equal(f.mightContain(10), true);
    assert.equal(f.mightContain(20), true);
    assert.equal(f.mightContain(30), true);
    validateBinaryFuse(f);
});

test("from: DEDUPES its input (keys are a SET, not multiplicity)", () => {
    const f = BinaryFuse.from([1, 1, 1, 2, 2, 3], { keys: "int" });
    assert.equal(f.size, 3, "duplicates must be collapsed to the distinct set");
    assert.equal(f.mightContain(1), true);
    assert.equal(f.mightContain(2), true);
    assert.equal(f.mightContain(3), true);
    validateBinaryFuse(f);
});

test("from: accepts any iterable (a Set, a generator)", () => {
    const s = new Set([7, 8, 9]);
    const f = BinaryFuse.from(s, { keys: "int" });
    assert.equal(f.size, 3);
    function* gen() { yield 100; yield 200; yield 300; }
    const g = BinaryFuse.from(gen(), { keys: "int" });
    assert.equal(g.size, 3);
    assert.equal(g.mightContain(200), true);
});

// --- one-sided LAWS -----------------------------------------------------------

test("law: every key in the built set ALWAYS reads true (no false negatives)", () => {
    const keys = [];
    for (let i = 0; i < 5000; i++) keys.push(i);
    const f = BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 5000; i++) {
        assert.equal(f.mightContain(i), true, "false negative on key " + i);
    }
    validateBinaryFuse(f);
});

test("law: has() is the sole alias of mightContain (same result)", () => {
    const f = BinaryFuse.from([7], { keys: "int" });
    assert.equal(f.has(7), f.mightContain(7));
    assert.equal(f.has(7), true);
    assert.equal(f.has(999999), f.mightContain(999999));
});

test("law: a never-added key is usually false; a true is a false positive", () => {
    const keys = [];
    for (let i = 0; i < 5000; i++) keys.push(i);
    const f = BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });
    let trues = 0;
    for (let i = 100000; i < 110000; i++) if (f.mightContain(i)) trues++;
    assert.ok(trues < 5000, "every probe was a false positive -- structure is broken");
});

test("bounded FPR: 0 false negatives and a measured FPR under the width-quantized ceiling (fw=8)", () => {
    const r = differentialStaticInt(BinaryFuse, { n: 50000, fpp: 0.01, probes: 500000, seed: 12345 });
    assert.equal(r.falseNegatives, 0, "no false negatives allowed");
    assert.ok(r.fpr <= 0.0050, "measured FPR " + r.fpr + " must sit under the fw=8 ceiling ~2^-8");
    assert.ok(r.fpr > 0, "measured FPR must be > 0 (non-vacuous)");
});

// --- string / default backing --------------------------------------------------

test("default backing: arbitrary (string) keys round-trip with no false negatives", () => {
    const keys = [];
    for (let i = 0; i < 2000; i++) keys.push("key:" + i);
    const f = BinaryFuse.from(keys, { fpp: 0.01 });
    for (let i = 0; i < 2000; i++) assert.equal(f.mightContain("key:" + i), true);
    validateBinaryFuse(f);
});

test("keys:'int' round-trips negative + boundary integer keys", () => {
    const keys = [];
    for (let i = -1000; i < 1000; i++) keys.push(i);
    keys.push(-2147483648, 2147483647, -0, 0);
    const f = BinaryFuse.from(keys, { keys: "int" });
    for (const k of keys) assert.equal(f.mightContain(k), true, "false negative on " + k);
    validateBinaryFuse(f);
});

// --- space: the headline (leaner than XOR) ------------------------------------

test("space: ~1.13x slots/item and <= 9.30 bits/item at n=1e6 (leaner than XOR's ~1.23x/~9.84)", () => {
    const N = 1000000;
    const keys = new Array(N);
    for (let i = 0; i < N; i++) keys[i] = i;
    const f = BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });
    const ratio = f._arrayLen / N;
    const bitsPerItem = (f._fp.byteLength * 8) / N;
    // The theoretical arity-3 load is ~1.125; ceil/segment rounding lands it at 1.1305 here.
    assert.ok(Math.round(ratio * 100) / 100 <= 1.13, "slots/item " + ratio.toFixed(4) + " must round to <= 1.13");
    assert.ok(ratio >= 1.08, "slots/item " + ratio.toFixed(4) + " must be >= 1.08 (a real filter, not degenerate)");
    assert.ok(bitsPerItem <= 9.30, "bits/item " + bitsPerItem.toFixed(3) + " must be <= 9.30 (leaner than XOR)");
    validateBinaryFuse(f);
});

// --- fpp() reporting: width-quantized 2^-fw ------------------------------------

test("fpp(): reports the width-quantized 2^-fw (fw=8 at fpp=0.01), BELOW the configured target", () => {
    const f = BinaryFuse.from([1, 2, 3], { fpp: 0.01, keys: "int" });
    assert.equal(f._fw, 8, "fpp >= 2^-8 admits an 8-bit fingerprint");
    assert.equal(f.fpp(), Math.pow(2, -8));
    assert.ok(f.fpp() < 0.01, "the byte-aligned width delivers a rate BELOW the configured 0.01");
});

test("fpp(): a tighter target widens to 16 bits (2^-16)", () => {
    const f = BinaryFuse.from([1, 2, 3], { fpp: 0.0001, keys: "int" });
    assert.equal(f._fw, 16);
    assert.equal(f.fpp(), Math.pow(2, -16));
});

// --- immutability: the static member throws fail-closed (decisions/0022) -------

test("door: add() / remove() / clear() throw [lite-filter] (a static filter has no mutation)", () => {
    const f = BinaryFuse.from([1, 2, 3], { keys: "int" });
    assert.throws(() => f.add(4), /\[lite-filter\]/);
    assert.throws(() => f.remove(1), /\[lite-filter\]/);
    assert.throws(() => f.clear(), /\[lite-filter\]/);
    assert.equal(f.size, 3);
    assert.equal(f.mightContain(1), true);
    validateBinaryFuse(f);
});

test("door: new BinaryFuse() throws [lite-filter] (build via the factory)", () => {
    assert.throws(() => new BinaryFuse(), /\[lite-filter\]/);
    assert.throws(() => new BinaryFuse(0), /\[lite-filter\]/);
    assert.throws(() => new BinaryFuse("build"), /\[lite-filter\]/);
});

// --- fail-closed DOORS (the falsifiable assertions) ---------------------------

test("door: from() over an EMPTY key set throws [lite-filter] (null is not zero)", () => {
    assert.throws(() => BinaryFuse.from([], { keys: "int" }), /\[lite-filter\]/);
    assert.throws(() => BinaryFuse.from(new Set(), { keys: "int" }), /\[lite-filter\]/);
    assert.throws(() => BinaryFuse.from([]), /\[lite-filter\]/);
});

test("door: from() with a non-iterable first argument throws [lite-filter]", () => {
    assert.throws(() => BinaryFuse.from(null), /\[lite-filter\]/);
    assert.throws(() => BinaryFuse.from(undefined), /\[lite-filter\]/);
    assert.throws(() => BinaryFuse.from(42), /\[lite-filter\]/);
});

test("door: fpp <= 0 or >= 1 throws [lite-filter] RangeError", () => {
    assert.throws(() => BinaryFuse.from([1], { fpp: 0, keys: "int" }), /\[lite-filter\].*fpp/);
    assert.throws(() => BinaryFuse.from([1], { fpp: -0.1, keys: "int" }), /\[lite-filter\].*fpp/);
    assert.throws(() => BinaryFuse.from([1], { fpp: 1, keys: "int" }), /\[lite-filter\].*fpp/);
    assert.throws(() => BinaryFuse.from([1], { fpp: 2, keys: "int" }), /\[lite-filter\].*fpp/);
});

test("door: fpp below the 16-bit floor (2^-16) throws [lite-filter] RangeError", () => {
    assert.throws(() => BinaryFuse.from([1], { fpp: Math.pow(2, -16) / 2, keys: "int" }), /\[lite-filter\].*16 bits/);
    assert.throws(() => BinaryFuse.from([1], { fpp: 1e-7, keys: "int" }), /\[lite-filter\].*16 bits/);
});

test("door: fpp AT the 8-bit / 16-bit boundaries selects the expected width", () => {
    const at8 = BinaryFuse.from([1, 2], { fpp: Math.pow(2, -8), keys: "int" });
    assert.equal(at8._fw, 8, "fpp == 2^-8 fits an 8-bit fingerprint");
    const at16 = BinaryFuse.from([1, 2], { fpp: Math.pow(2, -16), keys: "int" });
    assert.equal(at16._fw, 16, "fpp == 2^-16 fits a 16-bit fingerprint (the floor is inclusive)");
});

test("door: the 100-attempt exhaustion throws [lite-filter] on a DEGENERATE key set", () => {
    assert.throws(() => BinaryFuse.from([{}, {}]), /\[lite-filter\]/);
    assert.throws(() => BinaryFuse.from([{}, {}, {}, {}], { seed: 7 }),
        /could not construct/, "the exhaustion door names the peeling failure");
});

test("door: int key out of 32-bit range throws [lite-filter] TypeError in from() and mightContain()", () => {
    assert.throws(() => BinaryFuse.from([2 ** 31], { keys: "int" }), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => BinaryFuse.from([1.5], { keys: "int" }), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => BinaryFuse.from([1, null, 3], { keys: "int" }), /\[lite-filter\].*keys:'int'/);
    const f = BinaryFuse.from([1, 2, 3], { keys: "int" });
    assert.throws(() => f.mightContain(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.mightContain(NaN), /\[lite-filter\].*keys:'int'/);
});

test("door: unknown keys / stats option fails closed with a did-you-mean hint", () => {
    assert.throws(() => BinaryFuse.from([1], { keys: "ints" }), /did you mean 'int'\?/);
    assert.throws(() => BinaryFuse.from([1], { stats: 1 }), /did you mean true\?/);
});

test("door: a non-finite seed fails closed", () => {
    assert.throws(() => BinaryFuse.from([1], { keys: "int", seed: NaN }), /\[lite-filter\].*seed/);
});

// --- opt-in stats -------------------------------------------------------------

test("stats: OFF by default -- accessors fail closed", () => {
    const f = BinaryFuse.from([1, 2, 3], { keys: "int" });
    assert.throws(() => f.stats(), /\[lite-filter\]/);
    assert.throws(() => f.resetStats(), /\[lite-filter\]/);
});

test("stats: ON counts queries/hits/misses (adds stays 0 -- build is not add())", () => {
    const f = BinaryFuse.from([1, 2], { keys: "int", stats: true });
    assert.equal(f.mightContain(1), true);
    f.mightContain(999999);
    const s = f.stats();
    assert.equal(s.adds, 0, "a static filter records no adds");
    assert.equal(s.queries, 2);
    assert.equal(s.hits >= 1, true);
    f.resetStats();
    assert.equal(f.stats().queries, 0);
});

// --- boundary matrix (the small-n clamp, decisions/0022) -----------------------

test("boundary: n=1 builds and behaves correctly (segLen=4, segCount=1, 12 slots)", () => {
    const f = BinaryFuse.from([42], { keys: "int" });
    assert.equal(f.size, 1);
    assert.equal(f._segLen, 4);
    assert.equal(f._segCount, 1);
    assert.equal(f._arrayLen, 12);
    assert.equal(f.mightContain(42), true);
    validateBinaryFuse(f);
});

test("boundary: n=2 shares the small-n clamp with n=1 (segLen=4, segCount=1, 12 slots)", () => {
    const f = BinaryFuse.from([1, 2], { keys: "int" });
    assert.equal(f.size, 2);
    assert.equal(f._segLen, 4);
    assert.equal(f._segCount, 1);
    assert.equal(f._arrayLen, 12);
    assert.equal(f.mightContain(1), true);
    assert.equal(f.mightContain(2), true);
    validateBinaryFuse(f);
});

test("boundary: n=3 builds correctly (segLen=8)", () => {
    const f = BinaryFuse.from([1, 2, 3], { keys: "int" });
    assert.equal(f.size, 3);
    assert.equal(f._segLen, 8);
    for (const k of [1, 2, 3]) assert.equal(f.mightContain(k), true);
    validateBinaryFuse(f);
});

test("boundary: a large set peels within the reseed budget (0 false negatives)", () => {
    const r = differentialStaticInt(BinaryFuse, { n: 200000, fpp: 0.01, probes: 1, seed: 999 });
    assert.equal(r.falseNegatives, 0);
});

// --- snapshot / restore (decisions/0005, 0022) --------------------------------

function filledBf(opts) {
    const keys = [];
    for (let i = 0; i < 1000; i++) keys.push(i);
    return BinaryFuse.from(keys, opts);
}

test("dump/restore: exact round-trip preserves membership + count + fingerprint store", () => {
    const f = filledBf({ fpp: 0.01, keys: "int" });
    const g = BinaryFuse.restore(f.dump());
    assert.equal(g.size, f.size);
    for (let i = 0; i < 1000; i++) assert.equal(g.mightContain(i), f.mightContain(i));
    validateBinaryFuse(g);
});

test("dump: round-trips through JSON and structuredClone", () => {
    const f = filledBf({ fpp: 0.01, keys: "int" });
    const snap = f.dump();
    const viaJson = BinaryFuse.restore(JSON.parse(JSON.stringify(snap)));
    const viaClone = BinaryFuse.restore(structuredClone(snap));
    for (let i = 0; i < 1000; i++) {
        assert.equal(viaJson.mightContain(i), true);
        assert.equal(viaClone.mightContain(i), true);
    }
    validateBinaryFuse(viaJson);
    validateBinaryFuse(viaClone);
});

test("dump: the tag shape is stable and self-describing (mem + fw + sl + sc + fp)", () => {
    const snap = filledBf({ fpp: 0.01, keys: "int" }).dump();
    assert.equal(snap.f, "litefilter/3");
    assert.equal(snap.mem, "BinaryFuse");
    assert.equal(snap.fw, 8);
    assert.equal(typeof snap.sl, "number");
    assert.equal(typeof snap.sc, "number");
    assert.ok(Array.isArray(snap.fp));
    assert.equal(snap.fp.length, (snap.sc + 2) * snap.sl);
    assert.equal(snap.keys, "int");
});

test("restore door: member mismatch fails closed", () => {
    const snap = filledBf({ keys: "int" }).dump();
    snap.mem = "Xor";
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\].*member/);
});

test("restore door: bad format tag / seed / keys / count fail closed", () => {
    const s1 = filledBf({ keys: "int" }).dump(); s1.f = "litefilter/1";
    assert.throws(() => BinaryFuse.restore(s1), /\[lite-filter\].*format tag/);
    const s2 = filledBf({ keys: "int" }).dump(); s2.seed = 1.5;
    assert.throws(() => BinaryFuse.restore(s2), /\[lite-filter\].*seed/);
    const s3 = filledBf({ keys: "int" }).dump(); delete s3.keys;
    assert.throws(() => BinaryFuse.restore(s3), /\[lite-filter\].*keys mode/);
    const s4 = filledBf({ keys: "int" }).dump(); s4.count = 0;
    assert.throws(() => BinaryFuse.restore(s4), /\[lite-filter\].*count/);
    assert.throws(() => BinaryFuse.restore(null), /\[lite-filter\]/);
    assert.throws(() => BinaryFuse.restore(42), /\[lite-filter\]/);
});

test("restore door: fingerprint-width (fw) mismatch fails closed", () => {
    const snap = filledBf({ fpp: 0.01, keys: "int" }).dump();
    snap.fw = 16;
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\].*fingerprint-width/);
});

test("restore door: segment-length (sl) mismatch fails closed", () => {
    const snap = filledBf({ keys: "int" }).dump();
    snap.sl = snap.sl * 2;
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\].*segment-length/);
});

test("restore door: segment-count (sc) mismatch fails closed", () => {
    const snap = filledBf({ keys: "int" }).dump();
    snap.sc = snap.sc + 1;
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\].*segment-count/);
});

test("restore door: an internally-inconsistent-but-legal sl/sc/fp.length triple is REJECTED by re-derivation from count", () => {
    // The CHARTER-SIGNATURE fail-open hunt: hand-craft a snapshot whose sl, sc, and fp.length
    // are all MUTUALLY consistent (fp.length === (sc+2)*sl) so a naive range/length check
    // passes -- but do NOT match what _bfDims(count) derives. restore() must re-derive the
    // geometry FROM the count and reject, never build a wrong-shaped filter that drops keys.
    const snap = filledBf({ keys: "int" }).dump();
    const badSl = snap.sl * 2;               // still a legal power-of-two segment length
    const badSc = snap.sc;                    // legal count
    snap.sl = badSl;
    snap.sc = badSc;
    snap.fp = new Array((badSc + 2) * badSl).fill(0); // internally consistent length!
    assert.equal(snap.fp.length, (snap.sc + 2) * snap.sl, "the crafted triple is internally consistent");
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\].*segment/,
        "an internally-consistent geometry that disagrees with _bfDims(count) must be rejected");
});

test("restore door: a short / oversized fingerprint store is REJECTED, never truncated", () => {
    const shortSnap = filledBf({ keys: "int" }).dump();
    shortSnap.fp = shortSnap.fp.slice(0, shortSnap.fp.length - 1);
    assert.throws(() => BinaryFuse.restore(shortSnap), /\[lite-filter\].*fingerprint store/);
    const longSnap = filledBf({ keys: "int" }).dump();
    longSnap.fp = longSnap.fp.concat([0]);
    assert.throws(() => BinaryFuse.restore(longSnap), /\[lite-filter\].*fingerprint store/);
});

test("restore door: an out-of-range / non-integer fingerprint word is REJECTED, never coerced", () => {
    for (const bad of [256, -1, 1.5, NaN, "5", null, undefined]) {
        const snap = filledBf({ fpp: 0.01, keys: "int" }).dump();
        snap.fp[0] = bad;
        assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\]/,
            "restore() must reject a corrupt fingerprint word " + String(bad));
    }
});

test("restore door: EVERY word (and the full length) is validated BEFORE any slot is written", () => {
    const snap = filledBf({ keys: "int" }).dump();
    snap.fp[snap.fp.length - 1] = 999;
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\]/);
});

test("restore door: a keys-mode flip is REJECTED by the integrity checksum", () => {
    const snap = filledBf({ keys: "int" }).dump();
    snap.keys = null;
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\]/);
});

test("restore opts: stats can be re-derived on restore", () => {
    const snap = filledBf({ keys: "int" }).dump();
    const g = BinaryFuse.restore(snap, { stats: true });
    g.mightContain(1);
    assert.equal(g.stats().queries, 1);
});
