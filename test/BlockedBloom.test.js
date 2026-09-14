/**
 * @zakkster/lite-filter -- node:test boundary suite (BlockedBloom semantics).
 *
 * Mirrors Bloom.test.js: every public method, the one-sided LAW, the LOCALITY property
 * (a key touches exactly ONE 512-bit block, decisions/0012), and every fail-closed door
 * is named as a test. validateBlocked() (the conservation invariant) and
 * validateBlockedLocality() run as backstops.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { BlockedBloom } from "../Filter.js";
import { validateBlocked, validateBlockedLocality } from "./validate.mjs";
import { differentialInt } from "./torture/oracle.mjs";

test("exports: BlockedBloom is a named export", async () => {
    const mod = await import("../Filter.js");
    assert.equal(mod.BlockedBloom, BlockedBloom);
});

test("getters: size/count/capacity reflect state", () => {
    const f = new BlockedBloom(100);
    assert.equal(f.capacity, 100);
    assert.equal(f.size, 0);
    assert.equal(f.count, 0);
    f.add("a");
    assert.equal(f.size, 1);
    assert.equal(f.count, 1);
    validateBlocked(f);
});

// --- one-sided LAW + LOCALITY -------------------------------------------------

test("law: an added key ALWAYS reads true (no false negatives)", () => {
    const f = new BlockedBloom(1000, { fpp: 0.01 });
    for (let i = 0; i < 1000; i++) f.add("key-" + i);
    for (let i = 0; i < 1000; i++) {
        assert.equal(f.mightContain("key-" + i), true, "false negative on key-" + i);
    }
    validateBlocked(f);
});

test("locality: a single key sets bits in exactly ONE 512-bit block (decisions/0012)", () => {
    // Try many keys; each in a FRESH filter must confine all its set bits to one block.
    for (let key = 0; key < 500; key++) {
        const f = new BlockedBloom(100000, { keys: "int" });
        f.add(key);
        const block = validateBlockedLocality(f); // throws if bits span two blocks
        assert.ok(block >= 0, "an added key must set at least one bit");
        assert.ok(block < f._nb, "the block index must be in range");
        validateBlocked(f);
    }
});

test("law: has() is the sole alias of mightContain (same result)", () => {
    const f = new BlockedBloom(100);
    f.add("x");
    assert.equal(f.has("x"), f.mightContain("x"));
    assert.equal(f.has("x"), true);
    assert.equal(f.has("never-added"), f.mightContain("never-added"));
});

test("bounded FPR: measured FPR sits under the honest BlockedBloom ceiling (int backing)", () => {
    const r = differentialInt(BlockedBloom, { n: 20000, fpp: 0.01, probes: 200000, seed: 12345 });
    assert.equal(r.falseNegatives, 0, "no false negatives allowed");
    assert.ok(r.fpr <= 0.0175, "measured FPR " + r.fpr + " over the BlockedBloom ceiling");
});

// --- int backing --------------------------------------------------------------

test("keys:'int' round-trips integer keys with no false negatives", () => {
    const f = new BlockedBloom(500, { keys: "int" });
    for (let i = -250; i < 250; i++) f.add(i);
    for (let i = -250; i < 250; i++) assert.equal(f.mightContain(i), true);
    validateBlocked(f);
});

// --- fpp() reporting (a FLOOR, decisions/0013) --------------------------------

test("fpp(): configured target while empty, fill-derived floor once filled", () => {
    const f = new BlockedBloom(1000, { fpp: 0.02 });
    assert.equal(f.fpp(), 0.02, "empty filter reports the configured target");
    for (let i = 0; i < 1000; i++) f.add(i);
    const est = f.fpp();
    assert.ok(est > 0 && est < 1, "the floor is a probability");
});

// --- clear --------------------------------------------------------------------

test("clear(): empties the filter and reuses the same ArrayBuffer", () => {
    const f = new BlockedBloom(100, { keys: "int" });
    const buf = f._words.buffer;
    for (let i = 0; i < 100; i++) f.add(i);
    assert.equal(f.mightContain(50), true);
    f.clear();
    assert.equal(f.size, 0);
    assert.equal(f._words.buffer, buf, "clear() must not reallocate");
    assert.equal(f.mightContain(50), false);
    validateBlocked(f);
});

// --- opt-in stats -------------------------------------------------------------

test("stats: OFF by default -- accessors fail closed", () => {
    const f = new BlockedBloom(10);
    assert.throws(() => f.stats(), /\[lite-filter\]/);
    assert.throws(() => f.resetStats(), /\[lite-filter\]/);
});

test("stats: ON counts adds/queries/hits/misses", () => {
    const f = new BlockedBloom(100, { stats: true });
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
    assert.throws(() => new BlockedBloom(10, { stats: 1 }), /did you mean true\?/);
});

// --- fail-closed DOORS --------------------------------------------------------

test("door: fpp <= 0 / fpp >= 1 throws [lite-filter] RangeError", () => {
    assert.throws(() => new BlockedBloom(100, { fpp: 0 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new BlockedBloom(100, { fpp: -0.1 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new BlockedBloom(100, { fpp: 1 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new BlockedBloom(100, { fpp: 2 }), /\[lite-filter\].*fpp/);
});

test("door: capacity < 1 or non-integer throws [lite-filter] RangeError", () => {
    assert.throws(() => new BlockedBloom(0), /\[lite-filter\].*capacity/);
    assert.throws(() => new BlockedBloom(-5), /\[lite-filter\].*capacity/);
    assert.throws(() => new BlockedBloom(1.5), /\[lite-filter\].*capacity/);
    assert.throws(() => new BlockedBloom(), /\[lite-filter\].*capacity/);
});

test("door: remove() on BlockedBloom throws [lite-filter] (add-only)", () => {
    const f = new BlockedBloom(10);
    f.add("a");
    assert.throws(() => f.remove("a"), /\[lite-filter\].*add-only/);
});

test("door: int key out of 32-bit range throws [lite-filter] TypeError", () => {
    const f = new BlockedBloom(10, { keys: "int" });
    assert.throws(() => f.add(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(-(2 ** 31) - 1), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(1.5), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.mightContain(2 ** 31), /\[lite-filter\].*keys:'int'/);
});

test("door: NaN/null/undefined int keys fail closed on add() and mightContain()", () => {
    const f = new BlockedBloom(10, { keys: "int" });
    for (const bad of [NaN, null, undefined, "5", {}, []]) {
        assert.throws(() => f.add(bad), /\[lite-filter\].*keys:'int'/, "add(" + String(bad) + ")");
        assert.throws(() => f.mightContain(bad), /\[lite-filter\].*keys:'int'/);
    }
});

test("door: unknown keys option fails closed with a did-you-mean hint", () => {
    assert.throws(() => new BlockedBloom(10, { keys: "ints" }), /did you mean 'int'\?/);
});

test("door: capacity/fpp requesting an overflowing bit count throws [lite-filter] RangeError", () => {
    assert.throws(() => new BlockedBloom(1e15, { fpp: 1e-15 }), /\[lite-filter\].*too large/);
});

test("door: NaN fails closed for capacity, fpp, and seed", () => {
    assert.throws(() => new BlockedBloom(NaN), /\[lite-filter\].*capacity/);
    assert.throws(() => new BlockedBloom(100, { fpp: NaN }), /\[lite-filter\].*fpp/);
    assert.throws(() => new BlockedBloom(100, { seed: NaN }), /\[lite-filter\].*seed/);
});

// --- boundary sizing: _nb >= 1 ------------------------------------------------

test("boundary: capacity N=1 constructs, _nb >= 1, and behaves correctly", () => {
    const f = new BlockedBloom(1, { keys: "int" });
    assert.ok(f._nb >= 1, "a valid filter has >= 1 block");
    assert.equal(f._words.length, f._nb * 16, "the store is nb*16 words");
    f.add(42);
    assert.equal(f.mightContain(42), true);
    validateBlocked(f);
    validateBlockedLocality(f);
});

test("boundary: the store is always nb*16 words and k is clamped to <= 512", () => {
    for (const n of [1, 10, 1000, 100000]) {
        const f = new BlockedBloom(n, { keys: "int" });
        assert.equal(f._words.length, f._nb * 16);
        assert.equal(f._nb, Math.ceil(f._m / 512));
        assert.ok(f._k >= 1 && f._k <= 512, "k must be in 1..512, got " + f._k);
    }
});

test("boundary: keys:'int' accepts the exact INT_MIN/INT_MAX edges and -0/0", () => {
    const f = new BlockedBloom(10, { keys: "int" });
    for (const k of [-2147483648, 2147483647, -0, 0]) {
        f.add(k);
        assert.equal(f.mightContain(k), true, "boundary key " + k + " must read true");
    }
    validateBlocked(f);
});
