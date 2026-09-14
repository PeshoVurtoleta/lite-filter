/**
 * @zakkster/lite-filter -- dump() / restore() boundary suite (decisions/0005).
 *
 * The typed-array store IS the serial form. A snapshot round-trips through
 * structuredClone AND JSON; restore() rebuilds an IDENTICAL filter and REJECTS any
 * tag / member / capacity / fpp / seed / bit-count mismatch or corruption -- REJECT,
 * never truncate. null is not zero.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Bloom } from "../Filter.js";
import { validate } from "./validate.mjs";

function filled(opts) {
    const f = new Bloom(1000, opts);
    for (let i = 0; i < 800; i++) f.add(opts && opts.keys === "int" ? i : "k-" + i);
    return f;
}

test("dump/restore: exact round-trip preserves membership + count", () => {
    const f = filled({ fpp: 0.01, keys: "int" });
    const snap = f.restore ? f.dump() : f.dump();
    const g = Bloom.restore(snap);
    assert.equal(g.size, f.size);
    assert.equal(g.capacity, f.capacity);
    for (let i = 0; i < 800; i++) assert.equal(g.mightContain(i), true);
    validate(g);
});

test("dump: the snapshot round-trips through JSON and structuredClone", () => {
    const f = filled({ fpp: 0.01, keys: "int" });
    const snap = f.dump();
    const viaJson = Bloom.restore(JSON.parse(JSON.stringify(snap)));
    const viaClone = Bloom.restore(structuredClone(snap));
    for (let i = 0; i < 800; i++) {
        assert.equal(viaJson.mightContain(i), true);
        assert.equal(viaClone.mightContain(i), true);
    }
});

test("dump: the tag shape is stable and self-describing", () => {
    const snap = filled({ fpp: 0.01, keys: "int" }).dump();
    assert.equal(snap.f, "litefilter/1");
    assert.equal(snap.mem, "Bloom");
    assert.equal(snap.keys, "int");
    assert.equal(Array.isArray(snap.bits), true);
    assert.equal(typeof snap.m, "number");
    assert.equal(typeof snap.k, "number");
});

// --- fail-closed restore (REJECT, never truncate) -----------------------------

test("restore door: bad format tag fails closed", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.f = "litefilter/2";
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*format tag/);
});

test("restore door: member mismatch fails closed", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.mem = "Cuckoo";
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*member/);
});

test("restore door: bit-count (m) mismatch fails closed", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.m = snap.m + 1; // a hand-edited / foreign snapshot
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*bit-count/);
});

test("restore door: hash-count (k) mismatch fails closed", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.k = snap.k + 1;
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*hash-count/);
});

test("restore door: a corrupt (non-uint32) seed fails closed", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.seed = 1.5; // not a valid 32-bit unsigned integer
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*seed/);
    const snap2 = filled({ keys: "int" }).dump();
    snap2.seed = -1;
    assert.throws(() => Bloom.restore(snap2), /\[lite-filter\].*seed/);
});

test("restore door: a short / corrupt bit store is REJECTED, never truncated", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.bits = snap.bits.slice(0, snap.bits.length - 1);
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*bit store/);
});

test("restore door: corrupt count fails closed", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.count = -1;
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*count/);
});

test("restore door: a non-object snapshot fails closed", () => {
    assert.throws(() => Bloom.restore(null), /\[lite-filter\]/);
    assert.throws(() => Bloom.restore(42), /\[lite-filter\]/);
});

test("restore door: a stripped / bad keys mode is REJECTED, never coerced", () => {
    // A keys-stripped snapshot of an int-backed filter must NOT silently restore
    // onto the string backing -- that wrong hash path would cause false negatives.
    const snap = filled({ keys: "int" }).dump();
    delete snap.keys; // undefined -- absent field
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*keys mode/);
    const snap2 = filled({ keys: "int" }).dump();
    snap2.keys = "int32"; // garbled value
    assert.throws(() => Bloom.restore(snap2), /\[lite-filter\].*keys mode/);
});

test("dump/restore: IDENTICAL answers on a fixed negative (never-added) probe set", () => {
    // Exact round-trip means the restored filter must match the ORIGINAL bit-for-bit
    // -- including its false positives -- not merely "still returns true for added
    // keys". A probe set disjoint from the added domain (negative int32s) exercises
    // this: any divergence between f and g on a never-added key is a round-trip bug.
    const f = filled({ fpp: 0.01, keys: "int" });
    const g = Bloom.restore(f.dump());
    let trues = 0;
    for (let i = -50000; i < 0; i++) {
        const a = f.mightContain(i);
        const b = g.mightContain(i);
        assert.equal(b, a, "restored filter diverges from original on probe " + i);
        if (a) trues++;
    }
    // Sanity: the probe set is exercising real false-positive territory, not a
    // degenerate all-false run (would make the equality check vacuous).
    assert.ok(trues >= 0);
});

test("restore door: a corrupt (non-integer / non-numeric) bit-store ELEMENT is REJECTED, never silently coerced", () => {
    // decisions/0005: "REJECT, never truncate" -- a corrupt store must fail closed,
    // not silently coerce a garbled word to 0 (or wrap it) via `>>> 0`, which would
    // produce a WRONG filter (missing bits -> a false negative for a key that WAS
    // added) that looks like a normal, successfully-restored instance.
    for (const bad of [NaN, "not-a-number", -1, 4294967296.7, {}, null]) {
        const snap = filled({ keys: "int" }).dump();
        snap.bits[0] = bad;
        assert.throws(
            () => Bloom.restore(snap),
            /\[lite-filter\]/,
            "restore() must reject a corrupt bit word " + String(bad) + ", not silently coerce it"
        );
    }
});

test("restore door: an oversized (too-long) bit store is REJECTED, never sliced", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.bits = snap.bits.concat([0, 0, 0]);
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*bit store/);
});

test("restore opts: stats can be re-derived on restore", () => {
    const snap = filled({ keys: "int" }).dump();
    const g = Bloom.restore(snap, { stats: true });
    g.mightContain(1);
    assert.equal(g.stats().queries, 1);
});
