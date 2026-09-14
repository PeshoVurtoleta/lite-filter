/**
 * @zakkster/lite-filter -- node:test boundary suite (Quotient semantics).
 *
 * Mirrors Cuckoo.test.js: every public method, the one-sided LAW, the DELETE semantics
 * (decisions/0016, 0017), the merge/resize cold-path contracts, the remainder-quantized
 * fpp() honesty, the fail-closed load ceiling, and every construction door is named as a
 * test so a refactor cannot silently flip behavior. validateQuotient() (the metadata
 * conservation + structure invariant) runs after mutating tests as a backstop -- the
 * planner's flagged risk (shift-back metadata repair) is checked structurally, not just
 * via false-negative counts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Quotient, VERSION } from "../Filter.js";
import { validateQuotient } from "./validate.mjs";
import { differentialInt, differentialChurnInt } from "./torture/oracle.mjs";

test("exports: Quotient is a named export; VERSION is a string", async () => {
    const mod = await import("../Filter.js");
    assert.equal(mod.Quotient, Quotient);
    assert.equal(typeof VERSION, "string");
    assert.ok(VERSION.length > 0);
});

test("getters: size/count/capacity reflect state", () => {
    const f = new Quotient(100, { keys: "int" });
    assert.equal(f.capacity, 100);
    assert.equal(f.size, 0);
    assert.equal(f.count, 0);
    f.add(1);
    assert.equal(f.size, 1);
    assert.equal(f.count, 1);
    validateQuotient(f);
});

// --- one-sided LAWS -----------------------------------------------------------

test("law: an added key ALWAYS reads true (no false negatives)", () => {
    const f = new Quotient(2000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1500; i++) f.add(i);
    for (let i = 0; i < 1500; i++) {
        assert.equal(f.mightContain(i), true, "false negative on key " + i);
    }
    validateQuotient(f);
});

test("law: has() is the sole alias of mightContain (same result)", () => {
    const f = new Quotient(100, { keys: "int" });
    f.add(7);
    assert.equal(f.has(7), f.mightContain(7));
    assert.equal(f.has(7), true);
    assert.equal(f.has(999999), f.mightContain(999999));
});

test("law: a never-added key is usually false; a true is a false positive", () => {
    const f = new Quotient(2000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1500; i++) f.add(i);
    let trues = 0;
    for (let i = 100000; i < 110000; i++) if (f.mightContain(i)) trues++;
    assert.ok(trues < 10000, "every probe was a false positive -- structure is broken");
});

test("bounded FPR: 0 false negatives and the measured FPR sits under the honest ceiling", () => {
    const r = differentialInt(Quotient, { n: 20000, fpp: 0.01, probes: 200000, seed: 12345 });
    assert.equal(r.falseNegatives, 0, "no false negatives allowed");
    assert.ok(r.fpr <= 0.01, "measured FPR " + r.fpr + " must sit at or under the configured target");
});

// --- int backing --------------------------------------------------------------

test("keys:'int' round-trips integer keys with no false negatives", () => {
    const f = new Quotient(500, { keys: "int" });
    for (let i = -250; i < 250; i++) f.add(i);
    for (let i = -250; i < 250; i++) assert.equal(f.mightContain(i), true);
    validateQuotient(f);
});

// --- fpp() reporting: configured while empty, remainder-quantized once filled ------

test("fpp(): configured target while empty, remainder-quantized load*2^-r once filled, BELOW the configured 0.01 target", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int" });
    assert.equal(f.fpp(), 0.01, "empty filter reports the configured target");
    // r = ceil(log2(1/0.01)) = ceil(log2(100)) = 7.
    assert.equal(f._r, 7, "test setup: expected remainder width 7 at fpp=0.01");
    for (let i = 0; i < 500; i++) f.add(i);
    const rate = f.fpp();
    assert.equal(rate, (f.size / f._nslots) * Math.pow(2, -f._r));
    assert.ok(rate < 0.01, "the byte-aligned remainder width must deliver a rate BELOW the configured 0.01 (decisions/0016 honesty)");
});

// --- clear() ------------------------------------------------------------------

test("clear(): empties the filter and reuses the same ArrayBuffer", () => {
    const f = new Quotient(100, { keys: "int" });
    const buf = f._store.buffer;
    for (let i = 0; i < 50; i++) f.add(i);
    assert.equal(f.mightContain(0), true);
    f.clear();
    assert.equal(f.size, 0);
    assert.equal(f._store.buffer, buf, "clear() must not reallocate");
    assert.equal(f.mightContain(0), false);
    validateQuotient(f);
});

test("clear(): stats are cumulative instrumentation and SURVIVE a clear()", () => {
    const f = new Quotient(100, { keys: "int", stats: true });
    f.add(1); f.add(2);
    f.mightContain(1);
    f.mightContain(999999);
    const before = f.stats();
    assert.equal(before.adds, 2);
    assert.equal(before.queries, 2);
    f.clear();
    assert.equal(f.size, 0);
    const after = f.stats();
    assert.equal(after, before, "clear() must not reallocate the stats holder");
    assert.equal(after.adds, 2, "adds survive clear()");
    f.resetStats();
    assert.equal(f.stats().adds, 0);
});

// --- opt-in stats -------------------------------------------------------------

test("stats: OFF by default -- accessors fail closed", () => {
    const f = new Quotient(10, { keys: "int" });
    assert.throws(() => f.stats(), /\[lite-filter\]/);
    assert.throws(() => f.resetStats(), /\[lite-filter\]/);
});

test("stats: ON counts adds/queries/hits/misses", () => {
    const f = new Quotient(100, { keys: "int", stats: true });
    f.add(1); f.add(2);
    assert.equal(f.mightContain(1), true);
    f.mightContain(999999);
    const s = f.stats();
    assert.equal(s.adds, 2);
    assert.equal(s.queries, 2);
    assert.equal(s.hits >= 1, true);
    f.resetStats();
    assert.equal(f.stats().adds, 0);
});

test("stats: unknown option fails closed with a did-you-mean hint", () => {
    assert.throws(() => new Quotient(10, { stats: 1 }), /did you mean true\?/);
});

// --- remove() -> boolean semantics --------------------------------------------

test("remove: a present key returns true, then reads absent, and size decrements", () => {
    const f = new Quotient(100, { keys: "int" });
    f.add(42);
    assert.equal(f.size, 1);
    assert.equal(f.remove(42), true);
    assert.equal(f.mightContain(42), false);
    assert.equal(f.size, 0);
    validateQuotient(f);
});

test("remove: a never-added key returns false and mutates NOTHING", () => {
    const f = new Quotient(1000, { keys: "int" });
    for (let i = 0; i < 500; i++) f.add(i);
    const before = Array.from(f._store);
    const sizeBefore = f.size;
    let probe = 10_000_000;
    while (f.mightContain(probe)) probe++;  // pick a probe the filter itself denies
    assert.equal(f.remove(probe), false, "removing a key the filter reports absent must return false");
    assert.deepEqual(Array.from(f._store), before, "absent remove must not mutate the store");
    assert.equal(f.size, sizeBefore, "absent remove must not change size");
    validateQuotient(f);
});

test("remove: a second remove of an already-removed key returns false, no mutation", () => {
    const f = new Quotient(100, { keys: "int" });
    f.add(3);
    assert.equal(f.remove(3), true);
    const before = Array.from(f._store);
    assert.equal(f.remove(3), false);
    assert.deepEqual(Array.from(f._store), before);
});

test("differential: mixed add/remove churn (bounded keyspace) -> 0 false negatives + size==present, structure intact", () => {
    const r = differentialChurnInt(Quotient,
        { n: 5000, fpp: 0.01, ops: 60000, seed: 24680, keyspace: 3000 });
    assert.equal(r.falseNegatives, 0, "no false negatives allowed for currently-present keys");
    assert.equal(r.present, r.filterSize, "the filter size must track the oracle present-set size");
});

test("shift-back repair: validateQuotient passes after heavy add/remove churn (the flagged risk)", () => {
    const f = new Quotient(4000, { fpp: 0.01, keys: "int", seed: 777 });
    let x = 42 >>> 0;
    const rng = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
    const live = new Set();
    for (let i = 0; i < 100000; i++) {
        const k = rng() % 4000;
        if (live.has(k)) { f.remove(k); live.delete(k); } else { f.add(k); live.add(k); }
    }
    for (const k of live) assert.equal(f.mightContain(k), true, "live key " + k + " must read present");
    assert.equal(f.size, live.size);
    validateQuotient(f);
});

// --- resize() cold path -------------------------------------------------------

test("resize: grow preserves membership (0 FN) and exact size", () => {
    const f = new Quotient(2000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1500; i++) f.add(i);
    const sizeBefore = f.size;
    const nslotsBefore = f._nslots;
    f.resize(20000);
    assert.ok(f._nslots > nslotsBefore, "grow must enlarge the slot count");
    assert.equal(f.size, sizeBefore, "resize must preserve size");
    for (let i = 0; i < 1500; i++) assert.equal(f.mightContain(i), true, "key " + i + " lost on grow");
    validateQuotient(f);
});

test("resize: shrink preserves membership (0 FN) and exact size", () => {
    const f = new Quotient(20000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1500; i++) f.add(i);
    const sizeBefore = f.size;
    f.resize(2000);
    assert.equal(f.size, sizeBefore, "resize must preserve size");
    for (let i = 0; i < 1500; i++) assert.equal(f.mightContain(i), true, "key " + i + " lost on shrink");
    validateQuotient(f);
});

test("resize: refuses to lose data -- a target below the current occupancy still holds everything", () => {
    const f = new Quotient(20000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 5000; i++) f.add(i);
    f.resize(1);  // absurdly small -- resize sizes for max(newCapacity, count)
    assert.equal(f.size, 5000);
    for (let i = 0; i < 5000; i++) assert.equal(f.mightContain(i), true);
    validateQuotient(f);
});

// --- merge() cold path --------------------------------------------------------

test("merge: disjoint union preserves membership (0 FN) and additive size", () => {
    const A = new Quotient(4000, { fpp: 0.01, keys: "int" });
    const B = new Quotient(4000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1000; i++) A.add(i);
    for (let i = 5000; i < 6000; i++) B.add(i);
    const expected = A.size + B.size;
    A.merge(B);
    assert.equal(A.size, expected, "disjoint merge must be additive in size");
    for (let i = 0; i < 1000; i++) assert.equal(A.mightContain(i), true, "A key " + i + " lost on merge");
    for (let i = 5000; i < 6000; i++) assert.equal(A.mightContain(i), true, "B key " + i + " lost on merge");
    validateQuotient(A);
});

test("merge: rejects a mismatched filter fail-closed", () => {
    const A = new Quotient(1000, { fpp: 0.01, keys: "int", seed: 1 });
    assert.throws(() => A.merge(new Quotient(1000, { fpp: 0.01, keys: "int", seed: 2 })),
        /\[lite-filter\].*merge/, "different seed must reject");
    assert.throws(() => A.merge(new Quotient(1000, { fpp: 0.02, keys: "int", seed: 1 })),
        /\[lite-filter\].*merge/, "different fpp (r/p) must reject");
    assert.throws(() => A.merge(new Quotient(1000, { fpp: 0.01, seed: 1 })),
        /\[lite-filter\].*merge/, "different keys mode must reject");
    assert.throws(() => A.merge({}), /\[lite-filter\].*merge/, "a non-Quotient must reject");
});

// --- dump()/restore() ---------------------------------------------------------

test("dump/restore: round-trips membership; restore emits a fresh independent filter", () => {
    const f = new Quotient(2000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1500; i++) f.add(i);
    const snap = f.dump();
    assert.equal(snap.mem, "Quotient");
    assert.equal(snap.f, "litefilter/1");
    const g = Quotient.restore(snap);
    assert.equal(g.size, f.size);
    for (let i = 0; i < 1500; i++) assert.equal(g.mightContain(i), true, "key " + i + " lost on restore");
    // mutate g -- f (the source) must be unaffected (independent stores).
    g.add(999999);
    assert.equal(f.mightContain(999999), false);
    validateQuotient(g);
});

test("dump/restore: a RESIZED filter round-trips at its resized geometry", () => {
    const f = new Quotient(2000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1500; i++) f.add(i);
    f.resize(20000);
    const snap = f.dump();
    const g = Quotient.restore(snap);
    assert.equal(g._nslots, f._nslots, "restore must honor the resized slot count");
    assert.equal(g.size, f.size);
    for (let i = 0; i < 1500; i++) assert.equal(g.mightContain(i), true);
    validateQuotient(g);
});

test("restore door: bad tag / member / corrupt fields fail closed (REJECT never truncate)", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 100; i++) f.add(i);
    const good = f.dump();
    assert.throws(() => Quotient.restore(null), /\[lite-filter\]/);
    assert.throws(() => Quotient.restore(Object.assign({}, good, { f: "nope" })), /format tag/);
    assert.throws(() => Quotient.restore(Object.assign({}, good, { mem: "Bloom" })), /member mismatch/);
    assert.throws(() => Quotient.restore(Object.assign({}, good, { seed: -1 })), /corrupt seed/);
    assert.throws(() => Quotient.restore(Object.assign({}, good, { keys: "nope" })), /corrupt keys/);
    assert.throws(() => Quotient.restore(Object.assign({}, good, { store: good.store.slice(0, -1) })),
        /corrupt slot store/);
    // A slot with a remainder but no metadata is unreachable garbage -> reject.
    const badStore = good.store.slice();
    let idx = badStore.indexOf(0);
    badStore[idx] = 8; // remainder=1, metadata=0
    assert.throws(() => Quotient.restore(Object.assign({}, good, { store: badStore })),
        /remainder but no metadata/);
    // A metadata-set count that disagrees with the recorded size -> reject.
    assert.throws(() => Quotient.restore(Object.assign({}, good, { count: good.count + 1 })),
        /metadata-set slot count/);
});

test("restore: validates EVERY slot BEFORE writing ANY (a corrupt last slot leaves nothing half-written)", () => {
    const f = new Quotient(1000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 100; i++) f.add(i);
    const snap = f.dump();
    const store = snap.store.slice();
    store[store.length - 1] = 0xffffffff;  // corrupt the LAST slot (out of range)
    assert.throws(() => Quotient.restore(Object.assign({}, snap, { store })), /corrupt slot word/);
});

// --- overload: add() THROWS fail-closed (decisions/0016) ----------------------

test("door: add() at the load ceiling throws [lite-filter], is a byte-identical no-op, drops NO already-added key", () => {
    const f = new Quotient(64, { fpp: 0.01, keys: "int" });
    const added = [];
    let threw = false;
    let msg = "";
    try {
        for (let i = 0; i < 200000; i++) { f.add(i); added.push(i); }
    } catch (e) {
        threw = true;
        msg = e.message;
    }
    assert.equal(threw, true, "a small filter hammered with distinct keys must reach the ceiling");
    assert.match(msg, /\[lite-filter\]/);
    assert.ok(added.length >= 8, "expected meaningful successful adds before the throw, got " + added.length);
    for (const k of added) assert.equal(f.mightContain(k), true, "key " + k + " added before overload must still read true");
    // Byte-identical no-op: memcmp the store across the throwing attempt.
    const before = Array.from(f._store);
    const sizeBefore = f.size;
    assert.throws(() => f.add(9_000_001), /\[lite-filter\]/);
    assert.deepEqual(Array.from(f._store), before, "a thrown add must leave the store byte-identical");
    assert.equal(f.size, sizeBefore, "a thrown add must not change size");
    validateQuotient(f);
});

// --- fail-closed construction DOORS -------------------------------------------

test("door: fpp <= 0 or >= 1 throws [lite-filter] RangeError", () => {
    assert.throws(() => new Quotient(100, { fpp: 0 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Quotient(100, { fpp: -0.1 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Quotient(100, { fpp: 1 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Quotient(100, { fpp: 2 }), /\[lite-filter\].*fpp/);
});

test("door: fpp below the 16-bit slot-word floor (1/2^13) throws [lite-filter] RangeError", () => {
    // r + 3 > 16 <=> r > 13 <=> fpp < 1/2^13 (~0.000122).
    assert.throws(() => new Quotient(1000, { fpp: 1 / 8192 / 2 }), /\[lite-filter\].*16-bit/);
    assert.throws(() => new Quotient(1000, { fpp: 1e-6 }), /\[lite-filter\].*16-bit/);
});

test("door: fpp AT the 16-bit floor (1/2^13) does NOT throw -- the boundary is inclusive", () => {
    assert.doesNotThrow(() => new Quotient(1000, { fpp: 1 / 8192 }));
    const f = new Quotient(1000, { fpp: 1 / 8192 });
    assert.equal(f._r, 13);
});

test("door: capacity < 1 or non-integer throws [lite-filter] RangeError", () => {
    assert.throws(() => new Quotient(0), /\[lite-filter\].*capacity/);
    assert.throws(() => new Quotient(-5), /\[lite-filter\].*capacity/);
    assert.throws(() => new Quotient(1.5), /\[lite-filter\].*capacity/);
    assert.throws(() => new Quotient(), /\[lite-filter\].*capacity/);
    assert.throws(() => new Quotient(NaN), /\[lite-filter\].*capacity/);
});

test("door: a q + r budget past the 32-bit base hash throws [lite-filter] RangeError", () => {
    // A capacity so large that q + r > 32 cannot come from one 32-bit fmix.
    assert.throws(() => new Quotient(1e10, { fpp: 0.01 }), /\[lite-filter\]/);
});

test("door: int key out of 32-bit range throws [lite-filter] TypeError on add/mightContain/remove", () => {
    const f = new Quotient(10, { keys: "int" });
    assert.throws(() => f.add(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(1.5), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.mightContain(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.remove(2 ** 31), /\[lite-filter\].*keys:'int'/);
});

test("door: NaN/null/undefined int keys fail closed on add/mightContain/remove", () => {
    const f = new Quotient(10, { keys: "int" });
    for (const bad of [NaN, null, undefined, "5", {}, [], Infinity, -Infinity, 10n, true, false]) {
        assert.throws(() => f.add(bad), /\[lite-filter\].*keys:'int'/, "add(" + String(bad) + ")");
        assert.throws(() => f.mightContain(bad), /\[lite-filter\].*keys:'int'/, "mightContain(" + String(bad) + ")");
        assert.throws(() => f.remove(bad), /\[lite-filter\].*keys:'int'/, "remove(" + String(bad) + ")");
    }
});

test("door: unknown keys option fails closed with a did-you-mean hint", () => {
    assert.throws(() => new Quotient(10, { keys: "ints" }), /did you mean 'int'\?/);
});

// --- boundary matrix ----------------------------------------------------------

test("boundary: capacity N=1 constructs and behaves correctly", () => {
    const f = new Quotient(1, { keys: "int" });
    f.add(42);
    assert.equal(f.mightContain(42), true);
    assert.equal(f.remove(42), true);
    assert.equal(f.mightContain(42), false);
    validateQuotient(f);
});

test("boundary: keys:'int' accepts the exact INT_MIN/INT_MAX edges and -0/0", () => {
    const f = new Quotient(10, { keys: "int" });
    for (const k of [-2147483648, 2147483647, -0, 0]) {
        f.add(k);
        assert.equal(f.mightContain(k), true, "boundary key " + k + " must read true");
    }
    validateQuotient(f);
});

test("boundary: the default (arbitrary-key) backing accepts null/undefined/NaN/-0 via String()", () => {
    const f = new Quotient(100);
    const keys = [null, undefined, NaN, -0, 0, "", "0"];
    for (const k of keys) f.add(k);
    for (const k of keys) assert.equal(f.mightContain(k), true, "arbitrary-key backing must accept " + String(k));
    validateQuotient(f);
});
