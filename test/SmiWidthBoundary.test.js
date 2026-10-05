// test/SmiWidthBoundary.test.js -- H2 (1.2.1, ROADMAP 13) boundary matrix vs the frozen 1.2.0.
//
// The parity oracle (test/parity/parity.mjs) sweeps random keys at scale. This file pins the
// EDGES of the rewritten int path, op by op, against test/fixtures/Filter.1.2.0.js:
//   - int keys INT_MIN, INT_MAX, 0, +-1, +-2, +-2^30, 2^30-1, -2^30-1 (and neighbours) for
//     add / has / mightContain / remove on every member, with the dump() compared after EVERY op;
//   - key doors throw the SAME error BEFORE any state change (incl. NaN, +-Infinity, -0, null,
//     undefined, BigInt, boxed Number, Symbol, out-of-int32);
//   - Quotient's `_hash` door + load-ceiling throw (N-1, N, N+1) leave the filter byte-identical;
//   - Cuckoo full-table throw (kick + unwind) and the post-throw rng stream vs the fixture;
//   - XorFilter / BinaryFuse from() over every n in {1, 2, 3} subset of the int edges;
//   - dump() / restore() round-trip and cross-restore on every member;
//   - re-entrant writes from a toString(), and an interleaved cross-class / cross-instance
//     sequence (the module `_HG` scratch is shared by every class).
//
// LF_FILE overrides the module under test (absolute or cwd-relative), matching the perf lanes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = HERE + "fixtures/Filter.1.2.0.js";
const UNDER_TEST = process.env.LF_FILE
    ? (process.env.LF_FILE[0] === "/" ? process.env.LF_FILE : process.cwd() + "/" + process.env.LF_FILE)
    : HERE + "../Filter.js";

const A = await import(pathToFileURL(FIXTURE).href);   // reference (1.2.0)
const B = await import(pathToFileURL(UNDER_TEST).href); // under test

const MUTABLE = ["Bloom", "CountingBloom", "BlockedBloom", "Cuckoo", "Quotient"];
const DELETABLE = new Set(["CountingBloom", "Cuckoo", "Quotient"]);
const STATIC = ["XorFilter", "BinaryFuse"];
const ALL = [...MUTABLE, ...STATIC];
const SEEDS = [undefined, 0, 1, 0x80000000, 0xffffffff, 0x9e3779b1];

const P30 = 1073741824;
const EDGES = [
    -2147483648, 2147483647, 0, 1, -1, 2, -2,
    P30, -P30, P30 - 1, -P30 - 1, P30 + 1, -P30 + 1,
    -2147483647, 2147483646,
];
// Probe set: every edge plus its +-1/+-2 neighbours that stay in int32 (dedup).
const PROBE = [...new Set(EDGES.flatMap((e) => [e - 2, e - 1, e, e + 1, e + 2])
    .filter((k) => k >= -2147483648 && k <= 2147483647))];

const BAD_KEYS = [
    ["1.5", 1.5], ["-0.5", -0.5], ["2^31", 2147483648], ["-2^31-1", -2147483649],
    ["2^32", 4294967296], ["2^53", 2 ** 53], ["MAX_VALUE", Number.MAX_VALUE],
    ["MIN_VALUE", Number.MIN_VALUE], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
    ["null", null], ["undefined", undefined], ["'1'", "1"], ["''", ""], ["1n", 1n], ["true", true],
    ["{}", {}], ["[]", []], ["[5]", [5]], ["new Number(5)", new Number(5)], ["Symbol", Symbol("k")],
];

const snap = (f) => JSON.stringify(f.dump());
const outcome = (fn) => {
    try { const v = fn(); return { ok: true, v }; } catch (e) { return { ok: false, name: e.constructor.name, msg: e.message }; }
};
const mk = (M, mem, cap, opts) => new M[mem](cap, opts);
const optsFor = (seed, extra) => { const o = { keys: "int", ...extra }; if (seed !== undefined) o.seed = seed; return o; };
const tagOf = (mem, seed) => mem + "/seed=" + seed;

/* ------------------------------------------------------------------------ */

test("int edges: add/has/mightContain on every mutable member, dump() equal to 1.2.0 after EVERY op", () => {
    for (const mem of MUTABLE) {
        for (const seed of SEEDS) {
            const tag = tagOf(mem, seed);
            const fa = mk(A, mem, 64, optsFor(seed)), fb = mk(B, mem, 64, optsFor(seed));
            for (const k of PROBE) {
                assert.equal(fb.has(k), fa.has(k), tag + " empty has(" + k + ")");
                assert.equal(fb.has(k), false, tag + " empty filter must read false for " + k);
            }
            for (const k of EDGES) {
                const ra = outcome(() => fa.add(k)), rb = outcome(() => fb.add(k));
                assert.deepEqual(rb, ra, tag + " add(" + k + ") outcome");
                assert.equal(snap(fb), snap(fa), tag + " dump after add(" + k + ")");
                assert.equal(fb.size, fa.size, tag + " size after add(" + k + ")");
                assert.equal(fb.has(k), true, tag + " no false negative for " + k);
            }
            for (const k of PROBE) {
                assert.equal(fb.has(k), fa.has(k), tag + " has(" + k + ")");
                assert.equal(fb.mightContain(k), fa.mightContain(k), tag + " mightContain(" + k + ")");
            }
        }
    }
});

test("int edges: remove() on every deletable member -- once, twice (duplicate), never-added; dump equal each op", () => {
    for (const mem of DELETABLE) {
        for (const seed of SEEDS) {
            const tag = tagOf(mem, seed);
            const fa = mk(A, mem, 64, optsFor(seed)), fb = mk(B, mem, 64, optsFor(seed));
            // remove on EMPTY (0 items) first.
            for (const k of EDGES) assert.deepEqual(outcome(() => fb.remove(k)), outcome(() => fa.remove(k)), tag + " remove-empty(" + k + ")");
            assert.equal(snap(fb), snap(fa), tag + " dump after empty removes");
            for (const k of EDGES) { fa.add(k); fb.add(k); }
            // Remove every other edge, then the SAME edges again (duplicate remove), then neighbours never added.
            const order = [...EDGES.filter((_, i) => i % 2 === 0), ...EDGES.filter((_, i) => i % 2 === 0), ...PROBE];
            for (const k of order) {
                const ra = outcome(() => fa.remove(k)), rb = outcome(() => fb.remove(k));
                assert.deepEqual(rb, ra, tag + " remove(" + k + ") outcome");
                assert.equal(snap(fb), snap(fa), tag + " dump after remove(" + k + ")");
                assert.equal(fb.size, fa.size, tag + " size after remove(" + k + ")");
            }
            for (const k of PROBE) assert.equal(fb.has(k), fa.has(k), tag + " has(" + k + ") after removes");
            // Re-add after remove restores membership identically.
            for (const k of EDGES) { fa.add(k); fb.add(k); }
            assert.equal(snap(fb), snap(fa), tag + " dump after re-add");
        }
    }
});

test("int edges: -0 is key 0 (accepted, same bits as +0, same as 1.2.0)", () => {
    for (const mem of MUTABLE) {
        const fa = mk(A, mem, 64, optsFor()), fb = mk(B, mem, 64, optsFor()), f0 = mk(B, mem, 64, optsFor());
        fa.add(-0); fb.add(-0); f0.add(0);
        assert.equal(snap(fb), snap(fa), mem + " add(-0) dump vs 1.2.0");
        assert.equal(snap(fb), snap(f0), mem + " add(-0) must equal add(0)");
        assert.equal(fb.has(0), true, mem + " has(0) after add(-0)");
        assert.equal(fb.has(-0), true, mem + " has(-0)");
        if (DELETABLE.has(mem)) {
            assert.deepEqual(outcome(() => fb.remove(0)), outcome(() => fa.remove(0)), mem + " remove(0) after add(-0)");
            assert.equal(snap(fb), snap(fa), mem + " dump after remove");
        }
    }
    for (const mem of STATIC) {
        const xa = A[mem].from([-0, 5], { keys: "int" }), xb = B[mem].from([-0, 5], { keys: "int" });
        const x0 = B[mem].from([0, 5], { keys: "int" });
        assert.equal(snap(xb), snap(xa), mem + " from([-0,5]) vs 1.2.0");
        assert.equal(snap(xb), snap(x0), mem + " from([-0,5]) must equal from([0,5])");
        assert.equal(xb.has(-0), true, mem + " has(-0)");
    }
});

test("key doors: every bad key throws the 1.2.0 error BEFORE any state change (all ops, all members)", () => {
    for (const mem of MUTABLE) {
        const fa = mk(A, mem, 64, optsFor(0x80000000, { stats: true }));
        const fb = mk(B, mem, 64, optsFor(0x80000000, { stats: true }));
        for (const k of EDGES) { fa.add(k); fb.add(k); }
        const before = snap(fb);
        const statsBefore = JSON.stringify(fb.stats());
        const ops = ["add", "has", "mightContain"];
        if (DELETABLE.has(mem)) ops.push("remove");
        for (const [label, bad] of BAD_KEYS) {
            for (const op of ops) {
                const ra = outcome(() => fa[op](bad)), rb = outcome(() => fb[op](bad));
                assert.equal(rb.ok, false, mem + "." + op + "(" + label + ") must throw");
                assert.deepEqual(rb, ra, mem + "." + op + "(" + label + ") error vs 1.2.0");
                assert.equal(rb.name, "TypeError", mem + "." + op + "(" + label + ") must be a TypeError");
                assert.equal(snap(fb), before, mem + "." + op + "(" + label + ") mutated the filter before throwing");
            }
        }
        assert.equal(JSON.stringify(fb.stats()), statsBefore, mem + " a thrown door moved stats");
        assert.equal(JSON.stringify(fb.stats()), JSON.stringify(fa.stats()), mem + " stats vs 1.2.0");
        // The scratch is not poisoned: a good op right after a throw still agrees with 1.2.0.
        for (const k of PROBE) assert.equal(fb.has(k), fa.has(k), mem + " has(" + k + ") after door throws");
    }
    for (const mem of STATIC) {
        const xa = A[mem].from(EDGES, { keys: "int" }), xb = B[mem].from(EDGES, { keys: "int" });
        const before = snap(xb);
        for (const [label, bad] of BAD_KEYS) {
            for (const op of ["has", "mightContain"]) {
                const ra = outcome(() => xa[op](bad)), rb = outcome(() => xb[op](bad));
                assert.equal(rb.ok, false, mem + "." + op + "(" + label + ") must throw");
                assert.deepEqual(rb, ra, mem + "." + op + "(" + label + ") error vs 1.2.0");
            }
            // from() door: one bad key anywhere in the set rejects the whole build, same message.
            for (const pos of [0, 1, EDGES.length]) {
                const ks = EDGES.slice(); ks.splice(pos, 0, bad);
                const ra = outcome(() => A[mem].from(ks, { keys: "int" })), rb = outcome(() => B[mem].from(ks, { keys: "int" }));
                assert.equal(rb.ok, false, mem + ".from(+" + label + "@" + pos + ") must throw");
                assert.deepEqual(rb, ra, mem + ".from(+" + label + "@" + pos + ") error vs 1.2.0");
            }
        }
        assert.equal(snap(xb), before, mem + " door throws mutated a static filter");
        for (const k of PROBE) assert.equal(xb.has(k), xa.has(k), mem + " has(" + k + ") after door throws");
    }
});

test("Quotient: _hash door + load ceiling at N-1, N, N+1 -- throws leave the filter byte-identical", () => {
    for (const seed of SEEDS) {
        const tag = "Quotient/seed=" + seed;
        const qa = mk(A, "Quotient", 16, optsFor(seed)), qb = mk(B, "Quotient", 16, optsFor(seed));
        const N = qb.maxLoad;
        assert.equal(N, qa.maxLoad, tag + " maxLoad");
        assert.ok(Number.isInteger(N) && N > 2, tag + " maxLoad is a finite integer");
        // Key stream: edges first, then a deterministic full-int32 stream.
        const keys = EDGES.slice(); let s = 11 | 0;
        while (keys.length < N + 8) keys.push((s = (Math.imul(s, 1103515245) + 12345) | 0));
        let i = 0;
        for (; qb.size < N - 1; i++) { qa.add(keys[i]); qb.add(keys[i]); }
        assert.equal(qb.size, N - 1, tag + " reached N-1");
        assert.equal(snap(qb), snap(qa), tag + " dump at N-1");
        // _hash door at N-1: bad key throws, byte-identical no-op.
        let before = snap(qb);
        for (const [label, bad] of BAD_KEYS) {
            assert.deepEqual(outcome(() => qb.add(bad)), outcome(() => qa.add(bad)), tag + " add(" + label + ") at N-1");
            assert.deepEqual(outcome(() => qb.remove(bad)), outcome(() => qa.remove(bad)), tag + " remove(" + label + ") at N-1");
            assert.equal(snap(qb), before, tag + " _hash door at N-1 mutated the filter");
        }
        qa.add(keys[i]); qb.add(keys[i]); i++;
        assert.equal(qb.size, N, tag + " reached N");
        assert.equal(snap(qb), snap(qa), tag + " dump at N");
        // N+1 (and beyond): ceiling throw, byte-identical no-op, same message as 1.2.0.
        before = snap(qb);
        for (let j = 0; j < 4; j++, i++) {
            const ra = outcome(() => qa.add(keys[i])), rb = outcome(() => qb.add(keys[i]));
            assert.equal(rb.ok, false, tag + " add at N+" + (j + 1) + " must throw");
            assert.deepEqual(rb, ra, tag + " ceiling throw vs 1.2.0");
            assert.equal(snap(qb), before, tag + " ceiling throw mutated the filter");
        }
        // Bad key at the ceiling: which door wins must match 1.2.0 (the key door, before the ceiling).
        assert.deepEqual(outcome(() => qb.add(NaN)), outcome(() => qa.add(NaN)), tag + " NaN at the ceiling");
        assert.equal(snap(qb), before, tag + " NaN at the ceiling mutated the filter");
        for (const k of keys) assert.equal(qb.has(k), qa.has(k), tag + " has(" + k + ") after ceiling");
        // Remove one -> N-1 -> add succeeds again.
        assert.deepEqual(outcome(() => qb.remove(keys[0])), outcome(() => qa.remove(keys[0])), tag + " remove at N");
        assert.deepEqual(outcome(() => qb.add(keys[0])), outcome(() => qa.add(keys[0])), tag + " re-add after remove");
        assert.equal(snap(qb), snap(qa), tag + " dump after remove + re-add");
    }
});

test("Cuckoo: full-table throw (kick + unwind) and the post-throw rng stream match 1.2.0", () => {
    for (const seed of SEEDS) {
        for (const cap of [1, 8, 64]) {
            const tag = "Cuckoo/cap=" + cap + "/seed=" + seed;
            const ca = mk(A, "Cuckoo", cap, optsFor(seed)), cb = mk(B, "Cuckoo", cap, optsFor(seed));
            const keys = EDGES.slice(); let s = 3 | 0;
            for (let i = 0; i < 4096; i++) keys.push((s = (Math.imul(s, 1103515245) + 12345) | 0));
            let thrown = 0, i = 0;
            for (; i < keys.length && thrown < 3; i++) {
                const pre = snap(cb);
                const ra = outcome(() => ca.add(keys[i])), rb = outcome(() => cb.add(keys[i]));
                assert.deepEqual(rb, ra, tag + " add #" + i + " (" + keys[i] + ") outcome");
                if (!rb.ok) {
                    thrown++;
                    assert.equal(snap(cb), pre, tag + " a thrown add (#" + i + ") must unwind to the exact pre-add state");
                }
                assert.equal(snap(cb), snap(ca), tag + " dump after add #" + i);
            }
            assert.equal(thrown, 3, tag + " table never filled -- the kick/throw path was not exercised");
            // Every placed key still reads true (no fingerprint lost to the failed kick chains).
            for (let j = 0; j < i; j++) assert.equal(cb.has(keys[j]), ca.has(keys[j]), tag + " has(" + keys[j] + ") after throws");
            // Post-throw: free a slot, then add -- the kick rng continues identically.
            for (let j = 0; j < 6; j++) {
                assert.deepEqual(outcome(() => cb.remove(keys[j])), outcome(() => ca.remove(keys[j])), tag + " post-throw remove #" + j);
                const k = (keys[j] ^ 0x5a5a5a5a) | 0;
                assert.deepEqual(outcome(() => cb.add(k)), outcome(() => ca.add(k)), tag + " post-throw add #" + j);
                assert.equal(snap(cb), snap(ca), tag + " dump after post-throw op #" + j);
            }
        }
    }
});

test("XorFilter / BinaryFuse from(): every n in {1, 2, 3} subset of the int edges equals 1.2.0", () => {
    const E = EDGES.slice(0, 11);
    const sets = [];
    for (let a = 0; a < E.length; a++) {
        sets.push([E[a]]);
        sets.push([E[a], E[a]]); // duplicate collapses to n = 1
        for (let b = a + 1; b < E.length; b++) {
            sets.push([E[a], E[b]]);
            for (let c = b + 1; c < E.length; c++) sets.push([E[a], E[b], E[c]]);
        }
    }
    for (const mem of STATIC) {
        for (const seed of [undefined, 0x80000000, 0xffffffff]) {
            for (const fpp of [undefined, 0.0000152587890625]) {
                for (const ks of sets) {
                    const o = optsFor(seed); if (fpp !== undefined) o.fpp = fpp;
                    const tag = mem + "/seed=" + seed + "/fpp=" + fpp + " from([" + ks + "])";
                    const ra = outcome(() => A[mem].from(ks, { ...o })), rb = outcome(() => B[mem].from(ks, { ...o }));
                    assert.equal(rb.ok, ra.ok, tag + " build outcome");
                    if (!rb.ok) { assert.deepEqual(rb, ra, tag); continue; }
                    const xa = ra.v, xb = rb.v;
                    assert.equal(snap(xb), snap(xa), tag + " dump");
                    assert.equal(xb.size, xa.size, tag + " size");
                    for (const k of ks) assert.equal(xb.has(k), true, tag + " no false negative for " + k);
                    for (const k of PROBE) assert.equal(xb.has(k), xa.has(k), tag + " has(" + k + ")");
                }
            }
        }
        // n = 0 (empty) fails closed with the same error.
        assert.deepEqual(outcome(() => B[mem].from([], { keys: "int" })), outcome(() => A[mem].from([], { keys: "int" })), mem + ".from([])");
        // .build alias agrees.
        assert.equal(snap(B[mem].build(EDGES, { keys: "int" })), snap(A[mem].from(EDGES, { keys: "int" })), mem + ".build vs 1.2.0 from");
    }
});

test("dump()/restore(): every member, int + string, equals 1.2.0 bytes; cross-restore both ways", () => {
    const strs = ["", "0", "-0", "-2147483648", "2147483647", "\u0000", "a".repeat(257), "NaN", "undefined"];
    for (const mem of ALL) {
        for (const mode of ["int", "str"]) {
            for (const seed of [undefined, 0, 0x80000000]) {
                const tag = mem + "/" + mode + "/seed=" + seed;
                const keys = mode === "int" ? EDGES : strs;
                const probe = mode === "int" ? PROBE : [...strs, "x", "y", "-1"];
                const o = mode === "int" ? optsFor(seed) : (seed === undefined ? {} : { seed });
                let fa, fb;
                if (STATIC.includes(mem)) { fa = A[mem].from(keys, { ...o }); fb = B[mem].from(keys, { ...o }); }
                else { fa = mk(A, mem, 64, { ...o }); fb = mk(B, mem, 64, { ...o }); for (const k of keys) { fa.add(k); fb.add(k); } }
                const da = fa.dump(), db = fb.dump();
                assert.equal(JSON.stringify(db), JSON.stringify(da), tag + " dump bytes");
                const viaJson = JSON.parse(JSON.stringify(db));
                const restored = [
                    ["B<-B", B[mem].restore(db)], ["B<-A", B[mem].restore(da)], ["A<-B", A[mem].restore(db)],
                    ["B<-json", B[mem].restore(viaJson)], ["B<-clone", B[mem].restore(structuredClone(db))],
                ];
                for (const [how, r] of restored) {
                    assert.equal(snap(r), JSON.stringify(da), tag + " " + how + " re-dump");
                    for (const k of probe) assert.equal(r.has(k), fa.has(k), tag + " " + how + " has(" + String(k).slice(0, 20) + ")");
                }
                // A restored mutable filter keeps evolving identically.
                if (!STATIC.includes(mem)) {
                    const ra = A[mem].restore(da), rb = B[mem].restore(db);
                    const more = mode === "int" ? [-3, 3, P30 + 2, -P30 - 2] : ["m1", "m2"];
                    for (const k of more) { ra.add(k); rb.add(k); }
                    if (DELETABLE.has(mem)) for (const k of keys.slice(0, 3)) assert.deepEqual(outcome(() => rb.remove(k)), outcome(() => ra.remove(k)), tag + " restored remove");
                    assert.equal(snap(rb), snap(ra), tag + " restored filter evolves identically");
                }
            }
        }
    }
});

test("constructor capacity boundaries (0, 1, -0, NaN, null, undefined, 2.5, -1) match 1.2.0", () => {
    for (const mem of MUTABLE) {
        for (const cap of [0, 1, 2, -0, -1, 2.5, NaN, null, undefined, Infinity, "16"]) {
            const ra = outcome(() => snap(new A[mem](cap, { keys: "int" })));
            const rb = outcome(() => snap(new B[mem](cap, { keys: "int" })));
            assert.deepEqual(rb, ra, mem + "(cap=" + String(cap) + ")");
        }
        // capacity 1: N-1 = 0 items, N = 1 item, N+1 = 2 items -- outcomes + dump vs 1.2.0.
        const fa = new A[mem](1, { keys: "int" }), fb = new B[mem](1, { keys: "int" });
        for (const k of [-2147483648, 2147483647, 0]) {
            assert.deepEqual(outcome(() => fb.add(k)), outcome(() => fa.add(k)), mem + "(1).add(" + k + ")");
            assert.equal(snap(fb), snap(fa), mem + "(1) dump after add(" + k + ")");
        }
    }
});

test("re-entrant write: a toString() that add()s into the SAME filter and an int sibling matches 1.2.0", () => {
    // User code runs inside String(key) on the arbitrary path, BEFORE the outer op touches its
    // store or the module `_HG` scratch. It re-enters the SAME outer filter (a nested add) and an
    // int-keyed sibling of the SAME class (whose int path writes `_HG`). Every byte must match 1.2.0.
    for (const mem of MUTABLE) {
        const run = (M) => {
            const outer = new M[mem](256);
            const sib = new M[mem](256, { keys: "int" });
            let depth = 0, c = 0;
            const key = (n) => ({
                toString() {
                    if (depth === 0) {
                        depth++;
                        try { outer.add("nested:" + n); sib.add((EDGES[c % EDGES.length] ^ (c++ << 8)) | 0); sib.has(-P30 - 1); } finally { depth--; }
                    }
                    return "re:" + n;
                },
            });
            const log = [];
            for (let n = 0; n < 60; n++) log.push(outcome(() => outer.add(key(n))));
            for (let n = 0; n < 90; n++) log.push(outer.has(key(n)), outer.has("nested:" + n));
            if (DELETABLE.has(mem)) for (let n = 0; n < 60; n += 4) log.push(outcome(() => outer.remove(key(n))));
            return { log, outer: snap(outer), sib: snap(sib) };
        };
        assert.deepEqual(run(B), run(A), mem + " re-entrant write diverged from 1.2.0");
    }
});

test("adversarial: interleaved ops across ALL classes, two seeds each, through ONE shared call site", () => {
    // The `_HG` scratch is module-global and shared by every class. Drive 14 int filters
    // (7 classes x 2 seeds) one op at a time, round-robin, from one megamorphic call site, so a
    // member that READ a slot it did not WRITE this op (a stale word left by the previous class)
    // diverges from 1.2.0.
    const build = (M) => {
        const fs = [];
        for (const seed of [1, 0x80000000]) {
            for (const mem of MUTABLE) fs.push(new M[mem](128, { keys: "int", seed }));
            for (const mem of STATIC) fs.push(M[mem].from(EDGES, { keys: "int", seed }));
        }
        return fs;
    };
    const fa = build(A), fb = build(B);
    const call = (f, op, k) => outcome(() => f[op](k)); // the one shared site
    let s = 5 | 0;
    for (let step = 0; step < 6000; step++) {
        const idx = step % fa.length;
        const r = (s = (Math.imul(s, 1103515245) + 12345) | 0);
        const k = (step & 3) === 0 ? EDGES[(r >>> 8) % EDGES.length] : r;
        const sel = (r >>> 4) & 3;
        const op = sel === 0 ? "add" : sel === 1 && DELETABLE.has(fb[idx].constructor.name) ? "remove" : "has";
        const opA = (op === "add" || op === "remove") && STATIC.includes(fb[idx].constructor.name) ? "has" : op;
        assert.deepEqual(call(fb[idx], opA, k), call(fa[idx], opA, k), "step " + step + " " + fb[idx].constructor.name + "." + opA + "(" + k + ")");
    }
    for (let i = 0; i < fa.length; i++) assert.equal(snap(fb[i]), snap(fa[i]), fb[i].constructor.name + " #" + i + " final dump");
});

test("H2 shape (ROADMAP 13 SETTLED): per-class _mixInt returns nothing; Quotient#_hash returns nothing", () => {
    // The only check in this file that can FAIL on 1.2.0 (whose behaviour is, by design, identical):
    // the int mixers hand their words over through the module scratch, never as a return value.
    for (const mem of ["Bloom", "CountingBloom", "BlockedBloom", "Cuckoo"]) {
        const f = new B[mem](64, { keys: "int", seed: 0x80000000 });
        assert.equal(typeof f._mixInt, "function", mem + "#_mixInt missing");
        for (const k of EDGES) assert.equal(f._mixInt(k), undefined, mem + "#_mixInt(" + k + ") must return nothing");
    }
    const q = new B.Quotient(64, { keys: "int", seed: 0x80000000 });
    for (const k of EDGES) assert.equal(q._hash(k), undefined, "Quotient#_hash(" + k + ") must return nothing (int)");
    const qs = new B.Quotient(64);
    for (const k of ["", "a", 5, null]) assert.equal(qs._hash(k), undefined, "Quotient#_hash(" + String(k) + ") must return nothing (arbitrary)");
    assert.throws(() => q._hash(2147483648), TypeError, "Quotient#_hash keeps its key door");
});
