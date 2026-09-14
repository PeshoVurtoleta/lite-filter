/**
 * @zakkster/lite-filter -- QA independent-verification suite (v0.2.0 CountingBloom).
 *
 * This file is written by QA, not the coder, specifically to INDEPENDENTLY falsify
 * the planner's ASSERTIONS for the CountingBloom member. Every test here is designed
 * so that it FAILS if the described behavior regresses -- it does not just replay the
 * shipped test suite. Boundary matrix: 0, 1, N-1, N, N+1, empty, null, undefined,
 * NaN, -0, duplicate "dispose" (clear()/absent-remove), dispose-during-iteration
 * (mutate-after-dump isolation), re-entrant write (toString() hook re-enters add()),
 * and one adversarial case the planner did not enumerate (arbitrary-key backing
 * accepting exotic primitives; the stats-holder live-reference contract).
 *
 * node:test only. No dependency outside this package + its devDependency peers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Bloom, CountingBloom } from "../Filter.js";
import { validateCounting } from "./validate.mjs";

/* ============================================================================
 * Assertion 1 -- remove semantics (independent keys/capacities from the shipped
 * suite, to rule out a shared blind spot).
 * ========================================================================== */

test("QA1: add(k);add(k);remove(k) -> mightContain true (multiplicity 2 -> 1), fresh capacity/key", () => {
    const f = new CountingBloom(777, { keys: "int" });
    f.add(-12345);
    f.add(-12345);
    assert.equal(f.remove(-12345), true);
    assert.equal(f.mightContain(-12345), true, "one remaining copy must still read present");
    validateCounting(f);
});

test("QA1: add(k);remove(k) -> size===0, no throw, mightContain MAY be false", () => {
    const f = new CountingBloom(777, { keys: "int" });
    f.add(555555);
    assert.doesNotThrow(() => f.remove(555555));
    assert.equal(f.size, 0);
    // one-shot add+remove with no colliding neighbor: must read absent.
    assert.equal(f.mightContain(555555), false);
    validateCounting(f);
});

test("QA1: remove of a NEVER-added key returns false and mutates NOTHING (byte-identical snapshot)", () => {
    const f = new CountingBloom(5000, { keys: "int" });
    for (let i = 0; i < 3000; i++) f.add(i);
    const before = Buffer.from(f._cnts).toString("hex");
    const sizeBefore = f.size;
    // A key far outside the added domain and unlikely to false-positive-collide on
    // ALL k probes at this fill factor.
    assert.equal(f.remove(-987654321), false);
    assert.equal(Buffer.from(f._cnts).toString("hex"), before, "the store must be byte-identical after a no-op remove");
    assert.equal(f.size, sizeBefore);
    validateCounting(f);
});

/* ============================================================================
 * Assertion 2 -- saturation. Boundary matrix on the counter DOMAIN itself:
 * MAX_COUNT (N) = 15. Key 42 / capacity 1 increments the touched nibble by
 * exactly +2 per add() call (independently measured, not assumed), so N-1=14 and
 * N=15 land on EXACT add-call counts (7 and 8 respectively) -- a real 0/1/N-1/N/N+1
 * boundary on the nibble value, not merely "add it 16 times and hope".
 * ========================================================================== */

test("QA2 boundary: 7 adds of key 42 (cap 1) reach nibble N-1=14, not saturated", () => {
    const f = new CountingBloom(1, { keys: "int" });
    for (let i = 0; i < 7; i++) f.add(42);
    let max = 0;
    for (const b of f._cnts) { max = Math.max(max, b & 0x0f, (b >>> 4) & 0x0f); }
    assert.equal(max, 14, "expected the touched nibble to sit exactly at 14 after 7 adds");
    // Not yet saturated: a remove() must actually decrement it (13), proving the
    // saturation clamp has NOT engaged one tick early.
    assert.equal(f.remove(42), true);
    let max2 = 0;
    for (const b of f._cnts) { max2 = Math.max(max2, b & 0x0f, (b >>> 4) & 0x0f); }
    assert.equal(max2, 12, "removing one add() worth (which itself contributes 2) must decrement by 2, not clamp");
});

test("QA2 boundary: 8 adds of key 42 (cap 1) reach nibble N=15 -- exact saturation onset", () => {
    const f = new CountingBloom(1, { keys: "int" });
    for (let i = 0; i < 8; i++) f.add(42);
    let max = 0;
    for (const b of f._cnts) { max = Math.max(max, b & 0x0f, (b >>> 4) & 0x0f); }
    assert.equal(max, 15, "8 adds (16 raw increments) must clamp at exactly 15, the saturation ceiling");
});

test("QA2 boundary: further adds never exceed N=15 (no N+1 wrap/overflow), independent key", () => {
    const f = new CountingBloom(1, { keys: "int" });
    for (let i = 0; i < 40; i++) f.add(-99999);
    let max = 0;
    for (const b of f._cnts) { max = Math.max(max, b & 0x0f, (b >>> 4) & 0x0f); }
    assert.equal(max, 15, "40 adds must still clamp at 15, never wrap past it");
    assert.equal(f.remove(-99999), true, "remove of a saturated (present) key returns true");
    let max2 = 0;
    for (const b of f._cnts) { max2 = Math.max(max2, b & 0x0f, (b >>> 4) & 0x0f); }
    assert.equal(max2, 15, "a saturated counter must NOT be decremented by remove (decisions/0008)");
    assert.equal(f.mightContain(-99999), true, "a saturated key sticks present after one remove");
});

/* ============================================================================
 * Assertion 3 -- restore() corruption doors. Independently exercised: a corrupt
 * element at the LAST index (not just index 0, which the shipped suite covers),
 * an exact N+1 oversize (not +3), a capacity-only corruption (transitively caught
 * via the re-derived m/k), and a proof that a failed restore() leaves no residue
 * that corrupts a SUBSEQUENT clean restore() (no static/global leakage).
 * ========================================================================== */

function filledCounting(opts) {
    const f = new CountingBloom(1000, opts);
    for (let i = 0; i < 800; i++) f.add(i);
    return f;
}

test("QA3: restore rejects a byte>255 / NaN / negative / non-integer float / string at the LAST index", () => {
    for (const bad of [256, NaN, -1, 12.5, "x"]) {
        const snap = filledCounting({ keys: "int" }).dump();
        snap.cnts[snap.cnts.length - 1] = bad;
        assert.throws(
            () => CountingBloom.restore(snap),
            /\[lite-filter\]/,
            "restore() must scan and reject a corrupt LAST byte (" + String(bad) + "), not just index 0"
        );
    }
});

test("QA3: restore rejects an EXACT length+1 oversized counter store (not just +3)", () => {
    const snap = filledCounting({ keys: "int" }).dump();
    snap.cnts = snap.cnts.concat([0]);
    assert.throws(() => CountingBloom.restore(snap), /\[lite-filter\].*counter store/);
});

test("QA3: restore rejects an EXACT length-1 undersized counter store", () => {
    const snap = filledCounting({ keys: "int" }).dump();
    snap.cnts = snap.cnts.slice(0, -1);
    assert.throws(() => CountingBloom.restore(snap), /\[lite-filter\].*counter store/);
});

test("QA3: a capacity mismatch (cap changed, fpp fixed) is caught transitively via m/k re-derivation", () => {
    const snap = filledCounting({ fpp: 0.01, keys: "int" }).dump();
    snap.cap = snap.cap * 3;
    assert.throws(() => CountingBloom.restore(snap), /\[lite-filter\]/, "a corrupted cap must fail closed, not silently build a wrong-shaped filter");
});

test("QA3: fpp mismatch (cap fixed) is caught transitively via m/k re-derivation", () => {
    const snap = filledCounting({ fpp: 0.01, keys: "int" }).dump();
    snap.fpp = 0.2;
    assert.throws(() => CountingBloom.restore(snap), /\[lite-filter\]/);
});

test("QA3: a failed (corrupt) restore() leaves NO residue that corrupts a later clean restore()", () => {
    const goodSnap = filledCounting({ keys: "int" }).dump();
    for (let trial = 0; trial < 5; trial++) {
        const bad = filledCounting({ keys: "int" }).dump();
        bad.cnts[0] = -1;
        assert.throws(() => CountingBloom.restore(bad));
    }
    // A clean restore afterwards must still succeed and be fully correct -- no shared
    // static/module-level state was corrupted by the repeated failed attempts.
    const g = CountingBloom.restore(goodSnap);
    for (let i = 0; i < 800; i++) assert.equal(g.mightContain(i), true);
    validateCounting(g);
});

test("QA3: member mismatch both directions reject with a fresh, independently-built pair", () => {
    const bloomSnap = new Bloom(200, { keys: "int" }).dump();
    const cbfSnap = new CountingBloom(200, { keys: "int" }).dump();
    assert.throws(() => CountingBloom.restore(bloomSnap), /\[lite-filter\].*member/);
    assert.throws(() => Bloom.restore(cbfSnap), /\[lite-filter\].*member/);
});

/* ============================================================================
 * Reviewer's added invariant: size/count stays >= 0 under unsound double-remove
 * misuse (removing a key more times than it was added). This is exercised NOT by
 * the trivial "remove twice, second is pass-1-blocked" path (which never risks
 * going negative because the key's own counters hit 0 and further removes are
 * refused) but by an adversarially engineered SHARED-COUNTER collision: two int
 * keys (7 and 37, default seed, capacity 1 -> m=10, k=7) that probe the EXACT SAME
 * set of counter positions. Padding key 37's multiplicity keeps every probed
 * position of key 7 nonzero long after key 7's own single add() has been "removed"
 * many times over -- so remove(7) keeps returning true well past its true
 * ownership count. The floor guard (`if (this._count > 0) this._count--`) must
 * hold size at exactly 0, never negative, even while removes keep succeeding.
 * ========================================================================== */

test("QA-reviewer-invariant: size never goes negative under over-removal via shared counters", () => {
    const f = new CountingBloom(1, { keys: "int" }); // default seed -- m=10, k=7
    for (let i = 0; i < 14; i++) f.add(37); // pads every position key 7 also touches
    f.add(7); // count = 15

    let sawTrueAfterZero = false;
    let sawSize = new Set();
    for (let i = 0; i < 40; i++) {
        f.remove(7);
        sawSize.add(f.size);
        assert.ok(f.size >= 0, "size must never go negative (call " + i + ", size=" + f.size + ")");
    }
    // Sanity: prove the adversarial setup actually DID drive size to 0 and that
    // removes kept returning true well beyond that point (otherwise this test would
    // be vacuously passing without ever stressing the floor guard).
    assert.ok(sawSize.has(0), "the scenario must actually reach size===0 to stress the floor guard");

    // Re-run counting explicit true-returns past the zero point to prove non-vacuity.
    const g = new CountingBloom(1, { keys: "int" });
    for (let i = 0; i < 14; i++) g.add(37);
    g.add(7);
    let hitZero = false;
    let trueAfterZero = 0;
    for (let i = 0; i < 40; i++) {
        const r = g.remove(7);
        if (g.size === 0) hitZero = true;
        if (hitZero && r) trueAfterZero++;
        assert.ok(g.size >= 0);
    }
    assert.ok(trueAfterZero > 0, "the adversarial setup must produce true-returning removes AFTER size hit 0 (else the guard is never actually exercised)");
    void sawTrueAfterZero;
});

/* ============================================================================
 * Boundary hygiene: keys:'int' door on add/mightContain/remove, extra exotic values
 * beyond the shipped suite (Infinity, BigInt, booleans).
 * ========================================================================== */

test("QA boundary: keys:'int' rejects Infinity/-Infinity/BigInt/booleans on add, mightContain, AND remove", () => {
    const f = new CountingBloom(10, { keys: "int" });
    const bad = [Infinity, -Infinity, 10n, true, false];
    for (const v of bad) {
        assert.throws(() => f.add(v), /\[lite-filter\].*keys:'int'/, "add(" + String(v) + ")");
        assert.throws(() => f.mightContain(v), /\[lite-filter\].*keys:'int'/, "mightContain(" + String(v) + ")");
        assert.throws(() => f.remove(v), /\[lite-filter\].*keys:'int'/, "remove(" + String(v) + ") must NOT silently no-op");
    }
});

test("QA boundary: construction doors reject NaN/Infinity fpp and Infinity/-Infinity capacity", () => {
    assert.throws(() => new CountingBloom(100, { fpp: Infinity }), /\[lite-filter\].*fpp/);
    assert.throws(() => new CountingBloom(100, { fpp: -Infinity }), /\[lite-filter\].*fpp/);
    assert.throws(() => new CountingBloom(Infinity), /\[lite-filter\].*capacity/);
    assert.throws(() => new CountingBloom(-Infinity), /\[lite-filter\].*capacity/);
});

test("QA boundary: has() is the SOLE alias of mightContain -- no third method name exists", () => {
    const names = Object.getOwnPropertyNames(CountingBloom.prototype);
    const forbidden = ["contains", "member", "isMember", "query", "check", "test"];
    for (const n of forbidden) {
        assert.equal(names.includes(n), false, "an undocumented alias '" + n + "' must not exist");
    }
    // has and mightContain must be two DISTINCT function objects (has delegates, is
    // not literally the same reference re-exported under two names -- both routes
    // are exercised independently and agree).
    const f = new CountingBloom(10, { keys: "int" });
    f.add(1);
    assert.notEqual(CountingBloom.prototype.has, CountingBloom.prototype.mightContain);
    assert.equal(f.has(1), f.mightContain(1));
});

test("QA boundary: N-1/N/N+1 items relative to declared capacity all function with no false negatives (capacity is advisory, not a hard cap)", () => {
    const CAP = 10;
    for (const n of [CAP - 1, CAP, CAP + 1]) {
        const f = new CountingBloom(CAP, { keys: "int" });
        for (let i = 0; i < n; i++) f.add(i);
        for (let i = 0; i < n; i++) {
            assert.equal(f.mightContain(i), true, "n=" + n + " key " + i + " must read present (over-fill degrades FPR, never correctness)");
        }
        validateCounting(f);
    }
});

test("QA boundary: an odd bit/counter count m leaves the unused half-nibble of the final byte untouched", () => {
    // Find a capacity whose derived m is ODD, so ceil(m/2) leaves the final byte's
    // upper nibble structurally unaddressable by any valid position 0..m-1.
    let cap = null, m = null;
    for (let n = 1; n < 2000; n++) {
        const f = new CountingBloom(n, { keys: "int" });
        if (f._m % 2 === 1) { cap = n; m = f._m; break; }
    }
    assert.ok(cap !== null, "test setup: expected to find a capacity with odd m within range");
    const f = new CountingBloom(cap, { keys: "int" });
    for (let i = 0; i < cap * 5; i++) f.add(i); // hammer it hard
    const lastByte = f._cnts[f._cnts.length - 1];
    const upperNibble = (lastByte >>> 4) & 0x0f;
    assert.equal(upperNibble, 0, "position m (out of range, odd m=" + m + ") must never be touched -- upper nibble of final byte stays 0");
});

/* ============================================================================
 * "duplicate dispose" analog: this library has no dispose(), so the nearest real
 * entry-point equivalent is (a) calling clear() twice in a row, and (b) removing
 * an already-removed (now-absent) key twice in a row -- both must be idempotent
 * no-ops/false-returns, never throw, never corrupt.
 * ========================================================================== */

test("QA duplicate-dispose analog: clear() called twice in a row is idempotent, same buffer, no throw", () => {
    const f = new CountingBloom(50, { keys: "int" });
    const buf = f._cnts.buffer;
    for (let i = 0; i < 50; i++) f.add(i);
    f.clear();
    assert.doesNotThrow(() => f.clear());
    assert.equal(f.size, 0);
    assert.equal(f._cnts.buffer, buf);
    for (const b of f._cnts) assert.equal(b, 0);
});

test("QA duplicate-dispose analog: remove() on an already-removed key returns false BOTH times, no throw, no mutation on the second", () => {
    const f = new CountingBloom(50, { keys: "int" });
    f.add(3);
    assert.equal(f.remove(3), true);
    const before = Buffer.from(f._cnts).toString("hex");
    assert.equal(f.remove(3), false, "second remove of the now-absent key must return false");
    assert.equal(Buffer.from(f._cnts).toString("hex"), before, "the second (no-op) remove must not mutate the store");
});

/* ============================================================================
 * "dispose-during-iteration" analog: this library exposes no iterator, so the
 * nearest hazard is snapshot ALIASING -- does dump() return a live view into the
 * filter's internal store, such that continuing to mutate the filter after dump()
 * corrupts an already-handed-out snapshot (the moral equivalent of mutating a
 * collection out from under an in-flight iterator)?
 * ========================================================================== */

test("QA dispose-during-iteration analog: dump() output is isolated -- mutating the filter AFTER dump() does not alter the already-returned snapshot", () => {
    const f = new CountingBloom(200, { keys: "int" });
    for (let i = 0; i < 100; i++) f.add(i);
    const snap1 = f.dump();
    const cntsSnapshotCopy = snap1.cnts.slice();
    // Mutate heavily AFTER taking the snapshot.
    for (let i = 100; i < 5000; i++) f.add(i);
    for (let i = 0; i < 50; i++) f.remove(i);
    assert.deepEqual(snap1.cnts, cntsSnapshotCopy, "dump() must return an independent copy, not a live view into _cnts");
    assert.equal(snap1.count, 100, "the snapshot's recorded count must reflect the state AT dump() time, not later mutation");
});

/* ============================================================================
 * Re-entrant write: the arbitrary (non-int) key path calls String(key), which for
 * an object invokes key.toString(). A hostile/careless toString() that calls BACK
 * into add()/remove() on the SAME filter mid-hash is a genuine re-entrancy hazard
 * this codebase actually exposes (unlike a synthetic scenario) -- there is no
 * shared mutable scratch state read across the hash computation and the nibble
 * read/modify/write, so a nested call completing fully before the outer one
 * resumes must NOT corrupt either key's final state.
 * ========================================================================== */

test("QA re-entrant write: a key.toString() that calls add() on the SAME filter mid-hash does not corrupt state", () => {
    const f = new CountingBloom(1000);
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
    validateCounting(f);
});

test("QA re-entrant write: a key.toString() that calls remove() on the SAME filter mid-hash does not corrupt state", () => {
    const f = new CountingBloom(1000);
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
    validateCounting(f);
});

/* ============================================================================
 * Adversarial case the planner did not think of, #1: the DEFAULT (arbitrary-key)
 * backing must accept exotic primitives that keys:'int' explicitly REJECTS --
 * null, undefined, NaN, -0 -- because on the default path they are simply
 * String()-encoded, not integer-validated. This is a real behavioral fork the
 * planner's assertions (all phrased around keys:'int') never exercise, and a
 * regression here (e.g. an over-eager validation check leaking from the int path)
 * would silently break the arbitrary-key member's documented "any key" contract.
 * ========================================================================== */

test("QA adversarial#1: the default (arbitrary-key) backing accepts null/undefined/NaN/-0 with no false negatives", () => {
    const f = new CountingBloom(100);
    const keys = [null, undefined, NaN, -0, 0, "", "0"];
    for (const k of keys) f.add(k);
    for (const k of keys) {
        assert.equal(f.mightContain(k), true, "arbitrary-key backing must accept " + String(k) + " without throwing and never false-negative it");
    }
    // Documented consequence of String()-based hashing: -0, 0, and "0" all stringify
    // to the same encoding and are therefore indistinguishable to the filter -- this
    // is expected (not a defect), and is asserted here so a future change is visible.
    assert.equal(String(-0), "0");
    assert.equal(String(0), "0");
    validateCounting(f);
});

/* ============================================================================
 * Adversarial case the planner did not think of, #2: stats() is documented as
 * returning "the live per-instance counter holder BY REFERENCE (not a snapshot)".
 * That is a load-bearing contract for any caller that grabs the handle once and
 * polls it later; verify identity is stable across calls and mutations.
 * ========================================================================== */

test("QA adversarial#2: stats() returns the SAME object reference across calls (live holder, not a fresh snapshot each time)", () => {
    const f = new CountingBloom(100, { stats: true });
    const s1 = f.stats();
    f.add("a");
    f.mightContain("a");
    const s2 = f.stats();
    assert.equal(s1, s2, "stats() must return the identical object reference, not a new object per call");
    assert.equal(s1.adds, 1, "the reference held from BEFORE the add() must reflect it (live, not frozen at grab time)");
    f.resetStats();
    assert.equal(s1.adds, 0, "resetStats() must zero the SAME object a previously-grabbed reference points to");
});

/* ============================================================================
 * Empty-input edge: an empty snapshot round-trip (0 adds) and empty-string key.
 * ========================================================================== */

test("QA empty: a filter with ZERO adds dumps/restores to an all-zero store, size 0, no false anything", () => {
    const f = new CountingBloom(50, { keys: "int" });
    const snap = f.dump();
    assert.equal(snap.count, 0);
    for (const b of snap.cnts) assert.equal(b, 0);
    const g = CountingBloom.restore(snap);
    assert.equal(g.size, 0);
    for (let i = 0; i < 100; i++) assert.equal(g.mightContain(i), false);
    validateCounting(g);
});

test("QA empty: the empty string is a valid arbitrary key, round-trips with no false negative", () => {
    const f = new CountingBloom(50, { stats: true });
    f.add("");
    assert.equal(f.mightContain(""), true);
    assert.equal(f.stats().adds, 1);
    assert.equal(f.remove(""), true);
    assert.equal(f.mightContain(""), false);
});
