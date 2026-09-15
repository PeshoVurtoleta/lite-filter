/**
 * @zakkster/lite-filter -- node:test boundary suite: the family-wide option door
 * matrix (A1), the string-edge scale/ceiling proof (A2, decisions/0023), and the
 * litefilter/2 rejection contract (A3, the reviewer's QA note 1).
 *
 * Every existing per-member suite already exercises ITS OWN construction door with
 * ONE typo shape (`keys:'ints'`, `stats:1`). This file instead sweeps EVERY entry
 * point -- all 5 mutable constructors, both static `.from`/`.build` pairs, and all
 * 7 `restore(snap, opts)` doors -- against the SAME typo/boundary matrix, so a door
 * regression on any one member cannot slip through unexercised.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter, BinaryFuse,
} from "../Filter.js";
import { measure } from "../benchmark/Bench.mjs";

/* ============================================================================
 * A1. Option doors, family-wide.
 * ========================================================================== */

// Every mutable-member construction entry point: (name, build(opts)).
const MUTABLE_ENTRY_POINTS = [
    ["Bloom", (opts) => new Bloom(16, opts)],
    ["CountingBloom", (opts) => new CountingBloom(16, opts)],
    ["BlockedBloom", (opts) => new BlockedBloom(16, opts)],
    ["Cuckoo", (opts) => new Cuckoo(16, opts)],
    ["Quotient", (opts) => new Quotient(16, opts)],
];

// Every static-member factory entry point, both `from` and the `.build` alias.
const STATIC_ENTRY_POINTS = [
    ["XorFilter.from", (opts) => XorFilter.from([1, 2, 3], opts)],
    ["XorFilter.build", (opts) => XorFilter.build([1, 2, 3], opts)],
    ["BinaryFuse.from", (opts) => BinaryFuse.from([1, 2, 3], opts)],
    ["BinaryFuse.build", (opts) => BinaryFuse.build([1, 2, 3], opts)],
];

const ALL_CONSTRUCT_ENTRY_POINTS = [...MUTABLE_ENTRY_POINTS, ...STATIC_ENTRY_POINTS];

// Every `restore(snap, opts)` door: (name, freshSnap()).
const RESTORE_ENTRY_POINTS = [
    ["Bloom", Bloom, () => new Bloom(16).dump()],
    ["CountingBloom", CountingBloom, () => new CountingBloom(16).dump()],
    ["BlockedBloom", BlockedBloom, () => new BlockedBloom(16).dump()],
    ["Cuckoo", Cuckoo, () => new Cuckoo(16).dump()],
    ["Quotient", Quotient, () => new Quotient(16).dump()],
    ["XorFilter", XorFilter, () => XorFilter.from([1, 2, 3], { keys: "int" }).dump()],
    ["BinaryFuse", BinaryFuse, () => BinaryFuse.from([1, 2, 3], { keys: "int" }).dump()],
];

test("A1: every construction entry point rejects an unknown option key with a did-you-mean hint", () => {
    for (const [name, build] of ALL_CONSTRUCT_ENTRY_POINTS) {
        assert.throws(() => build({ fppp: 0.01 }), /unknown option/, name + " {fppp} must fail closed");
        assert.throws(() => build({ fppp: 0.01 }), /fpp/, name + " {fppp} must suggest fpp");
        assert.throws(() => build({ sead: 1 }), /unknown option/, name + " {sead} must fail closed");
        assert.throws(() => build({ sead: 1 }), /seed/, name + " {sead} must suggest seed");
        assert.throws(() => build({ statz: true }), /unknown option/, name + " {statz} must fail closed");
        assert.throws(() => build({ statz: true }), /stats/, name + " {statz} must suggest stats");
    }
});

test("A1: every construction entry point accepts an all-known-keys options bag", () => {
    for (const [name, build] of ALL_CONSTRUCT_ENTRY_POINTS) {
        const f = build({ fpp: 0.01, seed: 1, keys: "int", stats: true });
        assert.ok(f, name + " must construct with a fully-known options bag");
    }
});

test("A1: every construction entry point rejects a non-object options bag (null / 42 / 'garbage') and accepts undefined", () => {
    for (const [name, build] of ALL_CONSTRUCT_ENTRY_POINTS) {
        assert.throws(() => build(null), /options must be an object/, name + " options=null");
        assert.throws(() => build(42), /options must be an object/, name + " options=42");
        assert.throws(() => build("garbage"), /options must be an object/, name + " options='garbage'");
        assert.doesNotThrow(() => build(undefined), name + " options=undefined must be fine");
    }
});

test("A1: every restore(snap, opts) door rejects {statz:true} with a did-you-mean 'stats' hint", () => {
    for (const [name, Ctor, freshSnap] of RESTORE_ENTRY_POINTS) {
        const snap = freshSnap();
        assert.throws(() => Ctor.restore(snap, { statz: true }), /unknown option/, name + ".restore {statz}");
        assert.throws(() => Ctor.restore(snap, { statz: true }), /stats/, name + ".restore {statz} must suggest stats");
    }
});

test("A1: every restore(snap, opts) door rejects {keys:'int'} -- undocumented per Filter.d.ts FilterRestoreOptions", () => {
    // FilterRestoreOptions = { stats? } (Filter.d.ts): `keys` is a CONSTRUCTION-time
    // option, not a restore one -- restore() re-derives it FROM the snapshot itself, so
    // accepting `keys` here would silently ignore a caller's (wrong) assumption.
    for (const [name, Ctor, freshSnap] of RESTORE_ENTRY_POINTS) {
        const snap = freshSnap();
        assert.throws(() => Ctor.restore(snap, { keys: "int" }), /unknown option/, name + ".restore {keys} must be rejected");
    }
});

test("A1: every restore(snap, { stats: true }) door works and stats() is live", () => {
    for (const [name, Ctor, freshSnap] of RESTORE_ENTRY_POINTS) {
        const snap = freshSnap();
        const g = Ctor.restore(snap, { stats: true });
        assert.equal(typeof g.stats().queries, "number", name + " restored stats() must be a live counter holder");
        g.mightContain(1);
        assert.equal(g.stats().queries, 1, name + " restored stats must actually count a query");
    }
});

test("A1 extra: every construction-door and restore-door error message carries the [lite-filter] tag", () => {
    for (const [name, build] of ALL_CONSTRUCT_ENTRY_POINTS) {
        let msg = "";
        try { build({ fppp: 1 }); } catch (e) { msg = e.message; }
        assert.match(msg, /^\[lite-filter\]/, name + " unknown-option message must carry the tag");
    }
    for (const [name, Ctor, freshSnap] of RESTORE_ENTRY_POINTS) {
        let msg = "";
        try { Ctor.restore(freshSnap(), { statz: true }); } catch (e) { msg = e.message; }
        assert.match(msg, /^\[lite-filter\]/, name + ".restore message must carry the tag");
    }
});

/* --- nearestOpt quality (indirect: only reachable through the thrown message) --- */

test("A1 extra: nearestOpt is case-insensitive (an exact-but-miscased key resolves directly)", () => {
    // "SEED"/"STATS" case-insensitively equal a known key exactly; the suggestion must
    // name that key, not fall through to a shorter/weaker prefix guess.
    assert.throws(() => new Bloom(16, { SEED: 1 }), /did you mean seed\?/);
    assert.throws(() => new Bloom(16, { Stats: true }), /did you mean stats\?/);
    assert.throws(() => new Bloom(16, { FPP: 0.01 }), /did you mean fpp\?/);
});

test("A1 extra: nearestOpt falls back to the longest shared-prefix known key for a partial typo", () => {
    assert.throws(() => new Bloom(16, { fp: 0.01 }), /did you mean fpp\?/);
    assert.throws(() => new Bloom(16, { se: 1 }), /did you mean seed\?/);
    assert.throws(() => new Bloom(16, { st: true }), /did you mean stats\?/);
});

test("A1 extra: nearestOpt lists every known option for a typo sharing no prefix with any of them", () => {
    assert.throws(() => new Bloom(16, { zzzzz: 1 }), /did you mean fpp, seed, keys, stats\?/);
});

/* ============================================================================
 * A2. String static scale (decisions/0023): the old single-hash birthday
 * ceiling ("empirically hit a ceiling around ~250k distinct strings") is GONE.
 * A set of DISTINCT strings peels at any size; only a genuinely degenerate
 * (identical String()-encoding) set still throws, now truthfully diagnosed.
 * ========================================================================== */

function distinctStrings(n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = "torture-key-" + i + "-string-edge";
    return out;
}

test("A2: XorFilter.from builds 300000 DISTINCT strings fast, with 0 false negatives on full readback", () => {
    const keys = distinctStrings(300000);
    const t0 = performance.now();
    const f = XorFilter.from(keys);
    const ms = performance.now() - t0;
    assert.ok(ms < 5000, "XorFilter.from(300k strings) took " + ms.toFixed(1) + "ms, required < 5000ms");
    let fn = 0;
    for (const k of keys) if (!f.mightContain(k)) fn++;
    assert.equal(fn, 0, "0 false negatives required on a full readback");
});

test("A2: BinaryFuse.from builds 300000 DISTINCT strings fast, with 0 false negatives on full readback", () => {
    const keys = distinctStrings(300000);
    const t0 = performance.now();
    const f = BinaryFuse.from(keys);
    const ms = performance.now() - t0;
    assert.ok(ms < 5000, "BinaryFuse.from(300k strings) took " + ms.toFixed(1) + "ms, required < 5000ms");
    let fn = 0;
    for (const k of keys) if (!f.mightContain(k)) fn++;
    assert.equal(fn, 0, "0 false negatives required on a full readback");
});

test("A2: a degenerate identical-String()-encoding set (e.g. [{},{},{}]) still throws the reseed-exhaustion error", () => {
    // Three distinct plain objects all String()-encode to "[object Object]": a genuine
    // duplicate hypergraph edge no reseed can separate, independent of key COUNT.
    const degenerate = [{}, {}, {}];
    assert.throws(() => XorFilter.from(degenerate), /\[lite-filter\].*could not construct/);
    assert.throws(() => BinaryFuse.from(degenerate), /\[lite-filter\].*could not construct/);
});

test("A2: the exhaustion message names the TRUE cause (encoding collision) -- the old size-based ceiling is gone", () => {
    let xorMsg = "", bfMsg = "";
    try { XorFilter.from([{}, {}, {}]); } catch (e) { xorMsg = e.message; }
    try { BinaryFuse.from([{}, {}, {}]); } catch (e) { bfMsg = e.message; }
    // decisions/0023's truthful rewording: with a second independent string hash, a set
    // of DISTINCT keys "peels at any size" -- so exhaustion is ONLY ever a "DEGENERATE
    // set" of colliding String() encodings, never a legitimate large-but-distinct set.
    assert.match(xorMsg, /peels at any size/, "XorFilter must carry the post-0023 truthful diagnosis");
    assert.match(xorMsg, /DEGENERATE set/, "XorFilter must name the true cause");
    assert.match(bfMsg, /peels at any size/, "BinaryFuse must carry the post-0023 truthful diagnosis");
    assert.match(bfMsg, /DEGENERATE set/, "BinaryFuse must name the true cause");
});

/* ============================================================================
 * A3. litefilter/2 rejection (reviewer QA note 1): a snap.f = "litefilter/2" on
 * a FRESH dump must be rejected with a format-tag message carrying migration
 * guidance, for at least one mutable member (Bloom) plus BOTH static members.
 * ========================================================================== */

test("A3: Bloom.restore rejects a litefilter/2 snapshot (format tag + migration guidance)", () => {
    const snap = new Bloom(16).dump();
    assert.equal(snap.f, "litefilter/3", "sanity: the current tag is litefilter/3");
    snap.f = "litefilter/2";
    assert.throws(() => Bloom.restore(snap), /\[lite-filter\].*format tag/);
    let msg = "";
    try { Bloom.restore(snap); } catch (e) { msg = e.message; }
    assert.match(msg, /litefilter\/2 or earlier/, "must name the rejected prior tag");
    assert.match(msg, /re-dump\(\)/, "must carry migration guidance (re-dump the source filter)");
});

test("A3: XorFilter.restore rejects a litefilter/2 snapshot (format tag + migration guidance)", () => {
    const snap = XorFilter.from([1, 2, 3], { keys: "int" }).dump();
    assert.equal(snap.f, "litefilter/3", "sanity: the current tag is litefilter/3");
    snap.f = "litefilter/2";
    assert.throws(() => XorFilter.restore(snap), /\[lite-filter\].*format tag/);
    let msg = "";
    try { XorFilter.restore(snap); } catch (e) { msg = e.message; }
    assert.match(msg, /litefilter\/2 or earlier/, "must name the rejected prior tag");
    assert.match(msg, /re-dump\(\)/, "must carry migration guidance");
});

test("A3: BinaryFuse.restore rejects a litefilter/2 snapshot (format tag + migration guidance)", () => {
    const snap = BinaryFuse.from([1, 2, 3], { keys: "int" }).dump();
    assert.equal(snap.f, "litefilter/3", "sanity: the current tag is litefilter/3");
    snap.f = "litefilter/2";
    assert.throws(() => BinaryFuse.restore(snap), /\[lite-filter\].*format tag/);
    let msg = "";
    try { BinaryFuse.restore(snap); } catch (e) { msg = e.message; }
    assert.match(msg, /litefilter\/2 or earlier/, "must name the rejected prior tag");
    assert.match(msg, /re-dump\(\)/, "must carry migration guidance");
});

/* ============================================================================
 * A4. Bench.mjs false-negative gate (cheap subset only): `measure()` must THROW
 * the moment a filter reports a false negative, rather than silently reporting a
 * row. We cannot inject a false negative through the public surface (`measure`
 * builds its own filter internally and there is no seam to hand it a corrupt
 * one), so we prove the throw path the cheap, deterministic way: monkeypatch
 * `Bloom.prototype.mightContain` (the exact call `measure` makes) to always
 * report false, run one tiny (cap=2) workload, and restore the prototype in a
 * `finally`. This is a same-process, zero-I/O, sub-millisecond check -- safe to
 * run inline rather than shelling out to the full CLI (which IS covered by the
 * mandatory `node benchmark/Bench.mjs` gate run separately).
 * ========================================================================== */

test("A4: Bench.mjs measure() throws on an injected false negative instead of reporting a row", () => {
    const original = Bloom.prototype.mightContain;
    Bloom.prototype.mightContain = function () { return false; };
    try {
        assert.throws(
            () => measure("A4-injected", (n, probes, seed) => {
                const keys = [1, 2];
                const p = new Array(probes);
                for (let i = 0; i < probes; i++) p[i] = -1 - i;
                return { keys, probes: p };
            }, 2, 0.01, 1),
            /FALSE NEGATIVE/,
            "measure() must throw the one-sided-guarantee message, never a silent row"
        );
    } finally {
        Bloom.prototype.mightContain = original;
    }
});
