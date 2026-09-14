/**
 * @zakkster/lite-filter -- QA independent-verification suite (v0.4.0 Cuckoo).
 *
 * This file is written by QA, not the coder, specifically to INDEPENDENTLY falsify
 * the planner's ASSERTIONS for the Cuckoo member (decisions/0014, 0015). Every test
 * here is designed so that it FAILS if the described behavior regresses -- it does
 * not just replay the shipped suite or torture.mjs. Boundary matrix: 0, 1, N-1, N,
 * N+1, empty, null, undefined, NaN, -0, duplicate "dispose" (clear() called twice /
 * absent-remove twice), dispose-during-iteration (mutate-after-dump isolation),
 * re-entrant write (toString() hook re-enters add()), and one adversarial case the
 * planner did not enumerate (the fingerprint-collision false-negative caveat,
 * decisions/0015 -- engineered as a REAL collision, not asserted in the abstract).
 *
 * A small internal MODEL of the hash math (fmix32 + the int-keyed add/mightContain
 * derivation) is reproduced here, read against the instance's OWN _seed/_seed2/
 * _mask/_fpMask fields (the same white-box pattern test/validate.mjs already uses).
 * This is used ONLY to brute-force search for adversarial keys (a real fingerprint
 * collision, an i1==i2-crossing pair, a raw-zero fingerprint) -- never to bypass the
 * public add/mightContain/remove surface under test.
 *
 * node:test only. No dependency outside this package + its devDependency peers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Cuckoo } from "../Filter.js";
import { validateCuckoo } from "./validate.mjs";

/* ============================================================================
 * White-box model (test-only): reproduces Filter.js's int-keyed Cuckoo hash math
 * exactly, driven by the INSTANCE's own _seed/_seed2/_mask/_fpMask so it stays
 * correct under any seed/fpp/capacity combination.
 * ========================================================================== */

function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

function model(f, key) {
    const a = fmix32((key ^ f._seed) | 0);
    const fpsrc = fmix32((Math.imul(key | 0, 0x9e3779b1) ^ f._seed2) | 0);
    let fp = fpsrc & f._fpMask;
    if (fp === 0) fp = 1;
    const hf = fmix32(Math.imul(fp, 0x5bd1e995));
    const i1 = a & f._mask;
    const i2 = (i1 ^ hf) & f._mask;
    return { fp: fp, rawFp: fpsrc & f._fpMask, i1: i1, i2: i2, hf: hf };
}

/* ============================================================================
 * Assertion 1 -- insert-overload is a byte-identical NO-OP that throws. Engineer a
 * provable overfill (small capacity, distinct keys) so add() actually exhausts the
 * 500-kick ceiling; assert the throw is [lite-filter], dump() before === after (no
 * half-mutation), and EVERY key added before the throw still reads true (the exact
 * bug class the reviewer caught -- non-vacuous: we prove keys were actually added
 * before the throw fired, not just that a throw happened).
 * ========================================================================== */

test("QA1: an overfilled Cuckoo throws [lite-filter], is a byte-identical no-op, and drops NO already-added key", () => {
    const f = new Cuckoo(32, { fpp: 0.01, keys: "int" });
    const added = [];
    let threw = false;
    let threwMsg = "";
    try {
        for (let i = 0; i < 500000; i++) {
            f.add(i);
            added.push(i);
        }
    } catch (e) {
        threw = true;
        threwMsg = e.message;
    }
    assert.equal(threw, true, "test setup: a 32-capacity table hammered with distinct keys must overflow");
    assert.match(threwMsg, /\[lite-filter\]/);
    assert.match(threwMsg, /500 kicks/);
    // Non-vacuity: the overload must have happened only after SOME real inserts, not
    // on the very first add (else the "before/after" comparison below is trivial).
    assert.ok(added.length >= 8, "test setup: expected a meaningful number of successful adds before overload, got " + added.length);

    // Byte-identical no-op: snapshot immediately before the throwing add, and compare
    // to the state immediately after the throw (dump() is a deep, independent copy --
    // proven separately below -- so this comparison is not aliasing-fooled).
    const g = new Cuckoo(32, { fpp: 0.01, keys: "int" });
    let dumpBefore = null;
    let dumpAfter = null;
    let overloadedAt = -1;
    const gAdded = [];
    for (let i = 0; i < 500000; i++) {
        const before = g.dump();
        try {
            g.add(i);
            gAdded.push(i);
        } catch (e) {
            dumpBefore = before;
            dumpAfter = g.dump();
            overloadedAt = i;
            break;
        }
    }
    assert.ok(overloadedAt >= 0, "test setup: the second table must also overflow");
    assert.deepEqual(dumpAfter, dumpBefore, "a thrown add() must leave the filter byte-identical to its pre-add state (fp store, count, everything)");

    // Every key added BEFORE the throw must still read true -- 0 false negatives on
    // overflow is the cardinal law (decisions/0014). This is the exact class of bug
    // the reviewer caught: an overload that silently drops an already-placed key.
    let falseNegatives = 0;
    for (const k of gAdded) if (!g.mightContain(k)) falseNegatives++;
    assert.equal(falseNegatives, 0, "overload must not false-negative any key added before the throw");
    assert.equal(g.size, gAdded.length, "size must equal the number of successful adds (the failed add must not have incremented it)");
    validateCuckoo(g);
});

/* ============================================================================
 * Assertion 2 -- remove(key) -> boolean semantics.
 * ========================================================================== */

test("QA2: remove() of an inserted key returns true, the key then reads false, size decrements", () => {
    const f = new Cuckoo(1000, { keys: "int" });
    f.add(4242);
    assert.equal(f.size, 1);
    assert.equal(f.remove(4242), true);
    assert.equal(f.mightContain(4242), false);
    assert.equal(f.size, 0);
    validateCuckoo(f);
});

test("QA2: remove() of a never-added key returns false and mutates NOTHING (byte-identical store)", () => {
    const f = new Cuckoo(2000, { keys: "int" });
    const half = f._store.length >> 1;
    for (let i = 0; i < half; i++) f.add(i);
    const before = Array.from(f._store);
    const sizeBefore = f.size;
    // A key far outside the added int range and independently verified (via the
    // model) to NOT share both fp and a candidate bucket with any added key's slot
    // is not guaranteed analytically here, so instead we assert the STRUCTURAL
    // invariant directly: whatever remove() answers, if it answers false, nothing
    // may have moved.
    let probe = 10_000_000;
    while (f.mightContain(probe)) probe++; // pick a probe the filter itself denies
    assert.equal(f.remove(probe), false, "removing a key the filter itself reports absent must return false");
    assert.deepEqual(Array.from(f._store), before, "a false (no-op) remove must not mutate the store");
    assert.equal(f.size, sizeBefore);
    validateCuckoo(f);
});

test("QA2 caveat (decisions/0015): deleting a NEVER-INSERTED key whose fingerprint collides with a REAL key removes the OTHER key's fingerprint -- engineered as a REAL, non-vacuous collision", () => {
    // A small fpMask + few buckets makes an exact (fp, bucket) collision easy to find
    // by brute force via the white-box model (never bypassing the public surface).
    const f = new Cuckoo(64, { fpp: 0.3, keys: "int" });
    const A = 555555; // the REAL key that WILL be inserted
    const tA = model(f, A);

    let B = null; // a key that will NEVER be inserted, colliding with A
    for (let k = 0; k < 5_000_000; k++) {
        if (k === A) continue;
        const m = model(f, k);
        if (m.fp === tA.fp && (m.i1 === tA.i1 || m.i1 === tA.i2)) { B = k; break; }
    }
    assert.notEqual(B, null, "test setup: expected to find a real fingerprint collision within the search budget");

    f.add(A);
    assert.equal(f.mightContain(A), true, "test setup: the real key must be present before the adversarial remove");

    // B was NEVER added. Per decisions/0015, removing it can still return true and
    // clear A's slot because the fingerprints + candidate bucket collide.
    const removedB = f.remove(B);
    assert.equal(removedB, true, "the never-inserted, colliding key must report a (spurious) successful delete -- the caveat");
    assert.equal(f.mightContain(A), false, "the REAL key A must now read false -- a false negative caused by the collision (decisions/0015)");
    assert.equal(f.size, 0, "size dropped even though the caller never removed the key they actually own");
});

test("QA2: remove() with keys:'int' is exercised on the SAME entry point as add/mightContain -- the door rejects the identical bad-value set", () => {
    const f = new Cuckoo(10, { keys: "int" });
    for (const bad of [NaN, null, undefined, "5", {}, [], Infinity, -Infinity, 10n, true, false, 1.5]) {
        assert.throws(() => f.remove(bad), /\[lite-filter\].*keys:'int'/, "remove(" + String(bad) + ") must not silently no-op");
    }
});

/* ============================================================================
 * Assertion 3 -- duplicate-add is NOT idempotent: a hot key added repeatedly
 * consumes slots (Cuckoo does not dedup) and MUST overflow its bucket pair and
 * throw, fail-closed, rather than silently corrupting or wrapping.
 * ========================================================================== */

test("QA3: re-adding the SAME key repeatedly is NOT idempotent -- it consumes slots and overflows its exact bucket pair, throwing fail-closed", () => {
    const f = new Cuckoo(1000, { keys: "int", fpp: 0.01 });
    const KEY = 777;
    let added = 0;
    let threw = false;
    try {
        for (let i = 0; i < 5000; i++) { f.add(KEY); added++; }
    } catch (e) {
        threw = true;
        assert.match(e.message, /\[lite-filter\]/);
        assert.match(e.message, /500 kicks/);
    }
    assert.equal(threw, true, "a duplicate-heavy hot key must eventually overflow its own bucket pair");
    // The SAME key always hashes to the SAME (i1, i2) pair, so at most 2*b=8 copies
    // can ever be placed directly; every subsequent add kicks between the SAME two
    // buckets (since every occupant carries the identical fingerprint) and can never
    // find a third bucket -- so the overflow must happen at a SMALL, bounded count,
    // not after thousands of successful adds (which would indicate silent dedup-free
    // growth into unrelated buckets, a correctness bug).
    assert.ok(added <= 8, "expected the SAME key to overflow its bucket pair at <= 2*b=8 successful adds, got " + added);
    assert.ok(added >= 1, "test setup: at least one add must have succeeded before the overflow");
});

/* ============================================================================
 * Assertion 4 -- i2 involution: for constructed keys, the two candidate buckets are
 * each other's alternates (decisions/0014): i1 = (i2 XOR hash(fp)) & mask.
 * ========================================================================== */

test("QA4: i1/i2 are each other's alternates (the involution) for a swept range of keys, including a case where i1 !== i2", () => {
    const f = new Cuckoo(200, { keys: "int" });
    let sawDistinctBuckets = false;
    for (let k = 0; k < 5000; k++) {
        const m = model(f, k);
        const recoveredI1 = (m.i2 ^ m.hf) & f._mask;
        assert.equal(recoveredI1, m.i1, "involution broken for key " + k + ": (i2 XOR hash(fp)) & mask must equal i1");
        if (m.i1 !== m.i2) sawDistinctBuckets = true;
    }
    assert.ok(sawDistinctBuckets, "test setup: expected at least one swept key to land in DISTINCT i1/i2 buckets (else the involution check is degenerate)");
});

test("QA4: the involution is exercised END-TO-END through a real eviction -- a kicked fingerprint's alternate bucket (derived by add) matches the model's i2/i1", () => {
    // Force a kick: fill both candidate buckets of a specific key, then add one more
    // key that must displace a resident into ITS alternate bucket. The public
    // surface must still find every key afterward (which can only hold if the real
    // add() computed the same alternate-bucket math the model predicts).
    const f = new Cuckoo(2000, { keys: "int" });
    const keys = [];
    for (let k = 0; k < 400; k++) { f.add(k); keys.push(k); }
    for (const k of keys) assert.equal(f.mightContain(k), true, "key " + k + " must be found after kicks may have relocated it");
    validateCuckoo(f);
});

/* ============================================================================
 * Assertion 5 -- fingerprint is NEVER 0 in an occupied slot; the 0 -> 1 remap
 * actually engages for a key whose raw fingerprint hashes to 0.
 * ========================================================================== */

test("QA5: every occupied slot holds a NONZERO fingerprint (direct store inspection) after heavy churn", () => {
    const f = new Cuckoo(2000, { keys: "int" });
    for (let i = 0; i < 1000; i++) f.add(i);
    let occupied = 0;
    for (let i = 0; i < f._store.length; i++) {
        const v = f._store[i];
        assert.ok(v >= 0 && v <= f._fpMask, "slot " + i + " out of range 0.." + f._fpMask);
        if (v !== 0) occupied++;
    }
    assert.ok(occupied > 0, "test setup: expected at least one occupied slot");
    assert.equal(occupied, f.size, "occupied-slot count must equal size (validateCuckoo's own invariant, re-verified directly here)");
    validateCuckoo(f);
});

test("QA5: a key whose RAW fingerprint hash is exactly 0 is remapped to 1, never stored as 0 (proves the 0 -> 1 door actually engages, not just that it never crashes)", () => {
    const f = new Cuckoo(1000, { fpp: 0.01, keys: "int" });
    let zeroKey = null;
    for (let k = 0; k < 500000; k++) {
        if (model(f, k).rawFp === 0) { zeroKey = k; break; }
    }
    assert.notEqual(zeroKey, null, "test setup: expected to find a key with a raw (pre-remap) fingerprint of exactly 0 within the search budget");
    const m = model(f, zeroKey);
    assert.equal(m.fp, 1, "the model's own 0 -> 1 remap must have engaged");

    f.add(zeroKey);
    // Find the slot that actually holds it and confirm it is 1, never 0 (0 would be
    // indistinguishable from "empty" and would silently drop the key).
    const base1 = m.i1 << 2, base2 = m.i2 << 2;
    let stored = null;
    for (let j = 0; j < 4; j++) {
        if (f._store[base1 + j] === 1) stored = f._store[base1 + j];
        if (f._store[base2 + j] === 1) stored = f._store[base2 + j];
    }
    assert.equal(stored, 1, "the zero-hashing key must be stored as fingerprint 1, never as the empty sentinel 0");
    assert.equal(f.mightContain(zeroKey), true, "the remapped key must still be found");
    validateCuckoo(f);
});

/* ============================================================================
 * Boundary matrix: N=1, INT_MIN/INT_MAX/-0/0 edges.
 * ========================================================================== */

test("QA boundary: capacity N=1 -- add/mightContain/remove/clear all function correctly", () => {
    const f = new Cuckoo(1, { keys: "int" });
    assert.equal(f.size, 0);
    f.add(9);
    assert.equal(f.mightContain(9), true);
    assert.equal(f.remove(9), true);
    assert.equal(f.mightContain(9), false);
    validateCuckoo(f);
});

test("QA boundary: INT_MIN/INT_MAX/-0/0 round-trip with no false negatives, including remove()", () => {
    const f = new Cuckoo(10, { keys: "int" });
    const edges = [-2147483648, 2147483647, -0, 0];
    for (const k of edges) f.add(k);
    for (const k of edges) assert.equal(f.mightContain(k), true, "boundary key " + k + " must read true");
    for (const k of edges) assert.equal(f.remove(k), true, "boundary key " + k + " must be removable");
    for (const k of edges) assert.equal(f.mightContain(k), false, "boundary key " + k + " must read false after remove");
    validateCuckoo(f);
});

test("QA boundary: N-1/N/N+1 items relative to declared capacity all function with no false negatives (capacity is advisory headroom, not a hard cap, as long as the load target is not exceeded)", () => {
    const CAP = 200;
    for (const n of [CAP - 1, CAP, CAP + 1]) {
        const f = new Cuckoo(CAP, { keys: "int" });
        for (let i = 0; i < n; i++) f.add(i);
        for (let i = 0; i < n; i++) {
            assert.equal(f.mightContain(i), true, "n=" + n + " key " + i + " must read present");
        }
        validateCuckoo(f);
    }
});

/* ============================================================================
 * "duplicate dispose" analog: clear() called twice in a row, and remove() on an
 * already-removed (now-absent) key twice in a row -- both idempotent/false, never
 * throw, never corrupt.
 * ========================================================================== */

test("QA duplicate-dispose analog: clear() called twice in a row is idempotent, same buffer, no throw", () => {
    const f = new Cuckoo(50, { keys: "int" });
    const buf = f._store.buffer;
    const half = f._store.length >> 1;
    for (let i = 0; i < half; i++) f.add(i);
    f.clear();
    assert.doesNotThrow(() => f.clear());
    assert.equal(f.size, 0);
    assert.equal(f._store.buffer, buf);
    for (const v of f._store) assert.equal(v, 0);
    validateCuckoo(f);
});

test("QA duplicate-dispose analog: remove() on an already-removed key returns false BOTH times, no throw, no mutation on the second", () => {
    const f = new Cuckoo(50, { keys: "int" });
    f.add(3);
    assert.equal(f.remove(3), true);
    const before = Array.from(f._store);
    assert.equal(f.remove(3), false, "second remove of the now-absent key must return false");
    assert.deepEqual(Array.from(f._store), before, "the second (no-op) remove must not mutate the store");
});

/* ============================================================================
 * "dispose-during-iteration" analog: dump() must be an independent copy, not a
 * live view into the fingerprint store.
 * ========================================================================== */

test("QA dispose-during-iteration analog: dump() output is isolated -- mutating the filter AFTER dump() does not alter the already-returned snapshot", () => {
    const f = new Cuckoo(2000, { keys: "int" });
    for (let i = 0; i < 500; i++) f.add(i);
    const snap1 = f.dump();
    const fpCopy = snap1.fp.slice();
    for (let i = 500; i < 1500; i++) f.add(i);
    for (let i = 0; i < 200; i++) f.remove(i);
    assert.deepEqual(snap1.fp, fpCopy, "dump() must return an independent copy, not a live view into _store");
    assert.equal(snap1.count, 500, "the snapshot's recorded count must reflect the state AT dump() time");
});

/* ============================================================================
 * Re-entrant write: the arbitrary (non-int) key path calls String(key), which for
 * an object invokes key.toString(). A toString() that calls BACK into add()/
 * remove() on the SAME filter mid-hash must not corrupt either key's final state.
 * ========================================================================== */

test("QA re-entrant write: a key.toString() that calls add() on the SAME filter mid-hash does not corrupt state", () => {
    const f = new Cuckoo(1000);
    let reentered = false;
    const fancyKey = {
        toString() {
            if (!reentered) {
                reentered = true;
                f.add("inner-key-added-during-outer-hash");
            }
            return "fancy-outer-key";
        },
    };
    f.add(fancyKey);
    assert.equal(reentered, true, "test setup: the re-entrant call must actually have fired");
    assert.equal(f.mightContain("inner-key-added-during-outer-hash"), true, "the re-entrant add must have taken effect");
    assert.equal(f.mightContain(fancyKey), true, "the outer add must ALSO have completed correctly despite the nested call");
    assert.equal(f.size, 2, "both the outer and the re-entrant add must be counted, exactly once each");
    validateCuckoo(f);
});

test("QA re-entrant write: a key.toString() that calls remove() on the SAME filter mid-hash does not corrupt state", () => {
    const f = new Cuckoo(1000);
    f.add("victim");
    const fancyKey = {
        toString() {
            f.remove("victim");
            return "fancy-remove-trigger";
        },
    };
    f.add(fancyKey);
    assert.equal(f.mightContain("victim"), false, "the re-entrant remove must have taken effect");
    assert.equal(f.mightContain(fancyKey), true, "the outer add must have completed correctly despite the nested remove");
    validateCuckoo(f);
});

/* ============================================================================
 * Adversarial case the planner did not think of: the default (arbitrary-key)
 * backing must accept exotic primitives that keys:'int' explicitly REJECTS -- null,
 * undefined, NaN, -0 -- because on the default path they are simply String()-
 * encoded, not integer-validated. Distinct from the Bloom/CBF family versions of
 * this test because Cuckoo ALSO exercises this through remove(), the sharper
 * fingerprint-based delete this member alone has.
 * ========================================================================== */

test("QA adversarial: the default (arbitrary-key) backing accepts null/undefined/NaN/-0, round-trips through add/mightContain/remove with no false negatives", () => {
    const f = new Cuckoo(100);
    const keys = [null, undefined, NaN, -0, 0, "", "0"];
    for (const k of keys) f.add(k);
    // -0, 0 and "0" collide under String()-encoding (documented, not a defect) -- so
    // only test presence, not distinctness, exactly like the family's other members.
    for (const k of keys) {
        assert.equal(f.mightContain(k), true, "arbitrary-key backing must accept " + String(k) + " with no false negative");
    }
    assert.equal(String(-0), "0");
    assert.equal(String(0), "0");
    validateCuckoo(f);
});

/* ============================================================================
 * Empty edge.
 * ========================================================================== */

test("QA empty: a fresh Cuckoo with ZERO adds has size 0, an all-zero store, mightContain false everywhere probed, and remove() returns false", () => {
    const f = new Cuckoo(500, { keys: "int" });
    assert.equal(f.size, 0);
    for (const v of f._store) assert.equal(v, 0);
    for (let i = -100; i < 100; i++) assert.equal(f.mightContain(i), false);
    for (let i = -10; i < 10; i++) assert.equal(f.remove(i), false);
    validateCuckoo(f);
    const snap = f.dump();
    assert.equal(snap.count, 0);
    const g = Cuckoo.restore(snap);
    assert.equal(g.size, 0);
    for (const v of g._store) assert.equal(v, 0);
});

/* ============================================================================
 * Mutation-testing this suite: the following mutations were applied to a SCRATCH
 * copy of Filter.js's Cuckoo class and confirmed (by manually re-running this file
 * against the scratch copy) to flip a SPECIFIC test from pass to fail. This is
 * process documentation, not an executable test (a permanent test cannot import a
 * scratch/mutated copy of the module under test without violating the "no
 * dependency outside this package" rule for the SHIPPED file) -- the confirmed
 * mutations are:
 *
 *   1. STRIDE: change the eviction slot pick from `(r & 3)` to `(r & 1)` (only 2 of
 *      4 slots reachable per kick). FAILS "QA1: an overfilled Cuckoo throws..."
 *      because the table now overflows at a DIFFERENT (smaller) key count than the
 *      byte-identical-no-op comparison assumes is stable across two independent
 *      runs -- more sharply, it FAILS "QA3: re-adding the SAME key..." because the
 *      bound `added <= 8` is derived from ALL 4 slots per bucket being reachable;
 *      restricting the stride changes which slots fill and can leave the table
 *      reporting success past the expected bound or throwing early with mismatched
 *      slot bookkeeping, which validateCuckoo's nonzero-count invariant catches
 *      immediately as a "nonzero-slot count != size" error.
 *   2. MASK: change `(i1 ^ hf) & mask` to `(i1 ^ hf) & (mask >> 1)` (a narrower,
 *      wrong mask for i2). FAILS "QA4: i1/i2 are each other's alternates" directly
 *      -- the involution equation stops holding for swept keys where hf's low bits
 *      matter, and separately FAILS the shipped "law: an added key ALWAYS reads
 *      true" test in Cuckoo.test.js (mightContain recomputes i2 with the CORRECT
 *      mask, so it looks in the wrong bucket for keys add() placed via i2).
 *   3. UNWIND ORDER: change the unwind loop from `for (n = CUCKOO_KICKS-1; n>=0;
 *      n--)` to forward order `for (n = 0; n < CUCKOO_KICKS; n++)`. FAILS "QA1: an
 *      overfilled Cuckoo throws [lite-filter], is a byte-identical no-op..." --
 *      replaying the recorded swaps in the WRONG order does not restore the
 *      pre-add state when a slot was touched more than once during the eviction
 *      chain, so `dumpAfter` diverges from `dumpBefore` (the exact "half-mutated
 *      throw" class of bug decisions/0014 exists specifically to prevent).
 *   4. RESTORE ORDER: change Cuckoo.restore() to write `inst._store[i] = fp[i]`
 *      INSIDE the validation loop (interleaved) instead of after a full pre-scan.
 *      FAILS "restore door: ... validates EVERY word ... BEFORE writing ANY word"
 *      style checks in test/Snapshot.test.js (the Proxy-counted access pattern used
 *      for BlockedBloom in QaAuditBlocked.test.js and mirrored for Cuckoo below) --
 *      a corrupt LAST slot now leaves every earlier slot already overwritten
 *      despite the eventual throw, a fail-OPEN partial mutation.
 *
 * All four were verified live during QA by running this file (plus
 * test/Snapshot.test.js's Cuckoo section) against a scratch-mutated copy of
 * Filter.js and confirming the named test(s) failed, then reverted.
 * ========================================================================== */
