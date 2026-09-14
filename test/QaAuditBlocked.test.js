/**
 * @zakkster/lite-filter -- QA independent-verification suite (v0.3.0 BlockedBloom).
 *
 * Written by QA, not the coder, to INDEPENDENTLY falsify the planner's ASSERTIONS for
 * the BlockedBloom member (decisions/0012, 0013). Every test here is designed so that
 * it FAILS if the described behavior regresses -- it does not just replay the shipped
 * suite. Boundary matrix: 0, 1, N-1, N, N+1 (applied to the BLOCK boundary itself, not
 * just item counts), empty, null, undefined, NaN, -0, duplicate "dispose" (clear()
 * called twice), dispose-during-iteration (mutate-after-dump isolation), re-entrant
 * write (toString() hook re-enters add()), and one adversarial case the planner did
 * not enumerate (cross-restore of a CountingBloom snapshot into BlockedBloom.restore
 * and vice versa -- the planner named only Bloom<->BlockedBloom crossings).
 *
 * node:test only. No dependency outside this package + its devDependency peers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Bloom, CountingBloom, BlockedBloom } from "../Filter.js";
import { validateBlocked, validateBlockedLocality } from "./validate.mjs";
import { differentialInt } from "./torture/oracle.mjs";

/* ============================================================================
 * Assertion 1 -- single-block containment. Independent of BlockedBloom.test.js's
 * own locality test: sweeps EVERY capacity 1..3000 (default fpp), i.e. every
 * reachable block-count in that range, INCLUDING exact 512-bit boundaries, and
 * exercises BOTH the int backing AND the arbitrary (string-hashed) backing --
 * the planner's assertion never named the arbitrary-key path, which walks the
 * SAME block math via a DIFFERENT hash entry point (_hashKey), so a bug scoped
 * to only one entry point would slip past an int-only sweep.
 * ========================================================================== */

test("QA-BB1: every capacity 1..3000 (sweeping every reachable block boundary) confines a single key to ONE block, int backing", () => {
    let sawExactBoundary = false;
    for (let cap = 1; cap <= 3000; cap++) {
        const f = new BlockedBloom(cap, { keys: "int" });
        if (f._m % 512 === 0) sawExactBoundary = true;
        f.add(cap * 7 + 3);
        const block = validateBlockedLocality(f);
        assert.ok(block >= 0 && block < f._nb, "cap=" + cap + " block out of range");
        validateBlocked(f);
    }
    assert.ok(sawExactBoundary, "test setup: expected to sweep at least one exact 512-bit m boundary in 1..3000");
});

test("QA-BB1: single-block containment also holds on the ARBITRARY (string-hashed) backing, a different hash entry point", () => {
    for (let i = 0; i < 300; i++) {
        const f = new BlockedBloom(50000); // default (non-int) backing
        f.add("key-" + i + "-" + (i * 31));
        const block = validateBlockedLocality(f);
        assert.ok(block >= 0 && block < f._nb);
        validateBlocked(f);
    }
});

test("QA-BB1: containment holds at the smallest possible filter (capacity=1, nb=1) and a large multi-block filter", () => {
    const small = new BlockedBloom(1, { keys: "int" });
    small.add(0);
    assert.equal(validateBlockedLocality(small), 0, "with nb=1 the only valid block index is 0");
    validateBlocked(small);

    const big = new BlockedBloom(2_000_000, { keys: "int" });
    assert.ok(big._nb > 1, "test setup: expected a multi-block filter");
    for (let i = 0; i < 200; i++) {
        big.clear();
        big.add(i * 999331 + 17);
        const block = validateBlockedLocality(big);
        assert.ok(block >= 0 && block < big._nb);
    }
});

/* ============================================================================
 * Assertion 2 -- no false negatives at >= 1e5 adds (int backing). Independent
 * instantiation and seed from the shipped suite / torture. (The full 1e6-scale
 * case is independently re-run live below via `npm run torture`, GATE line
 * confirms bb fn=0 -- see the QA verdict; this in-suite test keeps `npm test`
 * fast while still clearing the 1e5 floor with a FRESH seed.)
 * ========================================================================== */

test("QA-BB2: 2e5 adds (int backing, independent seed) then requery -- exactly 0 false negatives", () => {
    const r = differentialInt(BlockedBloom, { n: 200000, fpp: 0.01, probes: 1, seed: 0xdeadbeef });
    assert.equal(r.falseNegatives, 0);
    assert.equal(r.added, 200000);
});

/* ============================================================================
 * Assertion 3 -- the FPR penalty is REAL (not vacuous) and BOUNDED. Build a
 * Bloom AND a BlockedBloom with the IDENTICAL (capacity, fpp, seed) and measure
 * both independently against a Set oracle on the same disjoint probe set shape.
 * A regression that silently upsizes BlockedBloom's m to hide the penalty (the
 * thing decisions/0013 explicitly forbids) would make blockedFpr <= bloomFpr,
 * which this test would catch.
 * ========================================================================== */

test("QA-BB3: measured BlockedBloom FPR is STRICTLY GREATER than plain Bloom's OWN measured FPR at the same (n, fpp), and sits within the honest ceiling", () => {
    const params = { n: 100000, fpp: 0.01, probes: 500000, seed: 777 };
    const bloom = differentialInt(Bloom, params);
    const blocked = differentialInt(BlockedBloom, params);

    assert.equal(bloom.falseNegatives, 0);
    assert.equal(blocked.falseNegatives, 0);

    // Sanity: plain Bloom must itself be close to theory, or the comparison is moot.
    assert.ok(bloom.fpr > 0.007 && bloom.fpr < 0.013, "plain Bloom fpr " + bloom.fpr + " is not in a sane band around 0.01");

    // The penalty must be PRESENT: BlockedBloom's OWN measured rate must exceed
    // plain Bloom's OWN measured rate, same inputs, same seed, same probe shape.
    assert.ok(blocked.fpr > bloom.fpr,
        "BlockedBloom fpr " + blocked.fpr + " must exceed plain Bloom's OWN measured fpr " + bloom.fpr +
        " -- the locality penalty must be genuinely present, not compensated away");

    // The penalty must be BOUNDED by the honest ceiling (decisions/0013).
    assert.ok(blocked.fpr <= 0.0175, "BlockedBloom fpr " + blocked.fpr + " exceeds the honest ceiling 0.0175");

    // And must exceed the plain-Bloom CLOSED-FORM theory (~0.00949 at n=1e5/fpp=0.01),
    // independently of the empirical Bloom run above (a second, formula-based floor).
    assert.ok(blocked.fpr > 0.00949, "BlockedBloom fpr " + blocked.fpr + " does not exceed plain-Bloom theory 0.00949");
});

test("QA-BB3: a SECOND independent seed reproduces the same penalty direction (not a seed-specific fluke)", () => {
    const params = { n: 50000, fpp: 0.02, probes: 300000, seed: 424242 };
    const bloom = differentialInt(Bloom, params);
    const blocked = differentialInt(BlockedBloom, params);
    assert.equal(bloom.falseNegatives, 0);
    assert.equal(blocked.falseNegatives, 0);
    assert.ok(blocked.fpr > bloom.fpr,
        "at fpp=0.02/seed=424242: BlockedBloom fpr " + blocked.fpr + " must still exceed Bloom fpr " + bloom.fpr);
});

/* ============================================================================
 * Assertion 5 -- restore() fail-closed doors, including the cross-restore
 * combinations the shipped suite covers PLUS the ones it does not: CountingBloom
 * snapshot into BlockedBloom.restore, and BlockedBloom snapshot into
 * CountingBloom.restore (this is the "adversarial case the planner did not think
 * of": the planner named only Bloom<->BlockedBloom crossings).
 * ========================================================================== */

function filledBlocked(opts) {
    const f = new BlockedBloom(1000, opts);
    for (let i = 0; i < 800; i++) f.add(opts && opts.keys === "int" ? i : "k-" + i);
    return f;
}
function filledCounting(opts) {
    const f = new CountingBloom(1000, opts);
    for (let i = 0; i < 800; i++) f.add(opts && opts.keys === "int" ? i : "k-" + i);
    return f;
}

test("QA-BB5 adversarial: a CountingBloom snapshot into BlockedBloom.restore is rejected (member mismatch), and vice versa", () => {
    const cbfSnap = filledCounting({ keys: "int" }).dump();
    assert.throws(() => BlockedBloom.restore(cbfSnap), /\[lite-filter\].*member/,
        "a CountingBloom snapshot must be rejected by BlockedBloom.restore -- the planner named only Bloom crossings");

    const bbSnap = filledBlocked({ keys: "int" }).dump();
    assert.throws(() => CountingBloom.restore(bbSnap), /\[lite-filter\].*member/,
        "a BlockedBloom snapshot must be rejected by CountingBloom.restore");
});

test("QA-BB5: restore() validates EVERY word (and the full-length store) BEFORE writing ANY word into the instance store", () => {
    // Corrupt the LAST word only. If validation is a full pre-scan that runs to
    // completion (and throws) BEFORE the write loop begins, a Proxy tracking index
    // reads on `snap.bits` must see each index read AT MOST ONCE (from the validation
    // scan) -- never twice (which would mean the write loop also ran, i.e. mutation
    // happened despite the corruption: the v0.1.0 fail-open class).
    const snap = filledBlocked({ keys: "int" }).dump();
    const badIdx = snap.bits.length - 1;
    snap.bits[badIdx] = -1; // out of the 0..0xffffffff range
    const accessCounts = new Map();
    const proxied = new Proxy(snap.bits, {
        get(target, prop, receiver) {
            if (typeof prop === "string" && /^\d+$/.test(prop)) {
                const idx = Number(prop);
                accessCounts.set(idx, (accessCounts.get(idx) || 0) + 1);
            }
            return Reflect.get(target, prop, receiver);
        },
    });
    snap.bits = proxied;

    assert.throws(() => BlockedBloom.restore(snap), /\[lite-filter\]/);

    assert.ok(accessCounts.has(badIdx), "test setup: the corrupt last index must actually have been scanned");
    for (const [idx, count] of accessCounts) {
        assert.ok(count <= 1,
            "index " + idx + " was read " + count + " times -- the write loop ran despite a corrupt word (fail-open on restore)");
    }
});

test("QA-BB5: a repeated failed restore() leaves no residue that corrupts a later clean restore()", () => {
    const goodSnap = filledBlocked({ keys: "int" }).dump();
    for (let trial = 0; trial < 5; trial++) {
        const bad = filledBlocked({ keys: "int" }).dump();
        bad.bits[0] = Number.NaN;
        assert.throws(() => BlockedBloom.restore(bad));
    }
    const g = BlockedBloom.restore(goodSnap);
    for (let i = 0; i < 800; i++) assert.equal(g.mightContain(i), true);
    validateBlocked(g);
});

/* ============================================================================
 * k-clamp: prove the clamp actually ENGAGES (derived k > 512 before clamping),
 * not merely that every tested (capacity, fpp) happens to land at k <= 512.
 * ========================================================================== */

test("QA k-clamp: a (capacity, fpp) pair that derives k > 512 in plain Bloom is CLAMPED to exactly 512 in BlockedBloom, and still functions correctly", () => {
    const opts = { fpp: 1e-200 };
    const plain = new Bloom(1, opts);
    assert.ok(plain._k > 512, "test setup: expected plain Bloom's derived k to exceed 512, got " + plain._k);

    const blocked = new BlockedBloom(1, opts);
    assert.equal(blocked._k, 512, "BlockedBloom must clamp k to exactly 512 when the derived value exceeds it");
    assert.ok(blocked._k >= 1, "the k >= 1 lower bound must also hold");

    blocked.add(123456);
    assert.equal(blocked.mightContain(123456), true, "a clamped filter must still have no false negatives");
    validateBlocked(blocked);
    validateBlockedLocality(blocked);
});

test("QA k-clamp: k never exceeds 512 across a sweep of capacities crossed with tiny fpp values", () => {
    for (const fpp of [1e-3, 1e-30, 1e-100, 1e-250]) {
        for (const cap of [1, 2, 50]) {
            const f = new BlockedBloom(cap, { fpp: fpp });
            assert.ok(f._k >= 1 && f._k <= 512, "cap=" + cap + " fpp=" + fpp + " k=" + f._k + " out of 1..512");
        }
    }
});

/* ============================================================================
 * has() is the SOLE alias -- no undocumented third method name exists.
 * ========================================================================== */

test("QA boundary: BlockedBloom has() is the SOLE alias of mightContain -- no third method name exists", () => {
    const names = Object.getOwnPropertyNames(BlockedBloom.prototype);
    const forbidden = ["contains", "member", "isMember", "query", "check", "test"];
    for (const n of forbidden) {
        assert.equal(names.includes(n), false, "an undocumented alias '" + n + "' must not exist");
    }
    assert.notEqual(BlockedBloom.prototype.has, BlockedBloom.prototype.mightContain,
        "has must be a distinct delegating method, not a re-export of the same reference");
    const f = new BlockedBloom(10, { keys: "int" });
    f.add(1);
    assert.equal(f.has(1), f.mightContain(1));
});

/* ============================================================================
 * clear(): zeroes in place (same ArrayBuffer identity), resets size, and does
 * NOT reset stats (matches Bloom's clear() contract). "Duplicate dispose"
 * analog: clear() called twice in a row is idempotent, no throw.
 * ========================================================================== */

test("QA clear: does NOT reset stats (matches Bloom's clear() contract) and reuses the same buffer", () => {
    const f = new BlockedBloom(200, { keys: "int", stats: true });
    for (let i = 0; i < 100; i++) f.add(i);
    for (let i = 0; i < 100; i++) f.mightContain(i);
    const buf = f._words.buffer;
    const statsBefore = f.stats();
    assert.ok(statsBefore.adds > 0 && statsBefore.queries > 0, "test setup: stats must be non-zero before clear()");

    f.clear();

    assert.equal(f._words.buffer, buf, "clear() must not reallocate");
    assert.equal(f.size, 0);
    assert.equal(f.stats().adds, statsBefore.adds, "clear() must NOT reset the adds counter");
    assert.equal(f.stats().queries, statsBefore.queries, "clear() must NOT reset the queries counter");
});

test("QA duplicate-dispose analog: clear() called twice in a row is idempotent, same buffer, no throw", () => {
    const f = new BlockedBloom(100, { keys: "int" });
    const buf = f._words.buffer;
    for (let i = 0; i < 100; i++) f.add(i);
    f.clear();
    assert.doesNotThrow(() => f.clear());
    assert.equal(f.size, 0);
    assert.equal(f._words.buffer, buf);
    for (const w of f._words) assert.equal(w, 0);
    validateBlocked(f);
});

/* ============================================================================
 * "dispose-during-iteration" analog: BlockedBloom has no iterator; the nearest
 * hazard is dump() returning a LIVE view into the word store rather than a copy.
 * ========================================================================== */

test("QA dispose-during-iteration analog: dump() output is isolated from subsequent mutation of the filter", () => {
    const f = new BlockedBloom(200, { keys: "int" });
    for (let i = 0; i < 100; i++) f.add(i);
    const snap1 = f.dump();
    const bitsCopy = snap1.bits.slice();
    for (let i = 100; i < 20000; i++) f.add(i); // heavy mutation AFTER the snapshot
    assert.deepEqual(snap1.bits, bitsCopy, "dump() must return an independent copy, not a live view into _words");
    assert.equal(snap1.count, 100, "the snapshot's recorded count must reflect state AT dump() time");
});

/* ============================================================================
 * Re-entrant write: the arbitrary (non-int) key path calls String(key) -> for an
 * object, key.toString(). A toString() that calls back into add() on the SAME
 * filter mid-hash must not corrupt either key's final state.
 * ========================================================================== */

test("QA re-entrant write: a key.toString() that calls add() on the SAME BlockedBloom mid-hash does not corrupt state", () => {
    const f = new BlockedBloom(1000);
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
    validateBlocked(f);
});

/* ============================================================================
 * keys:'int' door boundary matrix: 0, -0, N-1/N/N+1 at INT32 edges, NaN, null,
 * undefined, non-integer floats -- on BOTH add() and mightContain().
 * ========================================================================== */

test("QA boundary: BlockedBloom keys:'int' door -- 0/-0/INT_MIN/INT_MAX/INT_MIN-1/INT_MAX+1/NaN/null/undefined/1.5 on add AND mightContain", () => {
    const f = new BlockedBloom(10, { keys: "int" });
    for (const good of [0, -0, -2147483648, 2147483647]) {
        assert.doesNotThrow(() => f.add(good), "add(" + good + ") must be accepted");
        assert.equal(f.mightContain(good), true);
    }
    for (const bad of [-2147483649, 2147483648, NaN, null, undefined, 1.5, -1.5, "5", {}, [], Infinity, -Infinity]) {
        assert.throws(() => f.add(bad), /\[lite-filter\].*keys:'int'/, "add(" + String(bad) + ")");
        assert.throws(() => f.mightContain(bad), /\[lite-filter\].*keys:'int'/, "mightContain(" + String(bad) + ")");
    }
    validateBlocked(f);
});

/* ============================================================================
 * Empty edge: a filter with ZERO adds.
 * ========================================================================== */

test("QA empty: a fresh BlockedBloom with ZERO adds has size 0, an all-zero store, and mightContain is false everywhere probed", () => {
    const f = new BlockedBloom(500, { keys: "int" });
    assert.equal(f.size, 0);
    for (const w of f._words) assert.equal(w, 0);
    for (let i = -100; i < 100; i++) assert.equal(f.mightContain(i), false);
    validateBlocked(f);
    const snap = f.dump();
    assert.equal(snap.count, 0);
    const g = BlockedBloom.restore(snap);
    assert.equal(g.size, 0);
    for (const w of g._words) assert.equal(w, 0);
});

/* ============================================================================
 * remove() add-only door.
 * ========================================================================== */

test("QA: BlockedBloom.remove() ALWAYS throws [lite-filter] (add-only), regardless of prior state", () => {
    const empty = new BlockedBloom(10);
    assert.throws(() => empty.remove("anything"), /\[lite-filter\].*add-only/);
    const filled = new BlockedBloom(10, { keys: "int" });
    filled.add(1);
    assert.throws(() => filled.remove(1), /\[lite-filter\].*add-only/);
    assert.equal(filled.mightContain(1), true, "a rejected remove() must not have mutated state");
});
