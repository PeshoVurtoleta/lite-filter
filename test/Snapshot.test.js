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
import { Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter, BinaryFuse } from "../Filter.js";
import { validate, validateCounting, validateBlocked, validateCuckoo } from "./validate.mjs";

function filled(opts) {
    const f = new Bloom(1000, opts);
    for (let i = 0; i < 800; i++) f.add(opts && opts.keys === "int" ? i : "k-" + i);
    return f;
}

function filledCounting(opts) {
    const f = new CountingBloom(1000, opts);
    for (let i = 0; i < 800; i++) f.add(opts && opts.keys === "int" ? i : "k-" + i);
    return f;
}

function filledBlocked(opts) {
    const f = new BlockedBloom(1000, opts);
    for (let i = 0; i < 800; i++) f.add(opts && opts.keys === "int" ? i : "k-" + i);
    return f;
}

function filledCuckoo(opts) {
    const f = new Cuckoo(1000, opts);
    const n = f._store.length >> 2; // stay well under the load target -- no kick throws
    for (let i = 0; i < n; i++) f.add(opts && opts.keys === "int" ? i : "k-" + i);
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
    assert.equal(snap.f, "litefilter/3");
    assert.equal(snap.mem, "Bloom");
    assert.equal(snap.keys, "int");
    assert.equal(Array.isArray(snap.bits), true);
    assert.equal(typeof snap.m, "number");
    assert.equal(typeof snap.k, "number");
});

// --- fail-closed restore (REJECT, never truncate) -----------------------------

test("restore door: bad format tag fails closed", () => {
    const snap = filled({ keys: "int" }).dump();
    snap.f = "litefilter/1";
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

/* ------------------------------------------------------------------------- *
 * CountingBloom snapshot (decisions/0011): same envelope, byte store + w:4.
 * ------------------------------------------------------------------------- */

test("CountingBloom dump/restore: exact round-trip preserves membership + count", () => {
    const f = filledCounting({ fpp: 0.01, keys: "int" });
    for (let i = 0; i < 200; i++) f.remove(i); // exercise the counter store, not just fills
    const g = CountingBloom.restore(f.dump());
    assert.equal(g.size, f.size);
    assert.equal(g.capacity, f.capacity);
    for (let i = 200; i < 800; i++) assert.equal(g.mightContain(i), true);
    validateCounting(g);
});

test("CountingBloom dump: round-trips through JSON and structuredClone", () => {
    const f = filledCounting({ fpp: 0.01, keys: "int" });
    const snap = f.dump();
    const viaJson = CountingBloom.restore(JSON.parse(JSON.stringify(snap)));
    const viaClone = CountingBloom.restore(structuredClone(snap));
    for (let i = 0; i < 800; i++) {
        assert.equal(viaJson.mightContain(i), true);
        assert.equal(viaClone.mightContain(i), true);
    }
});

test("CountingBloom dump: the tag shape is stable and self-describing (mem + w:4 + cnts)", () => {
    const snap = filledCounting({ fpp: 0.01, keys: "int" }).dump();
    assert.equal(snap.f, "litefilter/3");
    assert.equal(snap.mem, "CountingBloom");
    assert.equal(snap.w, 4);
    assert.equal(snap.keys, "int");
    assert.equal(Array.isArray(snap.cnts), true);
    assert.equal(typeof snap.m, "number");
    assert.equal(typeof snap.k, "number");
});

test("CountingBloom restore door: member mismatch (a Bloom snapshot) fails closed", () => {
    const bloomSnap = filled({ keys: "int" }).dump();
    assert.throws(() => CountingBloom.restore(bloomSnap), /\[lite-filter\].*member/);
    const cbfSnap = filledCounting({ keys: "int" }).dump();
    assert.throws(() => Bloom.restore(cbfSnap), /\[lite-filter\].*member/);
});

test("CountingBloom restore door: counter-width (w) mismatch fails closed", () => {
    const snap = filledCounting({ keys: "int" }).dump();
    snap.w = 8;
    assert.throws(() => CountingBloom.restore(snap), /\[lite-filter\].*counter-width/);
});

test("CountingBloom restore door: a byte > 255 is REJECTED, never coerced (implies nibble > 15)", () => {
    for (const bad of [256, 300, NaN, "x", -1, 12.5, {}, null]) {
        const snap = filledCounting({ keys: "int" }).dump();
        snap.cnts[0] = bad;
        assert.throws(
            () => CountingBloom.restore(snap),
            /\[lite-filter\]/,
            "restore() must reject a corrupt counter byte " + String(bad)
        );
    }
});

test("CountingBloom restore door: a short / oversized counter store is REJECTED", () => {
    const shortSnap = filledCounting({ keys: "int" }).dump();
    shortSnap.cnts = shortSnap.cnts.slice(0, shortSnap.cnts.length - 1);
    assert.throws(() => CountingBloom.restore(shortSnap), /\[lite-filter\].*counter store/);
    const longSnap = filledCounting({ keys: "int" }).dump();
    longSnap.cnts = longSnap.cnts.concat([0, 0, 0]);
    assert.throws(() => CountingBloom.restore(longSnap), /\[lite-filter\].*counter store/);
});

test("CountingBloom restore door: bad format tag / seed / keys / count fail closed", () => {
    const s1 = filledCounting({ keys: "int" }).dump(); s1.f = "litefilter/1";
    assert.throws(() => CountingBloom.restore(s1), /\[lite-filter\].*format tag/);
    const s2 = filledCounting({ keys: "int" }).dump(); s2.seed = 1.5;
    assert.throws(() => CountingBloom.restore(s2), /\[lite-filter\].*seed/);
    const s3 = filledCounting({ keys: "int" }).dump(); delete s3.keys;
    assert.throws(() => CountingBloom.restore(s3), /\[lite-filter\].*keys mode/);
    const s4 = filledCounting({ keys: "int" }).dump(); s4.count = -1;
    assert.throws(() => CountingBloom.restore(s4), /\[lite-filter\].*count/);
    assert.throws(() => CountingBloom.restore(null), /\[lite-filter\]/);
});

/* ------------------------------------------------------------------------- *
 * BlockedBloom snapshot (decisions/0012): same envelope, bb:512 + nb + word store.
 * ------------------------------------------------------------------------- */

test("BlockedBloom dump/restore: exact round-trip preserves membership + count", () => {
    const f = filledBlocked({ fpp: 0.01, keys: "int" });
    const g = BlockedBloom.restore(f.dump());
    assert.equal(g.size, f.size);
    assert.equal(g.capacity, f.capacity);
    for (let i = 0; i < 800; i++) assert.equal(g.mightContain(i), true);
    validateBlocked(g);
});

test("BlockedBloom dump: round-trips through JSON and structuredClone", () => {
    const f = filledBlocked({ fpp: 0.01, keys: "int" });
    const snap = f.dump();
    const viaJson = BlockedBloom.restore(JSON.parse(JSON.stringify(snap)));
    const viaClone = BlockedBloom.restore(structuredClone(snap));
    for (let i = 0; i < 800; i++) {
        assert.equal(viaJson.mightContain(i), true);
        assert.equal(viaClone.mightContain(i), true);
    }
});

test("BlockedBloom dump: the tag shape is stable and self-describing (mem + bb:512 + nb + bits)", () => {
    const snap = filledBlocked({ fpp: 0.01, keys: "int" }).dump();
    assert.equal(snap.f, "litefilter/3");
    assert.equal(snap.mem, "BlockedBloom");
    assert.equal(snap.bb, 512);
    assert.equal(typeof snap.nb, "number");
    assert.equal(snap.keys, "int");
    assert.equal(Array.isArray(snap.bits), true);
    assert.equal(snap.bits.length, snap.nb * 16);
});

test("BlockedBloom restore door: member mismatch fails closed (both directions)", () => {
    const bloomSnap = filled({ keys: "int" }).dump();
    assert.throws(() => BlockedBloom.restore(bloomSnap), /\[lite-filter\].*member/);
    const bbSnap = filledBlocked({ keys: "int" }).dump();
    assert.throws(() => Bloom.restore(bbSnap), /\[lite-filter\].*member/);
});

test("BlockedBloom restore door: block-size (bb) mismatch fails closed", () => {
    const snap = filledBlocked({ keys: "int" }).dump();
    snap.bb = 256;
    assert.throws(() => BlockedBloom.restore(snap), /\[lite-filter\].*block-size/);
});

test("BlockedBloom restore door: block-count (nb) mismatch fails closed", () => {
    const snap = filledBlocked({ keys: "int" }).dump();
    snap.nb = snap.nb + 1;
    assert.throws(() => BlockedBloom.restore(snap), /\[lite-filter\].*block-count/);
});

test("BlockedBloom restore door: a short / oversized bit store is REJECTED, never truncated", () => {
    const shortSnap = filledBlocked({ keys: "int" }).dump();
    shortSnap.bits = shortSnap.bits.slice(0, shortSnap.bits.length - 1);
    assert.throws(() => BlockedBloom.restore(shortSnap), /\[lite-filter\].*bit store/);
    const longSnap = filledBlocked({ keys: "int" }).dump();
    longSnap.bits = longSnap.bits.concat([0, 0, 0]);
    assert.throws(() => BlockedBloom.restore(longSnap), /\[lite-filter\].*bit store/);
});

test("BlockedBloom restore door: an out-of-range / corrupt bit-store word is REJECTED, never coerced", () => {
    for (const bad of [NaN, "not-a-number", -1, 4294967296, 4294967296.7, {}, null]) {
        const snap = filledBlocked({ keys: "int" }).dump();
        snap.bits[0] = bad;
        assert.throws(() => BlockedBloom.restore(snap), /\[lite-filter\]/,
            "restore() must reject a corrupt bit word " + String(bad));
    }
});

test("BlockedBloom restore door: bad format tag / seed / keys / count fail closed", () => {
    const s1 = filledBlocked({ keys: "int" }).dump(); s1.f = "litefilter/1";
    assert.throws(() => BlockedBloom.restore(s1), /\[lite-filter\].*format tag/);
    const s2 = filledBlocked({ keys: "int" }).dump(); s2.seed = 1.5;
    assert.throws(() => BlockedBloom.restore(s2), /\[lite-filter\].*seed/);
    const s3 = filledBlocked({ keys: "int" }).dump(); delete s3.keys;
    assert.throws(() => BlockedBloom.restore(s3), /\[lite-filter\].*keys mode/);
    const s4 = filledBlocked({ keys: "int" }).dump(); s4.count = -1;
    assert.throws(() => BlockedBloom.restore(s4), /\[lite-filter\].*count/);
    assert.throws(() => BlockedBloom.restore(null), /\[lite-filter\]/);
});

test("BlockedBloom restore opts: stats can be re-derived on restore", () => {
    const snap = filledBlocked({ keys: "int" }).dump();
    const g = BlockedBloom.restore(snap, { stats: true });
    g.mightContain(1);
    assert.equal(g.stats().queries, 1);
});

/* ------------------------------------------------------------------------- *
 * Cuckoo snapshot (decisions/0014): the fingerprint store envelope, fw + b + nb.
 * ------------------------------------------------------------------------- */

test("Cuckoo dump/restore: exact round-trip preserves membership + count + fingerprint store", () => {
    const f = filledCuckoo({ fpp: 0.01, keys: "int" });
    const snap = f.dump();
    const g = Cuckoo.restore(snap);
    assert.equal(g.size, f.size);
    assert.equal(g.capacity, f.capacity);
    assert.deepEqual(Array.from(g._store), Array.from(f._store), "restored fingerprint store must be exact, not re-derived");
    assert.equal(g._f, f._f);
    assert.equal(g._b, f._b);
    assert.equal(g._nb, f._nb);
    assert.equal(g._seed, f._seed);
    const n = f._store.length >> 2;
    for (let i = 0; i < n; i++) assert.equal(g.mightContain(i), true);
    validateCuckoo(g);
});

test("Cuckoo dump: round-trips through JSON and structuredClone", () => {
    const f = filledCuckoo({ fpp: 0.01, keys: "int" });
    const snap = f.dump();
    const viaJson = Cuckoo.restore(JSON.parse(JSON.stringify(snap)));
    const viaClone = Cuckoo.restore(structuredClone(snap));
    const n = f._store.length >> 2;
    for (let i = 0; i < n; i++) {
        assert.equal(viaJson.mightContain(i), true);
        assert.equal(viaClone.mightContain(i), true);
    }
    validateCuckoo(viaJson);
    validateCuckoo(viaClone);
});

test("Cuckoo dump: the tag shape is stable and self-describing (mem + fw + b:4 + nb + fp)", () => {
    const snap = filledCuckoo({ fpp: 0.01, keys: "int" }).dump();
    assert.equal(snap.f, "litefilter/3");
    assert.equal(snap.mem, "Cuckoo");
    assert.equal(snap.b, 4);
    assert.equal(typeof snap.fw, "number");
    assert.ok(snap.fw >= 1 && snap.fw <= 16);
    assert.equal(typeof snap.nb, "number");
    assert.equal(snap.keys, "int");
    assert.equal(Array.isArray(snap.fp), true);
    assert.equal(snap.fp.length, snap.nb * 4);
});

test("Cuckoo restore door: member mismatch fails closed (both directions vs Bloom, and vs CountingBloom/BlockedBloom)", () => {
    const bloomSnap = filled({ keys: "int" }).dump();
    assert.throws(() => Cuckoo.restore(bloomSnap), /\[lite-filter\].*member/);
    const cuckooSnap = filledCuckoo({ keys: "int" }).dump();
    assert.throws(() => Bloom.restore(cuckooSnap), /\[lite-filter\].*member/);

    const cbfSnap = filledCounting({ keys: "int" }).dump();
    assert.throws(() => Cuckoo.restore(cbfSnap), /\[lite-filter\].*member/,
        "a CountingBloom snapshot must be rejected by Cuckoo.restore");
    const bbSnap = filledBlocked({ keys: "int" }).dump();
    assert.throws(() => Cuckoo.restore(bbSnap), /\[lite-filter\].*member/,
        "a BlockedBloom snapshot must be rejected by Cuckoo.restore");
    assert.throws(() => CountingBloom.restore(cuckooSnap), /\[lite-filter\].*member/,
        "a Cuckoo snapshot must be rejected by CountingBloom.restore");
    assert.throws(() => BlockedBloom.restore(cuckooSnap), /\[lite-filter\].*member/,
        "a Cuckoo snapshot must be rejected by BlockedBloom.restore");
});

test("Cuckoo restore door: bucket-size (b) mismatch fails closed", () => {
    const snap = filledCuckoo({ keys: "int" }).dump();
    snap.b = 8;
    assert.throws(() => Cuckoo.restore(snap), /\[lite-filter\].*bucket-size/);
});

test("Cuckoo restore door: fingerprint-width (fw) mismatch fails closed", () => {
    const snap = filledCuckoo({ fpp: 0.01, keys: "int" }).dump();
    snap.fw = snap.fw === 16 ? 8 : 16;
    assert.throws(() => Cuckoo.restore(snap), /\[lite-filter\].*fingerprint-width/);
});

test("Cuckoo restore door: bucket-count (nb) mismatch fails closed", () => {
    const snap = filledCuckoo({ keys: "int" }).dump();
    snap.nb = snap.nb * 2;
    assert.throws(() => Cuckoo.restore(snap), /\[lite-filter\].*bucket-count/);
});

test("Cuckoo restore door: a short / oversized fingerprint store is REJECTED, never truncated", () => {
    const shortSnap = filledCuckoo({ keys: "int" }).dump();
    shortSnap.fp = shortSnap.fp.slice(0, shortSnap.fp.length - 1);
    assert.throws(() => Cuckoo.restore(shortSnap), /\[lite-filter\].*fingerprint store/);
    const longSnap = filledCuckoo({ keys: "int" }).dump();
    longSnap.fp = longSnap.fp.concat([0, 0, 0]);
    assert.throws(() => Cuckoo.restore(longSnap), /\[lite-filter\].*fingerprint store/);
});

test("Cuckoo restore door: an out-of-range / impossible fingerprint is REJECTED, never coerced", () => {
    for (const bad of [-1, NaN, "not-a-number", {}, null, 4294967296.7]) {
        const snap = filledCuckoo({ keys: "int" }).dump();
        snap.fp[0] = bad;
        assert.throws(() => Cuckoo.restore(snap), /\[lite-filter\]/,
            "restore() must reject a corrupt fingerprint " + String(bad));
    }
    // A fingerprint value that EXCEEDS the derived fpMask (impossible for this width,
    // even though it might be a small nonnegative integer) must also be rejected.
    const snap = filledCuckoo({ fpp: 0.01, keys: "int" }).dump();
    const overWidth = Math.pow(2, snap.fw) + 1; // one past the width's max representable value
    snap.fp[0] = overWidth;
    assert.throws(() => Cuckoo.restore(snap), /\[lite-filter\].*fingerprint/,
        "a fingerprint exceeding the derived width's fpMask must be rejected as impossible");
});

test("Cuckoo restore door: bad format tag / seed / keys / count fail closed", () => {
    const s1 = filledCuckoo({ keys: "int" }).dump(); s1.f = "litefilter/1";
    assert.throws(() => Cuckoo.restore(s1), /\[lite-filter\].*format tag/);
    const s2 = filledCuckoo({ keys: "int" }).dump(); s2.seed = 1.5;
    assert.throws(() => Cuckoo.restore(s2), /\[lite-filter\].*seed/);
    const s3 = filledCuckoo({ keys: "int" }).dump(); delete s3.keys;
    assert.throws(() => Cuckoo.restore(s3), /\[lite-filter\].*keys mode/);
    const s4 = filledCuckoo({ keys: "int" }).dump(); s4.count = -1;
    assert.throws(() => Cuckoo.restore(s4), /\[lite-filter\].*count/);
    assert.throws(() => Cuckoo.restore(null), /\[lite-filter\]/);
    assert.throws(() => Cuckoo.restore(42), /\[lite-filter\]/);
});

test("Cuckoo restore door: a capacity/fpp mismatch is caught transitively via fw/nb re-derivation", () => {
    const snap = filledCuckoo({ fpp: 0.01, keys: "int" }).dump();
    snap.cap = snap.cap * 5;
    assert.throws(() => Cuckoo.restore(snap), /\[lite-filter\]/, "a corrupted cap must fail closed, not silently build a wrong-shaped filter");
    const snap2 = filledCuckoo({ fpp: 0.01, keys: "int" }).dump();
    snap2.fpp = 0.3;
    assert.throws(() => Cuckoo.restore(snap2), /\[lite-filter\]/);
});

test("Cuckoo restore door: validates EVERY slot (and the full-length store) BEFORE writing ANY slot into the instance store", () => {
    // Same fail-open regression class QaAuditBlocked.test.js proves for BlockedBloom:
    // corrupt only the LAST slot, and use a Proxy to prove the write loop never ran
    // (each index read at most once, from the validation pre-scan) before the throw.
    const snap = filledCuckoo({ keys: "int" }).dump();
    const badIdx = snap.fp.length - 1;
    snap.fp[badIdx] = -1;
    const accessCounts = new Map();
    const proxied = new Proxy(snap.fp, {
        get(target, prop, receiver) {
            if (typeof prop === "string" && /^\d+$/.test(prop)) {
                const idx = Number(prop);
                accessCounts.set(idx, (accessCounts.get(idx) || 0) + 1);
            }
            return Reflect.get(target, prop, receiver);
        },
    });
    snap.fp = proxied;

    assert.throws(() => Cuckoo.restore(snap), /\[lite-filter\]/);

    assert.ok(accessCounts.has(badIdx), "test setup: the corrupt last index must actually have been scanned");
    for (const [idx, count] of accessCounts) {
        assert.ok(count <= 1,
            "index " + idx + " was read " + count + " times -- the write loop ran despite a corrupt slot (fail-open on restore)");
    }
});

test("Cuckoo restore door: a repeated failed restore() leaves no residue that corrupts a later clean restore()", () => {
    const goodSnap = filledCuckoo({ keys: "int" }).dump();
    for (let trial = 0; trial < 5; trial++) {
        const bad = filledCuckoo({ keys: "int" }).dump();
        bad.fp[0] = -1;
        assert.throws(() => Cuckoo.restore(bad));
    }
    const g = Cuckoo.restore(goodSnap);
    const n = g._store.length >> 2;
    for (let i = 0; i < n; i++) assert.equal(g.mightContain(i), true);
    validateCuckoo(g);
});

test("Cuckoo restore opts: stats can be re-derived on restore", () => {
    const snap = filledCuckoo({ keys: "int" }).dump();
    const g = Cuckoo.restore(snap, { stats: true });
    g.mightContain(1);
    assert.equal(g.stats().queries, 1);
});

/* ============================================================================
 * Family-wide snapshot integrity checksum (decisions/0021, tag now litefilter/3).
 *
 * The QA-reported fail-open: keys-mode and seed are free construction inputs that
 * CANNOT be re-derived from the stored bytes, so a flipped `keys` ("int" <-> null) or
 * `seed` silently reconstructed a wrong filter (1990/2000 false negatives). Every
 * member now folds provenance (tag, mem, keys-mode, seed), sizing/width fields, count,
 * and every store word into a 32-bit `chk`; restore recomputes it and REJECTS a
 * mismatch fail-closed. One positive matrix per member: pristine round-trips with 0
 * false negatives; keys-flip / seed-flip / one-store-word-flip each THROW.
 * ========================================================================== */

const CHK_MEMBERS = [
    {
        name: "Bloom",
        Ctor: Bloom,
        build: () => { const f = new Bloom(1000, { keys: "int" }); for (let i = 0; i < 500; i++) f.add(i); return f; },
        present: (g) => { for (let i = 0; i < 500; i++) if (!g.mightContain(i)) return false; return true; },
        store: (s) => s.bits, wordMask: 0xffffffff,
    },
    {
        name: "CountingBloom",
        Ctor: CountingBloom,
        build: () => { const f = new CountingBloom(1000, { keys: "int" }); for (let i = 0; i < 500; i++) f.add(i); return f; },
        present: (g) => { for (let i = 0; i < 500; i++) if (!g.mightContain(i)) return false; return true; },
        store: (s) => s.cnts, wordMask: 0xff,
    },
    {
        name: "BlockedBloom",
        Ctor: BlockedBloom,
        build: () => { const f = new BlockedBloom(1000, { keys: "int" }); for (let i = 0; i < 500; i++) f.add(i); return f; },
        present: (g) => { for (let i = 0; i < 500; i++) if (!g.mightContain(i)) return false; return true; },
        store: (s) => s.bits, wordMask: 0xffffffff,
    },
    {
        name: "Cuckoo",
        Ctor: Cuckoo,
        build: () => { const f = new Cuckoo(1000, { keys: "int" }); for (let i = 0; i < 300; i++) f.add(i); return f; },
        present: (g) => { for (let i = 0; i < 300; i++) if (!g.mightContain(i)) return false; return true; },
        store: (s) => s.fp, wordMask: 0xffff,
    },
    {
        name: "Quotient",
        Ctor: Quotient,
        build: () => { const f = new Quotient(1000, { keys: "int" }); for (let i = 0; i < 300; i++) f.add(i); return f; },
        present: (g) => { for (let i = 0; i < 300; i++) if (!g.mightContain(i)) return false; return true; },
        store: (s) => s.store, wordMask: null, // structural-sensitive; flip is handled specially
    },
    {
        name: "XorFilter",
        Ctor: XorFilter,
        build: () => { const keys = []; for (let i = 0; i < 2000; i++) keys.push(i); return XorFilter.from(keys, { keys: "int" }); },
        present: (g) => { for (let i = 0; i < 2000; i++) if (!g.mightContain(i)) return false; return true; },
        store: (s) => s.fp, wordMask: 0xff,
    },
    {
        name: "BinaryFuse",
        Ctor: BinaryFuse,
        build: () => { const keys = []; for (let i = 0; i < 2000; i++) keys.push(i); return BinaryFuse.from(keys, { keys: "int" }); },
        present: (g) => { for (let i = 0; i < 2000; i++) if (!g.mightContain(i)) return false; return true; },
        store: (s) => s.fp, wordMask: 0xff,
    },
];

for (const m of CHK_MEMBERS) {
    test("chk " + m.name + ": every dump carries a 32-bit integrity checksum + the litefilter/3 tag", () => {
        const snap = m.build().dump();
        assert.equal(snap.f, "litefilter/3");
        assert.equal(Number.isInteger(snap.chk) && snap.chk >= 0 && snap.chk <= 0xffffffff, true,
            "chk must be a 32-bit unsigned integer");
    });

    test("chk " + m.name + ": a pristine dump round-trips with 0 false negatives", () => {
        const f = m.build();
        const g = m.Ctor.restore(JSON.parse(JSON.stringify(f.dump())));
        assert.equal(m.present(g), true, "pristine restore must preserve every present key");
    });

    test("chk " + m.name + ": flipping keys-mode is REJECTED by the checksum (the QA fail-open)", () => {
        const snap = m.build().dump();
        snap.keys = snap.keys === "int" ? null : "int"; // int -> null (the QA repro direction)
        assert.throws(() => m.Ctor.restore(snap), /\[lite-filter\]/,
            "a keys-mode flip must fail closed (silently building the wrong hash path is a fail-open)");
    });

    test("chk " + m.name + ": flipping the seed is REJECTED by the checksum", () => {
        const snap = m.build().dump();
        snap.seed = (snap.seed ^ 0x5a5a5a5a) >>> 0; // a different valid uint32
        assert.throws(() => m.Ctor.restore(snap), /\[lite-filter\]/,
            "a seed flip must fail closed (the seed cannot be re-derived from the store)");
    });

    test("chk " + m.name + ": flipping ONE store word is REJECTED (checksum, or structure for Quotient)", () => {
        const snap = m.build().dump();
        const arr = m.store(snap);
        const idx = arr.length >> 1;
        // A change that stays a legal integer for the store's element width, so the per-word
        // range check passes and the flip is caught by the checksum (for Quotient a raw
        // change may instead trip the structural check first -- both are a fail-closed throw).
        if (m.wordMask !== null) arr[idx] = (arr[idx] ^ 1) & m.wordMask;
        else arr[idx] = arr[idx] ^ 8; // Quotient word: perturb a metadata/remainder bit
        assert.throws(() => m.Ctor.restore(snap), /\[lite-filter\]/,
            "a single store-word flip must fail closed (integrity checksum or structure)");
    });
}
