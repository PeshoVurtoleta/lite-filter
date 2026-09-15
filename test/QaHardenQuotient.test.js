/**
 * QA hardening pass for @zakkster/lite-filter Quotient (v0.5.0), run OUT-OF-TREE against the
 * real Filter.js. node:test only. Mirrors the QaAuditQuotient.test.js idiom but targets cases
 * that suite + Quotient.test.js + torture.mjs do not exercise. Some of these are EXPECTED TO
 * PASS (confirming sound behavior); one (QAH-DEFECT) is EXPECTED TO FAIL against the shipped
 * code -- it reproduces a real restore() validation gap and is the QA-FAILED artifact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Quotient } from "../Filter.js";
import { validateQuotient } from "./validate.mjs";

/* ============================================================================
 * QAH-DEFECT: restore() accepts a snapshot with p === r (quotient width 0), which is
 * IMPOSSIBLE for any legitimately-constructed Quotient (quotientSizeFor floors q at 1, so
 * p = q0 + r >= r + 1 always). The validation door only checks `snap.p < snap.r` (rejects
 * p < r) but ALLOWS p === r through. Restoring with p===r sets pMask === rMask, so every
 * future add()/mightContain() computes quotient = (hv >>> r) & qMask = 0 always -- a
 * restored instance silently returns FALSE for every key that was present before the dump,
 * a total false-negative corruption, with NO thrown error.
 * ========================================================================== */
test("QAH-DEFECT: restore() must reject p===r (quotient width 0 is impossible) -- currently fails open", () => {
    const f = new Quotient(50, { fpp: 0.1, keys: "int" });
    for (let i = 0; i < 30; i++) f.add(i);
    const snap = f.dump();
    assert.ok(snap.p > snap.r, "test setup: a legitimately-built filter always has p > r (q0 >= 1)");

    const bad = JSON.parse(JSON.stringify(snap));
    bad.p = bad.r; // quotient width 0 -- impossible for any real Quotient
    assert.throws(
        () => Quotient.restore(bad, { keys: "int" }),
        /\[lite-filter\]/,
        "restore() must REJECT p===r as corrupt (q0 = p - r must be >= 1); " +
        "it currently accepts it and produces a silently-corrupted instance"
    );
});

test("QAH-DEFECT-b: demonstrates the consequence when the door is NOT tightened -- 100% false negatives post-restore", () => {
    const f = new Quotient(50, { fpp: 0.1, keys: "int" });
    for (let i = 0; i < 30; i++) f.add(i);
    const snap = f.dump();
    const bad = JSON.parse(JSON.stringify(snap));
    bad.p = bad.r;
    let restored;
    try {
        restored = Quotient.restore(bad, { keys: "int" });
    } catch {
        return; // if the door is fixed, this test is moot -- QAH-DEFECT above is the gate
    }
    let fn = 0;
    for (let i = 0; i < 30; i++) if (!restored.mightContain(i)) fn++;
    assert.equal(fn, 0, "a wrongly-accepted p===r snapshot must not false-negative every key " +
        "(measured " + fn + "/30 false negatives -- proves the fail-open is exploitable)");
});

/* ============================================================================
 * Boundary matrix additions not covered by QaAuditQuotient / Quotient.test.js / torture.mjs
 * ========================================================================== */

// N=1 restore round trip (shipped suite tests N=1 add/remove but not dump/restore at N=1).
test("QAH boundary: N=1 dump/restore round-trips membership exactly", () => {
    const f = new Quotient(1, { keys: "int" });
    f.add(9);
    const snap = f.dump();
    const g = Quotient.restore(snap, { keys: "int" });
    assert.equal(g.mightContain(9), true);
    assert.equal(g.size, 1);
    validateQuotient(g);
});

// Exact load-ceiling boundary: maxLoad-1, maxLoad, maxLoad+1 (N-1/N/N+1 on the ceiling itself,
// with distinct keys so we hit the ceiling counter, not the guard-shift path).
test("QAH boundary: the exact maxLoad-1 / maxLoad / maxLoad+1 add-count boundary", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int", seed: 0xa1 });
    const maxLoad = f._maxLoad;
    let i = 0;
    // Fill to exactly maxLoad-1 successful adds without throwing (best-effort: distinct keys
    // rarely all land before the ceiling counter fires exactly at maxLoad, so assert the
    // ceiling fires at or after maxLoad, never before).
    let added = 0;
    let threwAt = -1;
    try {
        for (; i < maxLoad + 5000; i++) { f.add(i); added++; }
    } catch (e) {
        threwAt = added;
        assert.match(e.message, /\[lite-filter\]/);
    }
    assert.notEqual(threwAt, -1, "test setup: must reach the ceiling");
    // The ceiling check is `count >= maxLoad` BEFORE any mutation, so exactly `maxLoad`
    // adds succeed and the (maxLoad+1)-th throws -- the real N/N+1 boundary, not a tautology.
    assert.equal(threwAt, maxLoad, "exactly maxLoad adds must succeed before the ceiling throws");
    assert.ok(f.size <= maxLoad, "size must never exceed maxLoad: size=" + f.size + " maxLoad=" + maxLoad);
    assert.ok(f.size >= maxLoad - 1, "the ceiling must allow filling to at least maxLoad-1: size=" + f.size);
    validateQuotient(f);
});

// r+3=16 vs r+3=17 exact boundary (Uint16 vs throw).
test("QAH boundary: r+3=16 constructs a Uint16Array store; the next fpp step (r+3=17) throws", () => {
    // r=13 -> r+3=16 (fits). fpp just above 2^-13 forces r=13.
    const okFpp = 1 / Math.pow(2, 13) + 1e-12;
    const f = new Quotient(10, { fpp: okFpp, keys: "int" });
    assert.equal(f._r, 13, "test setup: expected r=13 at the floor");
    assert.equal(f._store.constructor.name, "Uint16Array");
    f.add(1);
    assert.equal(f.mightContain(1), true);

    // fpp just BELOW 2^-13 needs r=14 -> r+3=17 -> throws.
    const badFpp = 1 / Math.pow(2, 13) - 1e-12;
    assert.throws(() => new Quotient(10, { fpp: badFpp, keys: "int" }), /\[lite-filter\].*remainder width/);
});

// r+3<=8 vs r+3=9 boundary (Uint8 vs Uint16), the other byte-alignment step, for completeness.
test("QAH boundary: r+3<=8 constructs a Uint8Array store; r+3=9 upgrades to Uint16Array", () => {
    const f8 = new Quotient(10, { fpp: 0.2, keys: "int" }); // expect small r
    assert.ok(f8._r + 3 <= 8, "test setup: expected r+3<=8 at fpp=0.2, got r=" + f8._r);
    assert.equal(f8._store.constructor.name, "Uint8Array");

    // Find the smallest fpp step that pushes r+3 to 9 (r=6): fpp just ABOVE 1/64 so
    // 1/fpp is just under 64 -> ceil(log2(~64)) = 6.
    const f16 = new Quotient(10, { fpp: 1 / 64 + 1e-9, keys: "int" });
    assert.equal(f16._r, 6, "test setup: expected r=6");
    assert.equal(f16._store.constructor.name, "Uint16Array");
});

// GROW then SHRINK chained resize -- membership preserved through BOTH transitions.
test("QAH resize: GROW then SHRINK chained -- membership survives both transitions", () => {
    const f = new Quotient(2000, { fpp: 0.01, keys: "int", seed: 0x51 });
    const keys = [];
    for (let i = 0; i < 1500; i++) { f.add(i); keys.push(i); }
    f.resize(20000); // grow
    for (const k of keys) assert.equal(f.mightContain(k), true, "lost after grow: " + k);
    assert.equal(f.size, keys.length);
    f.resize(1600); // shrink back down (still >= count)
    for (const k of keys) assert.equal(f.mightContain(k), true, "lost after shrink: " + k);
    assert.equal(f.size, keys.length);
    validateQuotient(f);
});

// merge() of two filters each filled to JUST UNDER the ceiling -- must grow to hold both,
// exact combined size, 0 false negatives.
test("QAH merge: two filters each just under their own ceiling merge to exact combined size", () => {
    const A = new Quotient(200, { fpp: 0.05, keys: "int", seed: 7 });
    const B = new Quotient(200, { fpp: 0.05, keys: "int", seed: 7 });
    let ai = 0, bi = 100000;
    while (A.size < A._maxLoad - 1) { A.add(ai); ai++; }
    while (B.size < B._maxLoad - 1) { B.add(bi); bi++; }
    const expected = A.size + B.size;
    const aKeys = [];
    for (let k = 0; k < ai; k++) aKeys.push(k);
    const bKeys = [];
    for (let k = 100000; k < bi; k++) bKeys.push(k);
    A.merge(B);
    assert.equal(A.size, expected, "merge must be exactly additive (multiplicity, no dedup)");
    for (const k of aKeys) assert.equal(A.mightContain(k), true, "A key lost: " + k);
    for (const k of bKeys) assert.equal(A.mightContain(k), true, "B key lost: " + k);
    validateQuotient(A);
});

// Duplicate-heavy stream driving the ceiling throw -- multiplicity consequence: the SAME key
// added repeatedly still consumes one slot per add and reaches the ceiling exactly like
// distinct keys, and the throw is still byte-identical.
test("QAH ceiling: a duplicate-heavy (single-key) stream reaches the ceiling and throws byte-identical", () => {
    const f = new Quotient(64, { fpp: 0.01, keys: "int" });
    let n = 0;
    try {
        for (;;) { f.add(42); n++; }
    } catch (e) {
        assert.match(e.message, /\[lite-filter\]/);
    }
    assert.ok(n >= 1, "test setup: at least one add must succeed");
    assert.equal(f.size, n, "every prior add of the SAME key must still count (multiplicity)");
    const before = Array.from(f._store);
    const sizeBefore = f.size;
    assert.throws(() => f.add(42), /\[lite-filter\]/);
    assert.deepEqual(Array.from(f._store), before, "thrown duplicate add must be byte-identical");
    assert.equal(f.size, sizeBefore);
    for (let i = 0; i < n; i++) assert.equal(f.mightContain(42), true);
    validateQuotient(f);
});

// stats accuracy across add/remove/clear.
test("QAH stats: adds/queries/hits/misses stay accurate across add/remove/clear", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int", stats: true });
    for (let i = 0; i < 100; i++) f.add(i);
    assert.equal(f.stats().adds, 100);
    let hits = 0, misses = 0;
    for (let i = 0; i < 100; i++) if (f.mightContain(i)) hits++;
    for (let i = 1000; i < 1100; i++) if (!f.mightContain(i)) misses++;
    assert.equal(f.stats().queries, 200);
    assert.equal(f.stats().hits, hits);
    assert.equal(f.stats().misses, misses);
    assert.equal(hits, 100);
    assert.equal(misses, 100);
    f.clear();
    assert.equal(f.stats().adds, 100, "clear() does not reset cumulative stats (documented)");
    f.resetStats();
    assert.equal(f.stats().adds, 0);
});

// dump -> restore -> dump idempotence (byte-identical second snapshot).
test("QAH snapshot: dump -> restore -> dump is idempotent (byte-identical snapshots)", () => {
    const f = new Quotient(500, { fpp: 0.02, keys: "int", seed: 0x77 });
    for (let i = 0; i < 300; i++) f.add(i);
    for (let i = 0; i < 50; i++) f.remove(i);
    const snap1 = f.dump();
    const g = Quotient.restore(snap1, { keys: "int" });
    const snap2 = g.dump();
    assert.deepEqual(snap1, snap2, "a restore -> dump round trip must reproduce byte-identical state");
});

// clear() same-ArrayBuffer reuse (identity, not just value equality).
test("QAH clear: reuses the SAME store ArrayBuffer identity (zero-alloc contract)", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 200; i++) f.add(i);
    const buf = f._store.buffer;
    f.clear();
    assert.equal(f._store.buffer, buf, "clear() must reuse the same ArrayBuffer, not allocate a new one");
    assert.equal(f.size, 0);
    assert.equal(f._store.every((w) => w === 0), true);
});

// A genuine run-scan MISS (not a fingerprint collision): remove() on an occupied home whose
// run does not contain the queried remainder -- must return false and mutate NOTHING.
test("QAH remove: a genuine run-scan miss (occupied home, remainder absent) returns false and mutates nothing", () => {
    const f = new Quotient(64, { fpp: 0.01, keys: "int", seed: 0x22 });
    // Fill several keys sharing spread-out quotients so some homes are occupied.
    for (let i = 0; i < 20; i++) f.add(i);
    const before = Array.from(f._store);
    const sizeBefore = f.size;
    // Probe many candidate keys; keep ones whose home IS occupied but whose specific
    // remainder is NOT present in the run (a genuine scan-miss, not an absent-home miss).
    let missKey = null;
    for (let k = 1000; k < 200000; k++) {
        const hv = (function fmix32(h) {
            h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
            h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0;
        })((k ^ f._seed) | 0) & f._pMask;
        const r = hv & f._rMask;
        const q = (hv >>> f._r) & f._qMask;
        if ((f._store[q] & 1) !== 0 && !f.mightContain(k)) { missKey = k; break; }
    }
    assert.notEqual(missKey, null, "test setup: expected an occupied-home / absent-remainder key");
    assert.equal(f.remove(missKey), false, "a genuine run-scan miss must return false");
    assert.deepEqual(Array.from(f._store), before, "a false remove must mutate NOTHING");
    assert.equal(f.size, sizeBefore);
});

// restore(): unsorted run (#homes==#runs holds, but remainders not sorted) -- deep structural
// case distinct from the shipped suite's "lone continuation" + "shifted cluster start".
test("QAH restore: rejects an unsorted run (in-range words, homes==runs, but remainders decrease)", () => {
    const f = new Quotient(1000, { fpp: 0.05, keys: "int", seed: 0x33 });
    // Build a real 2-element run by finding two keys with the same quotient, different
    // remainders, then swap the stored order to break sortedness while keeping continuation
    // metadata otherwise valid.
    function fmix32(h) {
        h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0;
    }
    // Split (quotient high bits, remainder low bits per decisions/0016).
    function realSplit(k) {
        const hv = fmix32((k ^ f._seed) | 0) & f._pMask;
        const r = hv & f._rMask;
        const q = (hv >>> f._r) & f._qMask;
        return { q, r };
    }
    let A = null, B = null, tA = null, tB = null;
    outer:
    for (let a = 0; a < 20000; a++) {
        const ta = realSplit(a);
        for (let b = a + 1; b < 20000; b++) {
            const tb = realSplit(b);
            if (tb.q === ta.q && tb.r !== ta.r) { A = a; B = b; tA = ta; tB = tb; break outer; }
        }
    }
    assert.notEqual(A, null, "test setup: expected two distinct-remainder same-quotient keys");
    f.add(Math.min(tA.r, tB.r) === tA.r ? A : B); // insert the smaller-remainder key first
    f.add(Math.min(tA.r, tB.r) === tA.r ? B : A); // then the larger -> a real sorted 2-run
    const snap = f.dump();
    const store = snap.store.slice();
    // Locate the run (home q, home slot + one continuation slot) and swap remainders to
    // break sortedness while leaving continuation/occupied bits alone.
    const q = tA.q;
    let s = q;
    while ((store[s] & 2) !== 0) s--; // walk back to run start (shouldn't be needed here)
    const head = q;
    const cont = q + 1;
    assert.ok((store[cont] & 2) !== 0, "test setup: expected slot q+1 to be the continuation");
    const headRem = store[head] >>> 3;
    const contRem = store[cont] >>> 3;
    assert.ok(headRem < contRem, "test setup: expected a sorted run before corruption");
    // Swap the remainders (metadata bits stay put) -> run becomes unsorted (decreasing).
    const headMeta = store[head] & 7, contMeta = store[cont] & 7;
    store[head] = (contRem << 3) | headMeta;
    store[cont] = (headRem << 3) | contMeta;
    assert.throws(() => Quotient.restore(Object.assign({}, snap, { store }), { keys: "int" }),
        /\[lite-filter\].*(corrupt slot structure|not sorted)/,
        "an unsorted run must be rejected by the deep structural check");
});

// wrong seed on restore (fails via the structural/metadata-set check, not silently loaded).
test("QAH restore: a wrong (but validly-shaped) seed is REJECTED by the integrity checksum (decisions/0021) -- it can no longer silently reconstruct a desynced filter", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int", seed: 111 });
    for (let i = 0; i < 50; i++) f.add(i);
    const snap = f.dump();
    const bad = Object.assign({}, snap, { seed: 222 }); // valid uint32, but not the one that built the store
    // Before v0.6.0 this SILENTLY reconstructed a desynced filter (seed cannot be cross-
    // checked against opaque slot data). The family-wide snapshot checksum (decisions/0021)
    // folds the seed into `chk`, so a flipped seed now fails closed rather than shipping a
    // wrong filter -- the fix for the QA-reported fail-open (same class as the keys-mode flip).
    assert.throws(() => Quotient.restore(bad, { keys: "int" }), /\[lite-filter\].*checksum/,
        "a wrong seed must be rejected by the integrity checksum, not silently trusted");
});

// wrong r on merge (mismatched fpp -> mismatched r) must reject, even though q/nslots differ too.
test("QAH merge: a mismatched remainder width r (different fpp) rejects even at matching seed/keys", () => {
    const A = new Quotient(1000, { fpp: 0.01, keys: "int", seed: 9 });
    const B = new Quotient(1000, { fpp: 0.001, keys: "int", seed: 9 }); // different r
    assert.notEqual(A._r, B._r, "test setup: fpp difference must produce a different r");
    assert.throws(() => A.merge(B), /\[lite-filter\].*merge/);
});

// Isolates the r-check from the p-check: two filters engineered to share the SAME fixed bit
// budget p (so a p-only guard would NOT catch the mismatch) but a DIFFERENT r (and therefore
// a different q) -- the r-check must reject this independently of the p-check.
test("QAH merge: same p, DIFFERENT r/q (engineered) still rejects -- the r-check is not merely implied by the p-check", () => {
    const A = new Quotient(8, { fpp: 0.03125, keys: "int", seed: 9 });   // r=5, q=4, p=9
    const B = new Quotient(64, { fpp: 0.25, keys: "int", seed: 9 });    // r=2, q=7, p=9
    assert.equal(A._p, B._p, "test setup: both filters must share the SAME fixed bit budget p");
    assert.notEqual(A._r, B._r, "test setup: but a DIFFERENT remainder width r");
    assert.throws(() => A.merge(B), /\[lite-filter\].*merge/,
        "a same-p/different-r pair must still be rejected -- the r-check must not be redundant-only");
});

// truncated / over-long store on restore (both directions).
test("QAH restore: a truncated store and an over-long store are BOTH rejected, never sliced/padded", () => {
    const f = new Quotient(500, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 100; i++) f.add(i);
    const snap = f.dump();
    const short = { ...snap, store: snap.store.slice(0, snap.store.length - 10) };
    const long = { ...snap, store: snap.store.concat([0, 0, 0]) };
    assert.throws(() => Quotient.restore(short, { keys: "int" }), /corrupt slot store/);
    assert.throws(() => Quotient.restore(long, { keys: "int" }), /corrupt slot store/);
});

// out-of-range remainder (word encodes a remainder wider than r bits, but metadata nonzero).
test("QAH restore: an out-of-range remainder (exceeds r bits) in an occupied slot is rejected", () => {
    const f = new Quotient(500, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 100; i++) f.add(i);
    const snap = f.dump();
    const store = snap.store.slice();
    const rMask = (1 << snap.r) - 1;
    const maxWord = ((rMask << 3) | 7) >>> 0;
    // Overflow the remainder field beyond r bits while keeping metadata plausible.
    let idx = store.findIndex((w) => (w & 7) !== 0);
    store[idx] = maxWord + 8; // remainder now (rMask+1), out of range
    assert.throws(() => Quotient.restore(Object.assign({}, snap, { store }), { keys: "int" }),
        /corrupt slot word/);
});

// a snapshot with occ-count bumped to MATCH but a structurally impossible layout
// (#homes != #runs): two occupied homes in one cluster but only one run present.
test("QAH restore: occ-count matches count, but #homes != #runs (a continuation slot fabricated as ALSO a home) is rejected", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int", seed: 0x44 });
    let x = 99 >>> 0;
    const rng = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
    // Drive enough churn to guarantee at least one multi-element run (a continuation slot).
    for (let i = 0; i < 400; i++) f.add(rng() % 100);
    const snap = f.dump();
    const store = snap.store.slice();
    // Find a slot that is a CONTINUATION but not yet OCCUPIED (its meta is already nonzero,
    // so setting is_occupied does NOT change the metadata-set count -- isolating the
    // #homes==#runs structural check specifically, not the flat count check).
    let idx = -1;
    for (let i = 0; i < store.length; i++) {
        if ((store[i] & 2) !== 0 && (store[i] & 1) === 0) { idx = i; break; }
    }
    assert.notEqual(idx, -1, "test setup: expected at least one continuation slot (a multi-element run)");
    store[idx] |= 1; // fabricate an extra "home" inside an existing run without a new run
    assert.throws(() => Quotient.restore(Object.assign({}, snap, { store }), { keys: "int" }),
        /\[lite-filter\].*(corrupt slot structure|occupied homes but)/,
        "an occupied-count/run-count mismatch must be rejected (REJECT never truncate)");
});
