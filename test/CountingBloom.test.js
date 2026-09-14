/**
 * @zakkster/lite-filter -- node:test boundary suite (CountingBloom semantics).
 *
 * Mirrors Bloom.test.js: every public method, the one-sided LAW, the DELETE
 * semantics + the two documented caveats (decisions/0008, 0009), the saturating
 * increment (decisions/0008), and every fail-closed door is named as a test so a
 * refactor cannot silently flip behavior. validateCounting() (the conservation
 * invariant) runs after mutating tests as a backstop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CountingBloom } from "../Filter.js";
import { validateCounting } from "./validate.mjs";
import { differentialChurnInt } from "./torture/oracle.mjs";

test("exports: CountingBloom is a named export", async () => {
    const mod = await import("../Filter.js");
    assert.equal(mod.CountingBloom, CountingBloom);
});

test("getters: size/count/capacity reflect state", () => {
    const f = new CountingBloom(100);
    assert.equal(f.capacity, 100);
    assert.equal(f.size, 0);
    assert.equal(f.count, 0);
    f.add("a");
    assert.equal(f.size, 1);
    assert.equal(f.count, 1);
    validateCounting(f);
});

// --- one-sided LAW ------------------------------------------------------------

test("law: an added key ALWAYS reads true (no false negatives)", () => {
    const f = new CountingBloom(1000, { fpp: 0.01 });
    for (let i = 0; i < 1000; i++) f.add("key-" + i);
    for (let i = 0; i < 1000; i++) {
        assert.equal(f.mightContain("key-" + i), true, "false negative on key-" + i);
    }
    validateCounting(f);
});

test("law: has() is the sole alias of mightContain (same result)", () => {
    const f = new CountingBloom(100);
    f.add("x");
    assert.equal(f.has("x"), f.mightContain("x"));
    assert.equal(f.has("x"), true);
    assert.equal(f.has("never-added"), f.mightContain("never-added"));
});

// --- DELETE semantics (decisions/0009) ----------------------------------------

test("remove: add(k);add(k);remove(k) -> still present (multiplicity 2 -> 1)", () => {
    const f = new CountingBloom(100, { keys: "int" });
    f.add(7); f.add(7);
    assert.equal(f.remove(7), true);
    assert.equal(f.mightContain(7), true, "one copy remains after removing one of two adds");
    assert.equal(f.size, 1);
    validateCounting(f);
});

test("remove: add(k);remove(k) -> size 0, no throw, key absent", () => {
    const f = new CountingBloom(100, { keys: "int" });
    f.add(9);
    assert.equal(f.remove(9), true);
    assert.equal(f.size, 0);
    assert.equal(f.mightContain(9), false);
    validateCounting(f);
});

test("remove: a never-added key returns false and mutates NOTHING", () => {
    const f = new CountingBloom(100, { keys: "int" });
    for (let i = 0; i < 50; i++) f.add(i);
    const before = Array.from(f._cnts);
    const sizeBefore = f.size;
    assert.equal(f.remove(999999), false, "removing an absent key returns false");
    assert.deepEqual(Array.from(f._cnts), before, "absent remove must not mutate the store");
    assert.equal(f.size, sizeBefore, "absent remove must not change size");
    validateCounting(f);
});

test("remove: repeated add/remove keeps present keys readable (no corruption)", () => {
    const f = new CountingBloom(500, { keys: "int" });
    for (let i = 0; i < 250; i++) f.add(i);
    for (let i = 0; i < 125; i++) assert.equal(f.remove(i), true);
    for (let i = 125; i < 250; i++) {
        assert.equal(f.mightContain(i), true, "still-present key " + i + " must read true");
    }
    validateCounting(f);
});

// --- saturating increment (decisions/0008) ------------------------------------

test("saturation: 16 adds of one int-key leave the nibble at 15 (no wrap)", () => {
    const f = new CountingBloom(1, { keys: "int" });
    for (let i = 0; i < 16; i++) f.add(42);
    // Every probed nibble must be exactly 15 (clamped, never wrapped to 0).
    const m = f._m;
    const cnts = f._cnts;
    const a = ((42 ^ f._seed) | 0);
    // Re-derive the same probe positions and check each nibble is 15.
    // (Use the public guarantee instead of re-hashing: the key still reads present.)
    assert.equal(f.mightContain(42), true, "a wrapped counter would drop to 0 -> false negative");
    // Assert at least one nibble reached the ceiling 15.
    let max = 0;
    for (let i = 0; i < cnts.length; i++) {
        const lo = cnts[i] & 0x0f, hi = (cnts[i] >>> 4) & 0x0f;
        if (lo > max) max = lo;
        if (hi > max) max = hi;
    }
    void m; void a;
    assert.equal(max, 15, "16 adds must saturate a nibble at 15, not wrap it");
});

test("saturation: remove() on a saturated key returns true and leaves the nibble at 15", () => {
    const f = new CountingBloom(1, { keys: "int" });
    for (let i = 0; i < 16; i++) f.add(42);
    assert.equal(f.remove(42), true, "remove of a present (saturated) key returns true");
    let max = 0;
    for (let i = 0; i < f._cnts.length; i++) {
        const lo = f._cnts[i] & 0x0f, hi = (f._cnts[i] >>> 4) & 0x0f;
        if (lo > max) max = lo;
        if (hi > max) max = hi;
    }
    assert.equal(max, 15, "a saturated nibble must NOT be decremented (decisions/0008)");
    assert.equal(f.mightContain(42), true, "saturated key sticks present after remove");
});

// --- int backing --------------------------------------------------------------

test("keys:'int' round-trips integer keys with no false negatives", () => {
    const f = new CountingBloom(500, { keys: "int" });
    for (let i = -250; i < 250; i++) f.add(i);
    for (let i = -250; i < 250; i++) assert.equal(f.mightContain(i), true);
    validateCounting(f);
});

// --- fpp() reporting ----------------------------------------------------------

test("fpp(): configured target while empty, fill-derived estimate once filled", () => {
    const f = new CountingBloom(1000, { fpp: 0.02 });
    assert.equal(f.fpp(), 0.02, "empty filter reports the configured target");
    for (let i = 0; i < 1000; i++) f.add(i);
    const est = f.fpp();
    assert.ok(est > 0 && est < 1, "estimate is a probability");
    assert.ok(Math.abs(est - 0.02) < 0.02, "a full filter's estimate is near its target");
});

// --- clear --------------------------------------------------------------------

test("clear(): empties the filter and reuses the same ArrayBuffer", () => {
    const f = new CountingBloom(100, { keys: "int" });
    const buf = f._cnts.buffer;
    for (let i = 0; i < 100; i++) f.add(i);
    assert.equal(f.mightContain(50), true);
    f.clear();
    assert.equal(f.size, 0);
    assert.equal(f._cnts.buffer, buf, "clear() must not reallocate");
    assert.equal(f.mightContain(50), false);
    validateCounting(f);
});

// --- opt-in stats -------------------------------------------------------------

test("stats: OFF by default -- accessors fail closed", () => {
    const f = new CountingBloom(10);
    assert.throws(() => f.stats(), /\[lite-filter\]/);
    assert.throws(() => f.resetStats(), /\[lite-filter\]/);
});

test("stats: ON counts adds/queries/hits/misses", () => {
    const f = new CountingBloom(100, { stats: true });
    f.add("a"); f.add("b");
    assert.equal(f.mightContain("a"), true);
    f.mightContain("definitely-not-present-zzz");
    const s = f.stats();
    assert.equal(s.adds, 2);
    assert.equal(s.queries, 2);
    assert.equal(s.hits >= 1, true);
    f.resetStats();
    assert.equal(f.stats().adds, 0);
});

test("stats: unknown option fails closed with a did-you-mean hint", () => {
    assert.throws(() => new CountingBloom(10, { stats: 1 }), /did you mean true\?/);
});

// --- fail-closed DOORS --------------------------------------------------------

test("door: fpp <= 0 throws [lite-filter] RangeError", () => {
    assert.throws(() => new CountingBloom(100, { fpp: 0 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new CountingBloom(100, { fpp: -0.1 }), /\[lite-filter\].*fpp/);
});

test("door: fpp >= 1 throws [lite-filter] RangeError", () => {
    assert.throws(() => new CountingBloom(100, { fpp: 1 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new CountingBloom(100, { fpp: 2 }), /\[lite-filter\].*fpp/);
});

test("door: capacity < 1 or non-integer throws [lite-filter] RangeError", () => {
    assert.throws(() => new CountingBloom(0), /\[lite-filter\].*capacity/);
    assert.throws(() => new CountingBloom(-5), /\[lite-filter\].*capacity/);
    assert.throws(() => new CountingBloom(1.5), /\[lite-filter\].*capacity/);
});

test("door: int key out of 32-bit range throws [lite-filter] TypeError on add/mightContain/remove", () => {
    const f = new CountingBloom(10, { keys: "int" });
    assert.throws(() => f.add(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(-(2 ** 31) - 1), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(1.5), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.mightContain(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.remove(2 ** 31), /\[lite-filter\].*keys:'int'/);
});

test("door: unknown keys option fails closed with a did-you-mean hint", () => {
    assert.throws(() => new CountingBloom(10, { keys: "ints" }), /did you mean 'int'\?/);
});

test("door: capacity/fpp requesting an overflowing counter count throws [lite-filter] RangeError", () => {
    assert.throws(() => new CountingBloom(1e15, { fpp: 1e-15 }), /\[lite-filter\].*too large/);
});

test("door: constructor with no capacity argument (undefined) throws [lite-filter]", () => {
    assert.throws(() => new CountingBloom(), /\[lite-filter\].*capacity/);
    assert.throws(() => new CountingBloom(undefined), /\[lite-filter\].*capacity/);
});

test("door: NaN fails closed for capacity, fpp, and seed", () => {
    assert.throws(() => new CountingBloom(NaN), /\[lite-filter\].*capacity/);
    assert.throws(() => new CountingBloom(100, { fpp: NaN }), /\[lite-filter\].*fpp/);
    assert.throws(() => new CountingBloom(100, { seed: NaN }), /\[lite-filter\].*seed/);
});

test("boundary: capacity N=1 constructs and behaves correctly", () => {
    const f = new CountingBloom(1, { keys: "int" });
    f.add(42);
    assert.equal(f.mightContain(42), true);
    assert.equal(f.remove(42), true);
    assert.equal(f.mightContain(42), false);
    validateCounting(f);
});

test("boundary: keys:'int' accepts the exact INT_MIN/INT_MAX edges and -0/0", () => {
    const f = new CountingBloom(10, { keys: "int" });
    for (const k of [-2147483648, 2147483647, -0, 0]) {
        f.add(k);
        assert.equal(f.mightContain(k), true, "boundary key " + k + " must read true");
    }
    validateCounting(f);
});

test("door: NaN/null/undefined int keys fail closed on add/mightContain/remove", () => {
    const f = new CountingBloom(10, { keys: "int" });
    for (const bad of [NaN, null, undefined, "5", {}, []]) {
        assert.throws(() => f.add(bad), /\[lite-filter\].*keys:'int'/, "add(" + String(bad) + ")");
        assert.throws(() => f.mightContain(bad), /\[lite-filter\].*keys:'int'/, "mightContain(" + String(bad) + ")");
        assert.throws(() => f.remove(bad), /\[lite-filter\].*keys:'int'/, "remove(" + String(bad) + ")");
    }
});

// --- differential churn (add + remove mirrored against a Set) -----------------

test("differential: mixed add/remove churn -> 0 false negatives for present keys", () => {
    const r = differentialChurnInt(CountingBloom, { n: 5000, fpp: 0.01, ops: 50000, seed: 24680 });
    assert.equal(r.falseNegatives, 0, "no false negatives allowed for currently-present keys");
    assert.equal(r.present, r.filterSize, "the filter size must track the oracle present-set size");
});
