/**
 * @zakkster/lite-filter -- node:test boundary suite (Cuckoo semantics).
 *
 * Mirrors Bloom.test.js / CountingBloom.test.js: every public method, the one-sided
 * LAW, the DELETE semantics (decisions/0014, 0015), the width-quantized fpp()
 * honesty (decisions/0014), and every fail-closed door is named as a test so a
 * refactor cannot silently flip behavior. validateCuckoo() (the nonzero-slot
 * conservation invariant) runs after mutating tests as a backstop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Cuckoo, VERSION } from "../Filter.js";
import { validateCuckoo } from "./validate.mjs";
import { differentialInt, differentialChurnInt } from "./torture/oracle.mjs";

test("exports: Cuckoo is a named export; VERSION is 1.2.0", async () => {
    const mod = await import("../Filter.js");
    assert.equal(mod.Cuckoo, Cuckoo);
    assert.equal(VERSION, "1.2.0");
});

test("getters: size/count/capacity reflect state", () => {
    const f = new Cuckoo(100, { keys: "int" });
    assert.equal(f.capacity, 100);
    assert.equal(f.size, 0);
    assert.equal(f.count, 0);
    f.add(1);
    assert.equal(f.size, 1);
    assert.equal(f.count, 1);
    validateCuckoo(f);
});

// --- one-sided LAWS -----------------------------------------------------------

test("law: an added key ALWAYS reads true (no false negatives)", () => {
    const f = new Cuckoo(1000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1000; i++) f.add(i);
    for (let i = 0; i < 1000; i++) {
        assert.equal(f.mightContain(i), true, "false negative on key " + i);
    }
    validateCuckoo(f);
});

test("law: has() is the sole alias of mightContain (same result)", () => {
    const f = new Cuckoo(100, { keys: "int" });
    f.add(7);
    assert.equal(f.has(7), f.mightContain(7));
    assert.equal(f.has(7), true);
    assert.equal(f.has(999999), f.mightContain(999999));
});

test("law: a never-added key is usually false; a true is a false positive", () => {
    const f = new Cuckoo(1000, { fpp: 0.01, keys: "int" });
    for (let i = 0; i < 1000; i++) f.add(i);
    let trues = 0;
    for (let i = 100000; i < 110000; i++) if (f.mightContain(i)) trues++;
    assert.ok(trues < 10000, "every probe was a false positive -- structure is broken");
});

test("bounded FPR: measured FPR is 0 false negatives and sits under the honest ceiling", () => {
    const r = differentialInt(Cuckoo, { n: 20000, fpp: 0.01, probes: 200000, seed: 12345 });
    assert.equal(r.falseNegatives, 0, "no false negatives allowed");
    assert.ok(r.fpr <= 0.01, "measured FPR " + r.fpr + " must sit at or under the configured target");
});

// --- int backing ----------------------------------------------------------------

test("keys:'int' round-trips integer keys with no false negatives", () => {
    const f = new Cuckoo(500, { keys: "int" });
    for (let i = -250; i < 250; i++) f.add(i);
    for (let i = -250; i < 250; i++) assert.equal(f.mightContain(i), true);
    validateCuckoo(f);
});

// --- fpp() reporting: configured while empty, width-quantized 2b/2^f once filled ---

test("fpp(): configured target while empty, width-quantized 2b/2^f once filled, BELOW the configured 0.01 target", () => {
    const f = new Cuckoo(1000, { fpp: 0.01, keys: "int" });
    assert.equal(f.fpp(), 0.01, "empty filter reports the configured target");
    f.add(1);
    const rate = f.fpp();
    // f = ceil(log2(8/0.01)) = ceil(log2(800)) = 10 -> a 16-bit store -> 8/1024 = 0.0078125.
    assert.equal(f._f, 10, "test setup: expected fingerprint width 10 at fpp=0.01");
    assert.equal(rate, (2 * f._b) / Math.pow(2, f._f));
    assert.ok(rate < 0.01, "the byte-aligned width must deliver a rate BELOW the configured 0.01 (decisions/0014 honesty)");
    assert.ok(Math.abs(rate - 0.0078125) < 1e-9, "expected the exact quantized rate 8/1024");
});

test("fpp(): does NOT vary with fill (unlike Bloom's fill-derived estimate)", () => {
    const f = new Cuckoo(1000, { fpp: 0.01, keys: "int" });
    f.add(1);
    const rateAt1 = f.fpp();
    for (let i = 2; i < 500; i++) f.add(i);
    const rateAt500 = f.fpp();
    assert.equal(rateAt1, rateAt500, "Cuckoo's fpp() is bounded by fingerprint width, not load factor");
});

// --- clear() --------------------------------------------------------------------

test("clear(): empties the filter and reuses the same ArrayBuffer", () => {
    const f = new Cuckoo(100, { keys: "int" });
    const buf = f._store.buffer;
    const half = f._store.length >> 1;
    for (let i = 0; i < half; i++) f.add(i);
    assert.equal(f.mightContain(0), true);
    f.clear();
    assert.equal(f.size, 0);
    assert.equal(f._store.buffer, buf, "clear() must not reallocate");
    assert.equal(f.mightContain(0), false);
    validateCuckoo(f);
});

test("clear(): stats are cumulative instrumentation and SURVIVE a clear()", () => {
    const f = new Cuckoo(100, { keys: "int", stats: true });
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
    assert.equal(after.queries, 2, "queries survive clear()");
    assert.equal(after.hits + after.misses, 2, "hits/misses survive clear()");
    f.resetStats();
    assert.equal(f.stats().adds, 0);
});

// --- opt-in stats -----------------------------------------------------------------

test("stats: OFF by default -- accessors fail closed", () => {
    const f = new Cuckoo(10, { keys: "int" });
    assert.throws(() => f.stats(), /\[lite-filter\]/);
    assert.throws(() => f.resetStats(), /\[lite-filter\]/);
});

test("stats: ON counts adds/queries/hits/misses", () => {
    const f = new Cuckoo(100, { keys: "int", stats: true });
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
    assert.throws(() => new Cuckoo(10, { stats: 1 }), /did you mean true\?/);
});

// --- remove() -> boolean semantics ------------------------------------------------

test("remove: a present key returns true, then reads absent, and size decrements", () => {
    const f = new Cuckoo(100, { keys: "int" });
    f.add(42);
    assert.equal(f.size, 1);
    assert.equal(f.remove(42), true);
    assert.equal(f.mightContain(42), false);
    assert.equal(f.size, 0);
    validateCuckoo(f);
});

test("remove: a never-added key returns false and mutates NOTHING", () => {
    const f = new Cuckoo(1000, { keys: "int" });
    const half = f._store.length >> 1;
    for (let i = 0; i < half; i++) f.add(i);
    const before = Array.from(f._store);
    const sizeBefore = f.size;
    assert.equal(f.remove(9999999), false, "removing an absent key returns false");
    assert.deepEqual(Array.from(f._store), before, "absent remove must not mutate the store");
    assert.equal(f.size, sizeBefore, "absent remove must not change size");
    validateCuckoo(f);
});

test("differential: mixed add/remove churn (bounded keyspace) -> 0 false negatives for present keys", () => {
    const r = differentialChurnInt(Cuckoo,
        { n: 5000, fpp: 0.01, ops: 50000, seed: 24680, keyspace: 3000 });
    assert.equal(r.falseNegatives, 0, "no false negatives allowed for currently-present keys");
    assert.equal(r.present, r.filterSize, "the filter size must track the oracle present-set size");
});

// --- overload: add() THROWS fail-closed (decisions/0014) --------------------------

test("door: add() on a full table throws [lite-filter] after exhausting kicks (fail closed, never a silent drop)", () => {
    const f = new Cuckoo(16, { fpp: 0.01, keys: "int" });
    let threw = false;
    let added = 0;
    try {
        for (let i = 0; i < 100000; i++) { f.add(i); added++; }
    } catch (e) {
        threw = true;
        assert.match(e.message, /\[lite-filter\]/);
        assert.match(e.message, /500 kicks/);
    }
    assert.equal(threw, true, "test setup: a small table hammered with distinct keys must eventually overflow");
    // Every key added BEFORE the throw must still read true -- the cardinal no-false-
    // negative law holds even on overflow (decisions/0014).
    for (let i = 0; i < added; i++) {
        assert.equal(f.mightContain(i), true, "key " + i + " added before overload must still read true");
    }
    validateCuckoo(f);
});

// --- fail-closed DOORS (the falsifiable assertions) -------------------------------

test("door: fpp <= 0 throws [lite-filter] RangeError", () => {
    assert.throws(() => new Cuckoo(100, { fpp: 0 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Cuckoo(100, { fpp: -0.1 }), /\[lite-filter\].*fpp/);
});

test("door: fpp >= 1 throws [lite-filter] RangeError", () => {
    assert.throws(() => new Cuckoo(100, { fpp: 1 }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Cuckoo(100, { fpp: 2 }), /\[lite-filter\].*fpp/);
});

test("door: fpp below the 16-bit floor (8/65536) throws [lite-filter] RangeError", () => {
    // f = ceil(log2(8/fpp)) > 16 <=> fpp < 8/65536 (~0.000122).
    assert.throws(() => new Cuckoo(1000, { fpp: 8 / 65536 / 2 }), /\[lite-filter\].*16 bits/);
    assert.throws(() => new Cuckoo(1000, { fpp: 1e-6 }), /\[lite-filter\].*16 bits/);
});

test("door: fpp AT the 16-bit floor (8/65536) does NOT throw -- the boundary is inclusive of what fits", () => {
    // At fpp exactly 8/65536, f = ceil(log2(8/(8/65536))) = ceil(log2(65536)) = 16 -- fits.
    assert.doesNotThrow(() => new Cuckoo(1000, { fpp: 8 / 65536 }));
    const f = new Cuckoo(1000, { fpp: 8 / 65536 });
    assert.equal(f._f, 16);
});

test("door: capacity < 1 or non-integer throws [lite-filter] RangeError", () => {
    assert.throws(() => new Cuckoo(0), /\[lite-filter\].*capacity/);
    assert.throws(() => new Cuckoo(-5), /\[lite-filter\].*capacity/);
    assert.throws(() => new Cuckoo(1.5), /\[lite-filter\].*capacity/);
});

test("door: constructor with no capacity argument (undefined) throws [lite-filter]", () => {
    assert.throws(() => new Cuckoo(), /\[lite-filter\].*capacity/);
    assert.throws(() => new Cuckoo(undefined), /\[lite-filter\].*capacity/);
});

test("door: NaN fails closed for capacity, fpp, and seed", () => {
    assert.throws(() => new Cuckoo(NaN), /\[lite-filter\].*capacity/);
    assert.throws(() => new Cuckoo(100, { fpp: NaN }), /\[lite-filter\].*fpp/);
    assert.throws(() => new Cuckoo(100, { seed: NaN }), /\[lite-filter\].*seed/);
});

test("door: int key out of 32-bit range throws [lite-filter] TypeError on add/mightContain/remove", () => {
    const f = new Cuckoo(10, { keys: "int" });
    assert.throws(() => f.add(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(-(2 ** 31) - 1), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.add(1.5), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.mightContain(2 ** 31), /\[lite-filter\].*keys:'int'/);
    assert.throws(() => f.remove(2 ** 31), /\[lite-filter\].*keys:'int'/);
});

test("door: NaN/null/undefined int keys fail closed on add/mightContain/remove", () => {
    const f = new Cuckoo(10, { keys: "int" });
    for (const bad of [NaN, null, undefined, "5", {}, [], Infinity, -Infinity, 10n, true, false]) {
        assert.throws(() => f.add(bad), /\[lite-filter\].*keys:'int'/, "add(" + String(bad) + ")");
        assert.throws(() => f.mightContain(bad), /\[lite-filter\].*keys:'int'/, "mightContain(" + String(bad) + ")");
        assert.throws(() => f.remove(bad), /\[lite-filter\].*keys:'int'/, "remove(" + String(bad) + ")");
    }
});

test("door: unknown keys option fails closed with a did-you-mean hint", () => {
    assert.throws(() => new Cuckoo(10, { keys: "ints" }), /did you mean 'int'\?/);
});

test("door: capacity/fpp requesting an overflowing bucket count throws [lite-filter] RangeError, bounded in a child process so a hang cannot wedge the whole suite", () => {
    // Mirrors the "requesting an overflowing count throws" door proven for Bloom /
    // CountingBloom / BlockedBloom (all use capacity=1e15 in their own suites). Run
    // in a CHILD process with a hard timeout: cuckooSizeFor's bucket-count derivation
    // (Filter.js) computes `nb` as a power of two via `let nb = 1; while (nb < need)
    // nb <<= 1;` -- `<<=` is a 32-BIT signed shift. Once `nb` needs to exceed 2^31
    // (capacity/(4*0.95) > 2^31, i.e. capacity ABOVE ~8.16e9 at any fpp that does not
    // itself hit the 16-bit fingerprint floor first), `nb <<= 1` overflows to
    // -2147483648 and then to 0 on the NEXT shift -- after which `0 < need` stays
    // true and `0 <<= 1` stays 0 FOREVER: an infinite loop, not the intended
    // fail-closed RangeError. A hard-coded timeout is required here because the
    // buggy code path never returns.
    const target = new URL("../Filter.js", import.meta.url).href;
    const script =
        "import(" + JSON.stringify(target) + ").then(({ Cuckoo }) => {" +
        "  try { new Cuckoo(1e15, { fpp: 0.01 }); console.log('NO_THROW'); }" +
        "  catch (e) { console.log(/\\[lite-filter\\]/.test(e.message) ? 'THREW_OK' : ('THREW_WRONG:' + e.message)); }" +
        "});";
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        timeout: 5000,
        killSignal: "SIGKILL",
        encoding: "utf8",
    });
    assert.equal(res.signal, null,
        "construction must return within 5s and throw [lite-filter], not hang the process " +
        "(cuckooSizeFor's power-of-two `nb <<= 1` loop overflows 32-bit and spins forever " +
        "for capacities needing > 2^31 buckets -- Filter.js cuckooSizeFor, the `let nb = 1; " +
        "while (nb < need) nb <<= 1;` bucket-count derivation)");
    assert.equal((res.stdout || "").trim(), "THREW_OK",
        "expected a [lite-filter] RangeError for an oversized Cuckoo request, got: " +
        JSON.stringify(res.stdout) + " stderr: " + JSON.stringify(res.stderr));
});

// --- boundary matrix --------------------------------------------------------------

test("boundary: capacity N=1 constructs and behaves correctly", () => {
    const f = new Cuckoo(1, { keys: "int" });
    f.add(42);
    assert.equal(f.mightContain(42), true);
    assert.equal(f.remove(42), true);
    assert.equal(f.mightContain(42), false);
    validateCuckoo(f);
});

test("boundary: keys:'int' accepts the exact INT_MIN/INT_MAX edges and -0/0", () => {
    const f = new Cuckoo(10, { keys: "int" });
    for (const k of [-2147483648, 2147483647, -0, 0]) {
        f.add(k);
        assert.equal(f.mightContain(k), true, "boundary key " + k + " must read true");
    }
    validateCuckoo(f);
});
