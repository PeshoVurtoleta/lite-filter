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
import { Bloom, CountingBloom } from "../../Filter.js";

const CAP = 4096;
const MASK = CAP - 1;

/** The zero-alloc counter: the bit store's byte length, fixed at construction. Its
 *  delta across the whole window must be 0 (the substrate never reallocates). */
function bitsBytes(c) { return c._words.buffer.byteLength; }

/** The CountingBloom equivalent: the packed nibble store's byte length. */
function cntsBytes(c) { return c._cnts.buffer.byteLength; }

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
    scenarios: [addChurn, queryHit, cbfAddChurn, cbfQueryHit, cbfRemoveChurn],
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
