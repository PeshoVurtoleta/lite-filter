/**
 * @zakkster/lite-filter -- QA independent-verification suite (v0.5.0 Quotient).
 *
 * Written by QA to INDEPENDENTLY falsify the planner's ASSERTIONS for the Quotient member
 * (decisions/0016, 0017), mirroring QaAuditCuckoo.test.js. Every test FAILS if the described
 * behavior regresses -- it does not just replay the shipped suite or torture.mjs. The
 * headline is the decisions/0017 caveat exhibited as a REAL, non-vacuous collision (the
 * exact 42/131 example the record pins), plus the byte-identical fail-closed ceiling, the
 * MULTIPLICITY contract (no dedup), the shift-back repair proven via validateQuotient, and
 * restore()'s deep structural rejection.
 *
 * A small internal MODEL of the int-keyed hash split (fmix32 + the quotient/remainder
 * derivation) is reproduced here, read against the instance's OWN _seed/_pMask/_r/_rMask/
 * _qMask fields (the same white-box pattern test/validate.mjs uses) -- ONLY to brute-force
 * search for adversarial keys, never to bypass the public add/mightContain/remove surface.
 *
 * node:test only. No dependency outside this package + its devDependency peers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Quotient } from "../Filter.js";
import { validateQuotient } from "./validate.mjs";

/* ============================================================================
 * White-box model (test-only): reproduces Filter.js's int-keyed split exactly,
 * driven by the INSTANCE's own fields so it stays correct under any seed/fpp/cap.
 * ========================================================================== */

function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

function split(f, key) {
    const hv = fmix32((key ^ f._seed) | 0) & f._pMask;
    const r = hv & f._rMask;
    const q = (hv >>> f._r) & f._qMask;
    return { q: q, r: r };
}

/* ============================================================================
 * Assertion 1 (decisions/0017) -- the delete-caveat exhibited as a REAL, non-vacuous
 * collision. This is the exact example decisions/0017 pins, PROVEN here (the reviewer's
 * blocker: the record claimed the QA suite exhibits it, so it must actually do so).
 * ========================================================================== */

test("QA1 (decisions/0017): the pinned 42/131 collision -- remove(131 never-inserted) flips mightContain(42) true->false (exactly 1 FN)", () => {
    const f = new Quotient(16, { fpp: 0.3, keys: "int" });
    // The record pins r=2, q=5, nslots=32, p=7 at these params with the default seed.
    assert.equal(f._r, 2, "test setup: expected remainder width 2");
    assert.equal(f._q, 5, "test setup: expected quotient width 5");
    assert.equal(f._nslots, 32, "test setup: expected 32 slots");
    assert.equal(f._p, 7, "test setup: expected bit budget 7");

    const A = 42;    // the REAL key that WILL be inserted
    const B = 131;   // a key that will NEVER be inserted, pinned to collide with A
    const tA = split(f, A);
    const tB = split(f, B);
    assert.deepEqual(tB, tA, "test setup: 42 and 131 must split to the SAME (quotient, remainder)");

    f.add(A);
    assert.equal(f.mightContain(A), true, "the real key must be present before the adversarial remove");
    assert.equal(f.size, 1);

    // B was NEVER added. Per decisions/0017, removing it returns true and clears A's slot.
    assert.equal(f.remove(B), true, "the never-inserted, colliding key reports a (spurious) successful delete -- the caveat");
    assert.equal(f.mightContain(A), false, "the REAL key A now reads false -- a false negative caused by the collision (decisions/0017)");
    assert.equal(f.size, 0, "size dropped even though the caller never removed the key they own");
    validateQuotient(f);
});

test("QA1b: a generic engineered collision (brute-forced via the model) reproduces the same caveat under a fresh seed", () => {
    const f = new Quotient(64, { fpp: 0.3, keys: "int", seed: 0x1234abcd });
    const A = 987654;
    const tA = split(f, A);
    let B = null;
    for (let k = 0; k < 5_000_000; k++) {
        if (k === A) continue;
        const s = split(f, k);
        if (s.q === tA.q && s.r === tA.r) { B = k; break; }
    }
    assert.notEqual(B, null, "test setup: expected a real (quotient, remainder) collision within the budget");
    f.add(A);
    assert.equal(f.mightContain(A), true);
    assert.equal(f.remove(B), true, "the never-inserted colliding key reports a spurious delete");
    assert.equal(f.mightContain(A), false, "the real key is now a false negative (decisions/0017)");
});

/* ============================================================================
 * Assertion 2 -- MULTIPLICITY: a Quotient does NOT dedup. This is safety-relevant --
 * 0017's delete-safety argument depends on it (two present keys sharing a fingerprint
 * hold two slots, so removing one leaves the other resident).
 * ========================================================================== */

test("QA2: two DISTINCT keys sharing a fingerprint hold TWO slots -- removing one leaves the other present (no dedup, decisions/0016)", () => {
    const f = new Quotient(64, { fpp: 0.3, keys: "int", seed: 0x99 });
    const A = 111111;
    const tA = split(f, A);
    let B = null;
    for (let k = 0; k < 5_000_000; k++) {
        if (k === A) continue;
        const s = split(f, k);
        if (s.q === tA.q && s.r === tA.r) { B = k; break; }
    }
    assert.notEqual(B, null, "test setup: need a colliding pair");
    f.add(A);
    f.add(B);
    assert.equal(f.size, 2, "no dedup: two adds of colliding-but-distinct keys store TWO slots");
    assert.equal(f.remove(A), true);
    assert.equal(f.mightContain(B), true, "the SECOND key survives -- multiplicity is what makes this safe");
    assert.equal(f.size, 1);
    validateQuotient(f);
});

test("QA2b: re-adding the SAME key is NOT idempotent -- it consumes slots (multiplicity) and size tracks the add count", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 5; i++) f.add(777);
    assert.equal(f.size, 5, "five adds of the same key store five slots (no dedup)");
    // Removing once leaves four instances -> still present.
    assert.equal(f.remove(777), true);
    assert.equal(f.mightContain(777), true);
    assert.equal(f.size, 4);
    validateQuotient(f);
});

/* ============================================================================
 * Assertion 3 -- the fail-closed load ceiling is a byte-identical no-op and drops NO
 * already-added key (the exact bug class: an overload that half-mutates or drops a key).
 * ========================================================================== */

test("QA3: an over-filled Quotient throws [lite-filter], is a byte-identical no-op, and drops NO already-added key", () => {
    const f = new Quotient(32, { fpp: 0.01, keys: "int" });
    const added = [];
    let threw = false;
    let msg = "";
    try {
        for (let i = 0; i < 500000; i++) { f.add(i); added.push(i); }
    } catch (e) {
        threw = true;
        msg = e.message;
    }
    assert.equal(threw, true, "test setup: a 32-capacity filter hammered with distinct keys must reach the ceiling");
    assert.match(msg, /\[lite-filter\]/);
    assert.ok(added.length >= 8, "test setup: expected meaningful successful adds before the throw, got " + added.length);
    // Non-vacuity: every key added BEFORE the throw must still read true.
    let fn = 0;
    for (const k of added) if (!f.mightContain(k)) fn++;
    assert.equal(fn, 0, "overload must not false-negative any key added before the throw");
    // Byte-identical no-op: memcmp the store across a throwing add.
    const before = Array.from(f._store);
    const sizeBefore = f.size;
    assert.throws(() => f.add(9_000_001), /\[lite-filter\]/);
    assert.deepEqual(Array.from(f._store), before, "a thrown add must leave the store byte-identical");
    assert.equal(f.size, sizeBefore, "a thrown add must not change size");
    validateQuotient(f);
});

/* ============================================================================
 * Assertion 4 -- the shift-back metadata repair (the planner's flagged risk): after heavy
 * churn, validateQuotient's STRUCTURE invariants must hold, not just FN=0.
 * ========================================================================== */

test("QA4: shift-back repair keeps validateQuotient (metadata-set==size, #homes==#runs, sorted runs) sound after heavy churn", () => {
    const f = new Quotient(8000, { fpp: 0.01, keys: "int", seed: 0xbeef });
    let x = 13 >>> 0;
    const rng = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
    const live = new Set();
    for (let i = 0; i < 300000; i++) {
        const k = rng() % 6000;
        if (live.has(k)) { assert.equal(f.remove(k), true, "a live key must be removable"); live.delete(k); }
        else { f.add(k); live.add(k); }
    }
    for (const k of live) assert.equal(f.mightContain(k), true, "live key " + k + " must read present after churn");
    assert.equal(f.size, live.size, "size must track the live set exactly (multiplicity 1 per key here)");
    validateQuotient(f);
});

/* ============================================================================
 * Assertion 5 -- restore() DEEP structural rejection (NIT 3): a corrupt-but-in-range
 * snapshot (a lone continuation with no preceding run start) must be REJECTED, not loaded.
 * ========================================================================== */

test("QA5: restore() rejects a corrupt-but-in-range snapshot (a lone continuation) -- deep structure, not just per-word ranges", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 100; i++) f.add(i);
    const snap = f.dump();
    // Find an empty slot and turn it into a lone is_continuation (metadata bit1) with a
    // valid remainder -- every WORD stays in range, but the STRUCTURE is impossible.
    const store = snap.store.slice();
    let idx = -1;
    for (let i = 1; i < store.length; i++) {
        if ((store[i] & 7) === 0 && (store[i - 1] & 7) === 0) { idx = i; break; }
    }
    assert.notEqual(idx, -1, "test setup: expected an isolated empty slot");
    store[idx] = (1 << 3) | 2;  // remainder 1, is_continuation set, but no run to continue
    assert.throws(() => Quotient.restore(Object.assign({}, snap, { store, count: snap.count + 1 })),
        /\[lite-filter\].*(corrupt slot structure|metadata-set)/,
        "a structurally-impossible but in-range snapshot must be rejected (REJECT never truncate)");
});

test("QA5b: restore() rejects a shifted cluster-start (in-range words, impossible structure)", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 100; i++) f.add(i);
    const snap = f.dump();
    const store = snap.store.slice();
    // Find an isolated empty slot and make it a shifted run head (is_occupied + is_shifted):
    // a cluster start can never be shifted (nothing lies left of it in its own cluster).
    let idx = -1;
    for (let i = 1; i < store.length; i++) {
        if ((store[i] & 7) === 0 && (store[i - 1] & 7) === 0 &&
            (i + 1 >= store.length || (store[i + 1] & 7) === 0)) { idx = i; break; }
    }
    assert.notEqual(idx, -1, "test setup: expected an isolated empty slot");
    store[idx] = (1 << 3) | 1 | 4;  // remainder 1, is_occupied + is_shifted, no left neighbor
    assert.throws(() => Quotient.restore(Object.assign({}, snap, { store, count: snap.count + 1 })),
        /\[lite-filter\].*(corrupt slot structure|is_shifted)/);
});

/* ============================================================================
 * dump() isolation + re-entrant write + boundary edges.
 * ========================================================================== */

test("QA dump isolation: mutating the filter AFTER dump() does not alter the returned snapshot", () => {
    const f = new Quotient(2000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 500; i++) f.add(i);
    const snap = f.dump();
    const copy = snap.store.slice();
    for (let i = 500; i < 1000; i++) f.add(i);
    for (let i = 0; i < 100; i++) f.remove(i);
    assert.deepEqual(snap.store, copy, "dump() must return an independent copy, not a live view");
    assert.equal(snap.count, 500, "the snapshot count reflects the state AT dump() time");
});

test("QA re-entrant write: a key.toString() that calls add() on the SAME filter mid-hash does not corrupt state", () => {
    const f = new Quotient(1000);
    let reentered = false;
    const fancy = {
        toString() {
            if (!reentered) { reentered = true; f.add("inner"); }
            return "outer";
        },
    };
    f.add(fancy);
    assert.equal(reentered, true, "test setup: the re-entrant call must have fired");
    assert.equal(f.mightContain("inner"), true, "the re-entrant add must have taken effect");
    assert.equal(f.mightContain(fancy), true, "the outer add must have completed despite the nested call");
    assert.equal(f.size, 2, "both adds counted exactly once each");
    validateQuotient(f);
});

test("QA boundary: N=1, INT_MIN/INT_MAX/-0/0 round-trip with remove, and the default backing accepts exotic primitives", () => {
    const f = new Quotient(1, { keys: "int" });
    f.add(9);
    assert.equal(f.remove(9), true);
    assert.equal(f.mightContain(9), false);
    validateQuotient(f);

    const g = new Quotient(10, { keys: "int" });
    for (const k of [-2147483648, 2147483647, -0, 0]) g.add(k);
    for (const k of [-2147483648, 2147483647, -0, 0]) assert.equal(g.mightContain(k), true, "edge " + k);
    validateQuotient(g);

    const h = new Quotient(100);
    for (const k of [null, undefined, NaN, -0, 0, "", "0"]) h.add(k);
    for (const k of [null, undefined, NaN, -0, 0, "", "0"]) assert.equal(h.mightContain(k), true, "arbitrary " + String(k));
    validateQuotient(h);
});
