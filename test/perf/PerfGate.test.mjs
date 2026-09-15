/**
 * @zakkster/lite-filter -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * A node:test-native COMPLEMENT to the torture phase-2 alloc gate. It gates the
 * `keys: 'int'` backing (decisions/0001: STRICT zero-alloc -- the mix never encodes)
 * via scavenge scaling at N and k*N, with the external / old-gen lanes pinned to 0.
 * The default (arbitrary-key) path is honestly AMORTIZED where it String()-encodes
 * and is covered by torture, NOT here.
 *
 * Two scenarios (ROADMAP section 9, point 5 -- add-churn + query-hit), keys:'int':
 *   - add-churn:  churn fresh int keys; every op sets k bits in place.
 *   - query-hit:  a pre-filled filter; every op is an all-bits-set positive.
 * Both are strict zero-alloc: SMI keys (no boxing), an int32-wrapped accumulator
 * (never promoted to a heap double), and the bit store fixed at construction. The
 * `grows` counter reads the store's byte length; its delta across the window MUST be
 * 0 (the counter lane).
 *
 * mustFail: an object-key churn on the DEFAULT backing that String()-encodes one key
 * per op -- it MUST trip the gate, proving the instrument has teeth.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { zgcSuite } from "@zakkster/lite-perf-gate";
import { Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter } from "../../Filter.js";

const CAP = 4096;
const MASK = CAP - 1;

/** The zero-alloc counter: the bit store's byte length, fixed at construction. Its
 *  delta across the whole window must be 0 (the substrate never reallocates). */
function bitsBytes(c) { return c._words.buffer.byteLength; }

/** The CountingBloom equivalent: the packed nibble store's byte length. */
function cntsBytes(c) { return c._cnts.buffer.byteLength; }

/** The Cuckoo equivalent: the fingerprint store's byte length, fixed at construction. */
function storeBytes(c) { return c._store.buffer.byteLength; }

/** The Quotient equivalent: the slot store's byte length, fixed at construction. */
function qfBytes(c) { return c._store.buffer.byteLength; }

/** The XOR equivalent: the fingerprint store's byte length, fixed at build. */
function xfBytes(c) { return c._fp.buffer.byteLength; }

/** add-churn: fresh int keys; every op sets k bits in the fixed store. */
const addChurn = {
    name: "Bloom add-churn (int)",
    setup() {
        const c = new Bloom(CAP, { fpp: 0.01, keys: "int" });
        return { c, k: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) { c.add(k & MASK); k = (k + 1) | 0; }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: bitsBytes(s.c) }; },
};

/** query-hit: a pre-filled filter; every op is an all-bits-set positive (no alloc). */
const queryHit = {
    name: "Bloom query-hit (int)",
    setup() {
        const c = new Bloom(CAP, { fpp: 0.01, keys: "int" });
        for (let i = 0; i < CAP; i++) c.add(i);
        return { c, acc: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (c.mightContain(i & MASK) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: bitsBytes(s.c) }; },
};

/** CountingBloom add-churn: fresh int keys; every op increments k nibbles in place. */
const cbfAddChurn = {
    name: "CountingBloom add-churn (int)",
    setup() {
        const c = new CountingBloom(CAP, { fpp: 0.01, keys: "int" });
        return { c, k: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) { c.add(k & MASK); k = (k + 1) | 0; }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: cntsBytes(s.c) }; },
};

/** CountingBloom query-hit: a pre-filled filter; every op is an all-nonzero positive. */
const cbfQueryHit = {
    name: "CountingBloom query-hit (int)",
    setup() {
        const c = new CountingBloom(CAP, { fpp: 0.01, keys: "int" });
        for (let i = 0; i < CAP; i++) c.add(i);
        return { c, acc: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (c.mightContain(i & MASK) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: cntsBytes(s.c) }; },
};

/** CountingBloom remove-churn: add then remove the same key each op -- the two-pass
 *  remove on the hot path, strictly zero-alloc (nibble decrement, no scratch array). */
const cbfRemoveChurn = {
    name: "CountingBloom remove-churn (int)",
    setup() {
        const c = new CountingBloom(CAP, { fpp: 0.01, keys: "int" });
        for (let i = 0; i < CAP; i++) c.add(i);
        return { c, k: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) { c.add(k & MASK); c.remove(k & MASK); k = (k + 1) | 0; }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: cntsBytes(s.c) }; },
};

/** BlockedBloom add-churn: fresh int keys; every op sets k bits in ONE block of the
 *  fixed store (odd-stride within-block walk, no scratch -- strict zero-alloc). */
const bbAddChurn = {
    name: "BlockedBloom add-churn (int)",
    setup() {
        const c = new BlockedBloom(CAP, { fpp: 0.01, keys: "int" });
        return { c, k: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) { c.add(k & MASK); k = (k + 1) | 0; }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: bitsBytes(s.c) }; },
};

/** BlockedBloom query-hit: a pre-filled filter; every op reads all k block-local bits
 *  set (one cache line, no alloc). */
const bbQueryHit = {
    name: "BlockedBloom query-hit (int)",
    setup() {
        const c = new BlockedBloom(CAP, { fpp: 0.01, keys: "int" });
        for (let i = 0; i < CAP; i++) c.add(i);
        return { c, acc: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (c.mightContain(i & MASK) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: bitsBytes(s.c) }; },
};

/** Cuckoo add-churn: fresh distinct int keys, each a two-bucket b=4 scan (+ occasional
 *  kick, single scalar victim register, no scratch). clear() at the half-load mark keeps
 *  the table under the kick ceiling so no add throws -- both clear() and add() zero-alloc. */
const cfAddChurn = {
    name: "Cuckoo add-churn (int)",
    setup() {
        const c = new Cuckoo(CAP, { fpp: 0.01, keys: "int" });
        return { c, k: 0, limit: c._store.length >> 1 };
    },
    hot(s, n) {
        const c = s.c;
        let k = s.k | 0;
        const lim = s.limit;
        for (let i = 0; i < n; i++) {
            if (c.size >= lim) c.clear();
            c.add(k & 0x3fffffff);
            k = (k + 1) | 0;
        }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: storeBytes(s.c) }; },
};

/** Cuckoo query-hit: a half-loaded filter; every op is a present-fingerprint positive
 *  (two-bucket b=4 scan, no alloc). */
const cfQueryHit = {
    name: "Cuckoo query-hit (int)",
    setup() {
        const c = new Cuckoo(CAP, { fpp: 0.01, keys: "int" });
        const f = c._store.length >> 1;
        for (let i = 0; i < f; i++) c.add(i);
        return { c, acc: 0, mask: f - 1 };
    },
    hot(s, n) {
        const c = s.c;
        let acc = s.acc | 0;
        const m = s.mask;
        for (let i = 0; i < n; i++) acc = (acc + (c.mightContain(i & m) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: storeBytes(s.c) }; },
};

/** Cuckoo remove-churn: add then remove the same key each op -- the two-bucket delete on
 *  the hot path, strictly zero-alloc (slot clear, no scratch); the table stays near-empty
 *  so add never kicks or throws. */
const cfRemoveChurn = {
    name: "Cuckoo remove-churn (int)",
    setup() {
        const c = new Cuckoo(CAP, { fpp: 0.01, keys: "int" });
        return { c, k: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) { c.add(k & MASK); c.remove(k & MASK); k = (k + 1) | 0; }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: storeBytes(s.c) }; },
};

/** Quotient add-churn: fresh distinct int keys, each a linear-probe split + shift.
 *  clear() at the half-load mark keeps occupancy under the ceiling so no add throws --
 *  both clear() and add() zero-alloc on keys:'int'. */
const qfAddChurn = {
    name: "Quotient add-churn (int)",
    setup() {
        const c = new Quotient(CAP, { fpp: 0.01, keys: "int" });
        return { c, k: 0, limit: Math.floor(0.45 * c._nslots) };
    },
    hot(s, n) {
        const c = s.c;
        let k = s.k | 0;
        const lim = s.limit;
        for (let i = 0; i < n; i++) {
            if (c.size >= lim) c.clear();
            c.add(k & 0x3fffffff);
            k = (k + 1) | 0;
        }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: qfBytes(s.c) }; },
};

/** Quotient query-hit: a half-loaded filter; every op is a present-fingerprint positive
 *  (linear-probe run scan, no alloc). */
const qfQueryHit = {
    name: "Quotient query-hit (int)",
    setup() {
        const c = new Quotient(CAP, { fpp: 0.01, keys: "int" });
        const f = Math.floor(0.45 * c._nslots);
        for (let i = 0; i < f; i++) c.add(i);
        return { c, acc: 0, mask: MASK };
    },
    hot(s, n) {
        const c = s.c;
        let acc = s.acc | 0;
        const m = s.mask;
        for (let i = 0; i < n; i++) acc = (acc + (c.mightContain(i & m) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: qfBytes(s.c) }; },
};

/** Quotient remove-churn: add then remove the same key each op -- the shift-back cluster
 *  repair on the hot path, strictly zero-alloc (the cluster scratch is preallocated); the
 *  filter stays near-empty so add never runs off the end or throws. */
const qfRemoveChurn = {
    name: "Quotient remove-churn (int)",
    setup() {
        const c = new Quotient(CAP, { fpp: 0.01, keys: "int" });
        return { c, k: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) { c.add(k & MASK); c.remove(k & MASK); k = (k + 1) | 0; }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: qfBytes(s.c) }; },
};

/** XOR query-hit: a STATIC filter built once from CAP distinct int keys; every op is a
 *  present-key positive (3 hashes + 3 modulo reductions + an XOR-compare, no scratch --
 *  strict zero-alloc). XOR has no add/remove/clear (they throw), so it has only a query
 *  scenario. Build is a cold path (allocation is fine there) done in setup(), outside the
 *  measured window. This is the gated 0-scavenge scenario at N and k*N (decisions/0018). */
const xfQueryHit = {
    name: "Xor query-hit (int)",
    setup() {
        const keys = new Array(CAP);
        for (let i = 0; i < CAP; i++) keys[i] = i;
        const c = XorFilter.from(keys, { fpp: 0.01, keys: "int" });
        return { c, acc: 0 };
    },
    hot(s, n) {
        const c = s.c;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (c.mightContain(i & MASK) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: xfBytes(s.c) }; },
};

/**
 * The teeth: an object-key churn on the default backing that String()-encodes one
 * fresh object key per op -- it MUST trip the gate (scavenges scale with n).
 */
const mustFailAlloc = {
    name: "Bloom object-key churn (MUST allocate)",
    setup() { return { c: new Bloom(CAP, { fpp: 0.01 }) }; },
    hot(s, n) { const c = s.c; for (let i = 0; i < n; i++) c.add({ id: i }); },
    statsOf() { return { grows: 0 }; },
};

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxRetainedKB: 64,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    scenarios: [addChurn, queryHit, cbfAddChurn, cbfQueryHit, cbfRemoveChurn, bbAddChurn, bbQueryHit,
        cfAddChurn, cfQueryHit, cfRemoveChurn, qfAddChurn, qfQueryHit, qfRemoveChurn, xfQueryHit],
    mustFail: [mustFailAlloc],
});

/** A plain cross-check (no measured window): the int hot paths never allocate a
 *  boxed number and clear() reuses the same store. */
test("perf-gate cross-check: clear() reuses the bit store buffer", () => {
    const c = new Bloom(CAP, { fpp: 0.01, keys: "int" });
    const buf = c._words.buffer;
    for (let i = 0; i < CAP; i++) c.add(i);
    c.clear();
    assert.equal(c._words.buffer, buf, "clear() must reuse the same ArrayBuffer");
    assert.equal(c.size, 0);
});

test("perf-gate cross-check: CountingBloom clear() reuses the counter store buffer", () => {
    const c = new CountingBloom(CAP, { fpp: 0.01, keys: "int" });
    const buf = c._cnts.buffer;
    for (let i = 0; i < CAP; i++) c.add(i);
    for (let i = 0; i < CAP; i++) c.remove(i);
    c.clear();
    assert.equal(c._cnts.buffer, buf, "clear() must reuse the same ArrayBuffer");
    assert.equal(c.size, 0);
});

test("perf-gate cross-check: BlockedBloom clear() reuses the bit store buffer", () => {
    const c = new BlockedBloom(CAP, { fpp: 0.01, keys: "int" });
    const buf = c._words.buffer;
    for (let i = 0; i < CAP; i++) c.add(i);
    c.clear();
    assert.equal(c._words.buffer, buf, "clear() must reuse the same ArrayBuffer");
    assert.equal(c.size, 0);
});

test("perf-gate cross-check: Cuckoo clear() reuses the fingerprint store buffer", () => {
    const c = new Cuckoo(CAP, { fpp: 0.01, keys: "int" });
    const buf = c._store.buffer;
    const half = c._store.length >> 1;
    for (let i = 0; i < half; i++) c.add(i);
    c.clear();
    assert.equal(c._store.buffer, buf, "clear() must reuse the same ArrayBuffer");
    assert.equal(c.size, 0);
});

test("perf-gate cross-check: Quotient clear() reuses the slot store buffer", () => {
    const c = new Quotient(CAP, { fpp: 0.01, keys: "int" });
    const buf = c._store.buffer;
    const half = Math.floor(0.45 * c._nslots);
    for (let i = 0; i < half; i++) c.add(i);
    c.clear();
    assert.equal(c._store.buffer, buf, "clear() must reuse the same ArrayBuffer");
    assert.equal(c.size, 0);
});
