/**
 * @zakkster/lite-filter -- node:test boundary suite (Bloom semantics).
 *
 * Every public method, every one-sided LAW, and every fail-closed door is named as
 * a test so a refactor cannot silently flip behavior (ROADMAP section 9). validate()
 * (the bits-set conservation invariant) runs after mutating tests as a backstop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Bloom, VERSION } from "../Filter.js";
import { validate } from "./validate.mjs";
import { differentialInt } from "./torture/oracle.mjs";

test("exports: VERSION and both named + default export are Bloom", async () => {
    assert.equal(VERSION, "0.3.0");
    const mod = await import("../Filter.js");
    assert.equal(mod.Bloom, Bloom);
    assert.equal(mod.default, Bloom);
});

test("getters: size/count/capacity reflect state", () => {
    const f = new Bloom(100);
    assert.equal(f.capacity, 100);
    assert.equal(f.size, 0);
    assert.equal(f.count, 0);
    f.add("a");
    assert.equal(f.size, 1);
    assert.equal(f.count, 1);
    validate(f);
});

// --- one-sided LAWS -----------------------------------------------------------

test("law: an added key ALWAYS reads true (no false negatives)", () => {
    const f = new Bloom(1000, { fpp: 0.01 });
    for (let i = 0; i < 1000; i++) f.add("key-" + i);
    for (let i = 0; i < 1000; i++) {
        assert.equal(f.mightContain("key-" + i), true, "false negative on key-" + i);
    }
    validate(f);
});

test("law: has() is the sole alias of mightContain (same result)", () => {
    const f = new Bloom(100);
    f.add("x");
    assert.equal(f.has("x"), f.mightContain("x"));
    assert.equal(f.has("x"), true);
    assert.equal(f.has("never-added"), f.mightContain("never-added"));
});

test("law: a never-added key is usually false; a true is a false positive", () => {
    const f = new Bloom(1000, { fpp: 0.01 });
    for (let i = 0; i < 1000; i++) f.add(i);
    // With fpp 0.01 the vast majority of disjoint probes read false.
    let trues = 0;
    for (let i = 100000; i < 110000; i++) if (f.mightContain(i)) trues++;
    assert.ok(trues < 10000, "every probe was a false positive -- structure is broken");
});

test("bounded FPR: measured FPR tracks the configured target (int backing)", () => {
    const r = differentialInt(Bloom, { n: 20000, fpp: 0.01, probes: 200000, seed: 12345 });
    assert.equal(r.falseNegatives, 0, "no false negatives allowed");
    assert.ok(r.fpr <= 0.0125, "measured FPR " + r.fpr + " over the 25%-tolerance limit");
});

// --- int backing --------------------------------------------------------------

test("keys:'int' round-trips integer keys with no false negatives", () => {
    const f = new Bloom(500, { keys: "int" });
    for (let i = -250; i < 250; i++) f.add(i);
    for (let i = -250; i < 250; i++) assert.equal(f.mightContain(i), true);
    validate(f);
});

// --- fpp() reporting ----------------------------------------------------------

test("fpp(): configured target while empty, fill-derived estimate once filled", () => {
    const f = new Bloom(1000, { fpp: 0.02 });
    assert.equal(f.fpp(), 0.02, "empty filter reports the configured target");
    for (let i = 0; i < 1000; i++) f.add(i);
    const est = f.fpp();
    assert.ok(est > 0 && est < 1, "estimate is a probability");
    assert.ok(Math.abs(est - 0.02) < 0.02, "a full filter's estimate is near its target");
});

// --- clear --------------------------------------------------------------------

test("clear(): empties the filter and reuses the same ArrayBuffer", () => {
    const f = new Bloom(100, { keys: "int" });
    const buf = f._words.buffer;
    for (let i = 0; i < 100; i++) f.add(i);
    assert.equal(f.mightContain(50), true);
    f.clear();
    assert.equal(f.size, 0);
    assert.equal(f._words.buffer, buf, "clear() must not reallocate");
    // After clear a previously-added key is (almost surely) absent again.
    assert.equal(f.mightContain(50), false);
    validate(f);
});

test("clear(): stats are cumulative instrumentation and SURVIVE a clear()", () => {
    const f = new Bloom(100, { stats: true });
    f.add("a"); f.add("b");
    f.mightContain("a");
    f.mightContain("definitely-not-present-zzz");
    const before = f.stats();
    assert.equal(before.adds, 2);
    assert.equal(before.queries, 2);
    f.clear();
    // Filter contents + presence counter reset; the stats holder does NOT.
    assert.equal(f.size, 0);
    const after = f.stats();
    assert.equal(after, before, "clear() must not reallocate the stats holder");
    assert.equal(after.adds, 2, "adds survive clear()");
    assert.equal(after.queries, 2, "queries survive clear()");
    assert.equal(after.hits + after.misses, 2, "hits/misses survive clear()");
    // resetStats() is the explicit way to zero them.
    f.resetStats();
    assert.equal(f.stats().adds, 0);
});

// --- opt-in stats -------------------------------------------------------------

test("stats: OFF by default -- accessors fail closed", () => {
    const f = new Bloom(10);
    assert.throws(() => f.stats(), /\[lite-filter\]/);
    assert.throws(() => f.resetStats(), /\[lite-filter\]/);
});

test("stats: ON counts adds/queries/hits/misses", () => {
    const f = new Bloom(100, { stats: true });
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
    assert.throws(() => new Bloom(10, { stats: 1 }), /did you mean true\?/);
});

// --- fail-closed DOORS (the falsifiable assertions) ---------------------------

test("door: fpp <= 0 throws [lite-filter] RangeError", () => {
    assert.throws(() => new Bloom(100, { fpp: 0 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Bloom(100, { fpp: -0.1 }), /\[lite-filter\].*fpp/);
});

test("door: fpp >= 1 throws [lite-filter] RangeError", () => {
    assert.throws(() => new Bloom(100, { fpp: 1 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Bloom(100, { fpp: 2 }), /\[lite-filter\].*fpp/);
});

test("door: capacity < 1 or non-integer throws [lite-filter] RangeError", () => {
    assert.throws(() => new Bloom(0), /\[lite-filter\].*capacity/);
    assert.throws(() => new Bloom(-5), /\[lite-filter\].*capacity/);
    assert.throws(() => new Bloom(1.5), /\[lite-filter\].*capacity/);
});

test("door: remove() on Bloom throws [lite-filter] (add-only)", () => {
    const f = new Bloom(10);
    f.add("a");
    assert.throws(() => f.remove("a"), /\[lite-filter\].*add-only/);
});

test("door: int key out of 32-bit range throws [lite-filter] TypeError", () => {
    const f = new Bloom(10, { keys: "int" });
    assert.throws(() => f.add(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(-(2 ** 31) - 1), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(1.5), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.mightContain(2 ** 31), /\[lite-filter\].*keys:'int'/);
});

test("door: unknown keys option fails closed with a did-you-mean hint", () => {
    assert.throws(() => new Bloom(10, { keys: "ints" }), /did you mean 'int'\?/);
});

test("door: capacity/fpp requesting an overflowing bit count throws [lite-filter] RangeError", () => {
    // (n, fpp) that derive m > 0x7fffffe0 must fail BEFORE the Uint32Array allocation
    // throws an opaque error (decisions/0002; ROADMAP section 6).
    assert.throws(() => new Bloom(1e15, { fpp: 1e-15 }), /\[lite-filter\].*too large/);
});

test("door: constructor with no capacity argument (undefined) throws [lite-filter]", () => {
    assert.throws(() => new Bloom(), /\[lite-filter\].*capacity/);
    assert.throws(() => new Bloom(undefined), /\[lite-filter\].*capacity/);
});

test("door: NaN fails closed for capacity, fpp, and seed", () => {
    assert.throws(() => new Bloom(NaN), /\[lite-filter\].*capacity/);
    assert.throws(() => new Bloom(100, { fpp: NaN }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Bloom(100, { seed: NaN }), /\[lite-filter\].*seed/);
});

test("boundary: capacity N=1 constructs and behaves correctly", () => {
    const f = new Bloom(1, { keys: "int" });
    f.add(42);
    assert.equal(f.mightContain(42), true);
    validate(f);
});

test("boundary: keys:'int' accepts the exact INT_MIN/INT_MAX edges and -0/0", () => {
    const f = new Bloom(10, { keys: "int" });
    for (const k of [-2147483648, 2147483647, -0, 0]) {
        f.add(k);
        assert.equal(f.mightContain(k), true, "boundary key " + k + " must read true");
    }
    validate(f);
});

test("door: NaN/null/undefined int keys fail closed on add() and mightContain()", () => {
    const f = new Bloom(10, { keys: "int" });
    for (const bad of [NaN, null, undefined, "5", {}, []]) {
        assert.throws(() => f.add(bad), /\[lite-filter\].*keys:'int'/, "add(" + String(bad) + ")");
        assert.throws(() => f.mightContain(bad), /\[lite-filter\].*keys:'int'/, "mightContain(" + String(bad) + ")");
    }
});
