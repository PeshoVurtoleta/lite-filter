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

test("restore door: seed mismatch fails closed", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.seed = (snap.seed ^ 0xff) >>> 0;
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*seed/);
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

test("restore opts: stats can be re-derived on restore", () => {
    const snap = filled({ keys: "int" }).dump();
    const g = Bloom.restore(snap, { stats: true });
    g.mightContain(1);
    assert.equal(g.stats().queries, 1);
});
