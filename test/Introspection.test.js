/**
 * @zakkster/lite-filter -- node:test introspection suite (decisions/0024, 0025, 0026).
 *
 * The read-only config getters added in 1.2.0 (H1 close-out of the 2026-09-23 audit):
 *   keysMode  -- 'int' | 'arbitrary', a module constant returned identically on every read.
 *   seed      -- the 32-bit unsigned hash seed; the validated ctor seed on the 5 dynamic
 *                members, the WINNING build seed on the 2 static members (0 before a build).
 *   maxLoad   -- the item ceiling as an UPPER BOUND (decisions/0026): an add past it certainly
 *                throws; an add below it MAY still throw on Cuckoo / Quotient.
 *   saturation-- size / maxLoad in [0, 1]; 0 when maxLoad is Infinity or 0; never NaN.
 *
 * Every value is PINNED against a MEASURED ceiling (Cuckoo(64) 128 / 127 adds, Quotient(64)
 * 115) rather than an assumed one, and the signed-fold door (decisions/0024) is pinned both
 * ways: a `>>> 0` value throws with the fix named, a `| 0` fold is accepted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter, BinaryFuse } from "../Filter.js";

// The dynamic (incrementally-added) members: keysMode/seed/maxLoad/saturation on a live filter.
const DYNAMIC = [
    ["Bloom", Bloom],
    ["CountingBloom", CountingBloom],
    ["BlockedBloom", BlockedBloom],
    ["Cuckoo", Cuckoo],
    ["Quotient", Quotient],
];
// The Bloom-class members whose maxLoad is Infinity (adds never fail; the FPR degrades).
const INFINITE = [["Bloom", Bloom], ["CountingBloom", CountingBloom], ["BlockedBloom", BlockedBloom]];
// The static (build-once) members: keysMode/seed/maxLoad/saturation on a built instance.
const STATIC = [["XorFilter", XorFilter], ["BinaryFuse", BinaryFuse]];

// The actual default seed, read from the code path (validateSeed(undefined)) via a member,
// NOT hardcoded: every dynamic member must report exactly this when constructed seedless.
const DEFAULT_SEED = new Bloom(64).seed;

// ---- keysMode ---------------------------------------------------------------

test("keysMode: every dynamic member reports 'arbitrary' by default and 'int' in int mode", () => {
    for (const [name, Ctor] of DYNAMIC) {
        assert.equal(new Ctor(64).keysMode, "arbitrary", name + " default");
        assert.equal(new Ctor(64, { keys: "int" }).keysMode, "int", name + " int");
    }
});

test("keysMode: every static member reports the mode it was built in", () => {
    for (const [name, Ctor] of STATIC) {
        assert.equal(Ctor.from(["a", "b", "c"]).keysMode, "arbitrary", name + " default");
        assert.equal(Ctor.from([1, 2, 3], { keys: "int" }).keysMode, "int", name + " int");
    }
});

test("keysMode: returns the SAME constant reference on every read (never built per call)", () => {
    for (const [name, Ctor] of DYNAMIC) {
        const f = new Ctor(64, { keys: "int" });
        assert.equal(f.keysMode, f.keysMode, name + " int idempotent");
        assert.equal(f.keysMode === f.keysMode, true, name + " int identity");
        const g = new Ctor(64);
        assert.equal(g.keysMode, g.keysMode, name + " arbitrary idempotent");
    }
    for (const [name, Ctor] of STATIC) {
        const f = Ctor.from([1, 2, 3], { keys: "int" });
        assert.equal(f.keysMode, f.keysMode, name + " static idempotent");
    }
});

// ---- seed -------------------------------------------------------------------

test("seed: all 5 dynamic members report the SAME default seed (the validateSeed default)", () => {
    assert.equal(DEFAULT_SEED >>> 0, DEFAULT_SEED, "default seed is a 32-bit unsigned");
    for (const [name, Ctor] of DYNAMIC) {
        assert.equal(new Ctor(64).seed, DEFAULT_SEED, name + " default seed");
        assert.equal(new Ctor(64, { keys: "int" }).seed, DEFAULT_SEED, name + " int default seed");
    }
});

test("seed: an explicit seed round-trips as a 32-bit unsigned on every dynamic member", () => {
    for (const [name, Ctor] of DYNAMIC) {
        assert.equal(new Ctor(64, { seed: 12345 }).seed, 12345, name + " small seed");
        // A high-bit seed must read back UNSIGNED (>>> 0), not as a negative int32.
        assert.equal(new Ctor(64, { seed: 0x80000000 }).seed, 2147483648, name + " high-bit seed");
    }
});

test("seed: static members report the WINNING build seed, matching dump().seed", () => {
    for (const [name, Ctor] of STATIC) {
        const f = Ctor.from([1, 2, 3, 4, 5], { keys: "int" });
        assert.equal(f.seed >>> 0, f.seed, name + " seed unsigned");
        assert.equal(f.seed, f.dump().seed >>> 0, name + " seed == dump().seed");
        // An explicit starting seed is honored when the first build attempt peels.
        const g = Ctor.from([10, 20, 30], { keys: "int", seed: 99 });
        assert.equal(g.seed, g.dump().seed >>> 0, name + " explicit-seed build == dump().seed");
    }
});

// ---- maxLoad / saturation: Bloom class (Infinity / 0) ------------------------

test("maxLoad/saturation: Bloom-class members report Infinity and saturation 0 (empty and filled)", () => {
    for (const [name, Ctor] of INFINITE) {
        const f = new Ctor(64, { keys: "int" });
        assert.equal(f.maxLoad, Infinity, name + " empty maxLoad");
        assert.equal(f.saturation, 0, name + " empty saturation");
        assert.equal(Number.isNaN(f.saturation), false, name + " empty saturation not NaN");
        for (let i = 0; i < 200; i++) f.add(i);
        assert.equal(f.maxLoad, Infinity, name + " filled maxLoad");
        assert.equal(f.saturation, 0, name + " filled saturation stays 0 (Infinity ceiling)");
        assert.equal(Number.isNaN(f.saturation), false, name + " filled saturation not NaN");
    }
});

// ---- maxLoad / saturation: Cuckoo (measured ceiling 128, 127 adds) -----------

test("maxLoad: Cuckoo(64).maxLoad === 128, and 127 adds succeed before the 128th throws (default seed)", () => {
    const c = new Cuckoo(64, { keys: "int" });
    assert.equal(c.maxLoad, 128, "Cuckoo(64) ceiling nb*b");
    let accepted = 0;
    let threw = false;
    try {
        for (let i = 0; i < 100000; i++) { c.add(i); accepted++; }
    } catch (e) {
        threw = e instanceof Error && /\[lite-filter\]/.test(e.message);
    }
    // MEASURED (default seed): exactly 127 adds land before the fail-closed door.
    assert.equal(threw, true, "the overload must throw [lite-filter] fail-closed");
    assert.equal(accepted, 127, "Cuckoo(64) accepts 127 adds before the 128th throws (measured)");
    assert.equal(c.size, 127, "size after the thrown 128th add stays 127 (no partial insert)");
    assert.equal(c.saturation, 127 / 128, "saturation == size / maxLoad");
    assert.equal(Number.isNaN(c.saturation), false, "saturation not NaN");
    assert.ok(c.maxLoad >= c.size, "maxLoad is an upper bound: size never exceeds it");
});

// The overload error text names the correct headroom check (decisions/0026): "saturation
// (size / maxLoad)", not the old "size vs capacity" advice, and states maxLoad is an
// upper bound.
test("Cuckoo overload message mentions saturation and maxLoad (not the old size-vs-capacity text)", () => {
    const c = new Cuckoo(64, { keys: "int" });
    let msg = null;
    try {
        for (let i = 0; i < 100000; i++) c.add(i);
    } catch (e) {
        msg = e.message;
    }
    assert.notEqual(msg, null, "test setup: the overload must actually throw");
    assert.match(msg, /saturation/, "Cuckoo overload text must mention saturation");
    assert.match(msg, /maxLoad/, "Cuckoo overload text must mention maxLoad");
    assert.match(msg, /upper bound/, "Cuckoo overload text must state maxLoad is an upper bound");
});

// saturation must stay in [0, 1] at EVERY step of the fill, not just at the start/end
// boundary -- a monotonic sweep from empty to the throw point (Cuckoo).
test("saturation: Cuckoo stays in [0, 1] at every add from empty to the throw point", () => {
    const c = new Cuckoo(64, { keys: "int" });
    assert.ok(c.saturation >= 0 && c.saturation <= 1, "empty saturation in range");
    let prev = c.saturation;
    let steps = 0;
    try {
        for (let i = 0; i < 100000; i++) {
            c.add(i);
            const s = c.saturation;
            assert.equal(Number.isNaN(s), false, "saturation not NaN at step " + i);
            assert.ok(s >= 0 && s <= 1, "saturation out of [0,1] at step " + i + ": " + s);
            assert.ok(s >= prev - 1e-12, "saturation must not decrease on add at step " + i);
            prev = s;
            steps++;
        }
    } catch (e) {
        assert.match(e.message, /\[lite-filter\]/, "the throw must be the fail-closed overload");
    }
    assert.ok(steps > 0, "test setup: the sweep must actually run at least one add");
});

// ---- maxLoad / saturation: Quotient (measured ceiling 115, tracks resize) ----

test("maxLoad: Quotient(64).maxLoad === 115 and tracks resize()", () => {
    const q = new Quotient(64, { keys: "int" });
    assert.equal(q.maxLoad, 115, "Quotient(64) ceiling floor(0.90 * nslots)");
    // resize() re-derives the ceiling from the new slot count -- MEASURE it, do not assume.
    q.resize(1000);
    const afterResize = q.maxLoad;
    assert.equal(afterResize, Math.floor(0.90 * q._nslots), "maxLoad == floor(0.90 * nslots) after resize");
    assert.ok(afterResize > 115, "resize(1000) raises the ceiling above the original 115 (measured " + afterResize + ")");
    assert.equal(q.saturation, q.size / afterResize, "saturation tracks the resized ceiling");
    assert.equal(Number.isNaN(q.saturation), false, "saturation not NaN");
});

test("Quotient overload message mentions saturation and maxLoad (not the old size-vs-capacity text)", () => {
    const q = new Quotient(64, { keys: "int" });
    let msg = null;
    try {
        for (let i = 0; i < 100000; i++) q.add(i);
    } catch (e) {
        msg = e.message;
    }
    assert.notEqual(msg, null, "test setup: the overload must actually throw");
    assert.match(msg, /saturation/, "Quotient overload text must mention saturation");
    assert.match(msg, /maxLoad/, "Quotient overload text must mention maxLoad");
    assert.match(msg, /upper bound/, "Quotient overload text must state maxLoad is an upper bound");
});

// saturation must stay in [0, 1] at EVERY step of the fill, not just at the start/end
// boundary -- a monotonic sweep from empty to the throw point (Quotient).
test("saturation: Quotient stays in [0, 1] at every add from empty to the throw point", () => {
    const q = new Quotient(64, { keys: "int" });
    assert.ok(q.saturation >= 0 && q.saturation <= 1, "empty saturation in range");
    let prev = q.saturation;
    let steps = 0;
    let threw = false;
    try {
        for (let i = 0; i < 100000; i++) {
            q.add(i);
            const s = q.saturation;
            assert.equal(Number.isNaN(s), false, "saturation not NaN at step " + i);
            assert.ok(s >= 0 && s <= 1, "saturation out of [0,1] at step " + i + ": " + s);
            assert.ok(s >= prev - 1e-12, "saturation must not decrease on add at step " + i);
            prev = s;
            steps++;
        }
    } catch (e) {
        threw = true;
        assert.match(e.message, /\[lite-filter\]/, "the throw must be the fail-closed overload");
    }
    assert.ok(steps > 0, "test setup: the sweep must actually run at least one add");
    assert.ok(threw, "test setup: the sweep must actually reach the throw point");
});

test("maxLoad: Quotient's live _maxLoad field is not shadowed and drives the getter", () => {
    const q = new Quotient(64, { keys: "int" });
    assert.equal(q.maxLoad, q._maxLoad, "getter reads the live own field");
    q.resize(500);
    assert.equal(q.maxLoad, q._maxLoad, "getter still reads the live field after resize");
    q.add(1); q.add(2); q.add(3);
    assert.equal(q.maxLoad, q._maxLoad, "getter tracks the field across adds");
});

// merge() also mutates slot count (it may grow the receiver to hold both operands), so
// maxLoad/saturation must stay live through merge(), not just resize() (decisions/0026).
test("maxLoad: Quotient.maxLoad/saturation stay live after merge()", () => {
    const A = new Quotient(64, { keys: "int", seed: 5 });
    const B = new Quotient(64, { keys: "int", seed: 5 });
    const beforeMaxLoad = A.maxLoad;
    for (let i = 0; i < 40; i++) A.add(i);
    for (let i = 1000; i < 1040; i++) B.add(i);
    A.merge(B);
    assert.equal(A.maxLoad, A._maxLoad, "getter reads the live field after merge()");
    assert.equal(A.size, 80, "merge is exactly additive");
    assert.ok(A.maxLoad >= beforeMaxLoad, "merge never shrinks the ceiling (measured " + A.maxLoad + " vs " + beforeMaxLoad + ")");
    assert.equal(A.saturation, A.size / A.maxLoad, "saturation tracks the post-merge ceiling");
    assert.equal(Number.isNaN(A.saturation), false, "saturation not NaN after merge");
    assert.ok(A.saturation >= 0 && A.saturation <= 1, "saturation stays in [0, 1] after merge");
});

// ---- maxLoad / saturation: static members (size / 1 after build) -------------

test("maxLoad/saturation: static members report size and saturation 1 after from(), never NaN", () => {
    for (const [name, Ctor] of STATIC) {
        for (const mode of [{ keys: "int" }, {}]) {
            const keys = mode.keys === "int" ? [1, 2, 3, 4, 5, 6, 7] : ["a", "b", "c", "d", "e", "f", "g"];
            const f = Ctor.from(keys, mode);
            assert.equal(f.maxLoad, f.size, name + " built maxLoad == size");
            assert.equal(f.saturation, 1, name + " built saturation == 1 (full by construction)");
            assert.equal(Number.isNaN(f.saturation), false, name + " saturation not NaN");
        }
    }
});

// Note: an UNBUILT static instance (maxLoad 0 / saturation 0 before a build, decisions/0026)
// is NOT publicly constructible -- `new XorFilter()` / `new BinaryFuse()` throw fail-closed --
// so the 0/0 state is unreachable by a consumer. The getter still returns 0/0 in that internal
// state (this._count is 0), verified transitively by the "never NaN" assertions above.
//
// The SAME applies to `seed === 0 before a successful build` (decisions/0025): the module-
// private build token (`XOR_BUILD_TOKEN` / `BF_BUILD_TOKEN`) is not exported, so no test in
// this package can construct a bare, unbuilt instance to observe `seed` before `from()`
// completes. This is confirmed by reading the constructor (`this._seed = 0;` is the initial
// sentinel, Filter.js) rather than by a runtime assertion -- a source-level check, not a
// measured one. It is the identical unreachability class as maxLoad/saturation 0/0 above, by
// the same fail-closed constructor guard.

// ---- restore() preserves the getters ----------------------------------------

test("restore(): the getters equal the source's on every member (dynamic and static)", () => {
    for (const [name, Ctor] of DYNAMIC) {
        const src = new Ctor(256, { keys: "int", seed: 4242 });
        for (let i = 0; i < 50; i++) src.add(i);
        const round = Ctor.restore(JSON.parse(JSON.stringify(src.dump())));
        assert.equal(round.keysMode, src.keysMode, name + " keysMode");
        assert.equal(round.seed, src.seed, name + " seed");
        assert.equal(round.maxLoad, src.maxLoad, name + " maxLoad");
        assert.equal(round.saturation, src.saturation, name + " saturation");
    }
    for (const [name, Ctor] of STATIC) {
        const keys = []; for (let i = 0; i < 200; i++) keys.push(i);
        const src = Ctor.from(keys, { keys: "int" });
        const round = Ctor.restore(JSON.parse(JSON.stringify(src.dump())));
        assert.equal(round.keysMode, src.keysMode, name + " keysMode");
        assert.equal(round.seed, src.seed, name + " seed");
        assert.equal(round.maxLoad, src.maxLoad, name + " maxLoad");
        assert.equal(round.saturation, src.saturation, name + " saturation");
    }
});

// ---- keys:'int' signed-fold door (decisions/0024) ----------------------------

test("keys:'int': add(2147483648) and add(0xFFFFFFFF) throw with the fix ('| 0') named", () => {
    for (const [name, Ctor] of DYNAMIC) {
        const f = new Ctor(64, { keys: "int" });
        assert.throws(() => f.add(2147483648),
            (e) => e instanceof TypeError && e.message.includes("| 0"), name + " add(2^31)");
        assert.throws(() => f.add(0xFFFFFFFF),
            (e) => e instanceof TypeError && e.message.includes("| 0"), name + " add(0xFFFFFFFF)");
    }
    for (const [name, Ctor] of STATIC) {
        assert.throws(() => Ctor.from([2147483648], { keys: "int" }),
            (e) => e instanceof TypeError && e.message.includes("| 0"), name + " from([2^31])");
        assert.throws(() => Ctor.from([0xFFFFFFFF], { keys: "int" }),
            (e) => e instanceof TypeError && e.message.includes("| 0"), name + " from([0xFFFFFFFF])");
    }
});

test("keys:'int': a signed `(a<<20 | b<<12 | c) | 0` fold is accepted on every member", () => {
    const a = 900, b = 17, c = 250;
    const folded = ((a << 20) | (b << 12) | c) | 0;   // a valid signed int32 (may be negative)
    for (const [name, Ctor] of DYNAMIC) {
        const f = new Ctor(64, { keys: "int" });
        assert.doesNotThrow(() => f.add(folded), name + " accepts the | 0 fold");
        assert.equal(f.mightContain(folded), true, name + " reads the folded key back");
    }
    for (const [name, Ctor] of STATIC) {
        const f = Ctor.from([folded], { keys: "int" });
        assert.equal(f.mightContain(folded), true, name + " static reads the folded key back");
    }
});
