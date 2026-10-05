// test/Parity.test.js -- the H2 1.2.1 parity witness (ROADMAP 13).
// The int hot path was rewritten to be Smi-width-proof; this proves the REWRITE is
// behaviour-identical to the frozen 1.2.0 (`test/fixtures/Filter.1.2.0.js`): same
// add/remove/has/getters/dump/restore on every member x {int, string} x 4 seeds.
// The oracle lives in test/parity/parity.mjs (engine-neutral; d8 runs the SAME file
// in SmiWidthD8.test.mjs and must reproduce this digest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runParity } from './parity/parity.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = HERE + 'fixtures/Filter.1.2.0.js';
const UNDER_TEST = HERE + '../Filter.js';

// Pin the frozen fixture: a drifted 1.2.0 reference would silently void the witness.
const FIXTURE_SHA = '76c97aa5e3df71388b1567d2f118f64df57df4ba22065e597e2d0e06d69f530e';
// Pinned by the first green run (fixture vs fixture, Node AND d8 agree).
const PINNED_CHECKS = 3521664;
const PINNED_DIGEST = 3005699213;

test('fixture sha256 is the frozen 1.2.0', () => {
    const sha = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
    assert.equal(sha, FIXTURE_SHA, 'test/fixtures/Filter.1.2.0.js drifted from HEAD:Filter.js at freeze');
});

test('Filter.js is byte-for-byte parity with 1.2.0 (int + string, 4 seeds)', async () => {
    const A = await import(pathToFileURL(FIXTURE).href);
    const B = await import(pathToFileURL(UNDER_TEST).href);
    const r = runParity(A, B);
    assert.equal(r.fails, 0, 'parity differences: ' + r.diffs.join(' ;; '));
    assert.equal(r.checks, PINNED_CHECKS, 'check count drifted (oracle shape changed?)');
    assert.equal(r.digest, PINNED_DIGEST, 'digest drifted (behaviour changed)');
});

test('control: a perturbed seed (s ^ 1) on side B DIVERGES (oracle has teeth)', async () => {
    const A = await import(pathToFileURL(FIXTURE).href);
    const MEM = ['Bloom', 'CountingBloom', 'BlockedBloom', 'Cuckoo', 'Quotient', 'XorFilter', 'BinaryFuse'];
    let diffs = 0;
    for (const mem of MEM) {
        const keys = []; let s = 7 | 0; for (let i = 0; i < 2000; i++) keys.push((s = (Math.imul(s, 1103515245) + 12345) | 0));
        const probe = []; for (let i = 0; i < 4000; i++) probe.push((s = (Math.imul(s, 1103515245) + 12345) | 0));
        let fa, fb;
        if (mem === 'XorFilter' || mem === 'BinaryFuse') {
            fa = A[mem].from(keys, { keys: 'int', seed: 1 });
            fb = A[mem].from(keys, { keys: 'int', seed: 0 }); // 1 ^ 1
        } else {
            fa = new A[mem](4096, { keys: 'int', seed: 1 });
            fb = new A[mem](4096, { keys: 'int', seed: 0 });
            for (const k of keys) { fa.add(k); fb.add(k); }
        }
        for (const k of probe) if (fa.has(k) !== fb.has(k)) diffs++;
    }
    assert.ok(diffs > 0, 'a seed ^ 1 perturbation produced NO divergence -- the oracle is blind');
});

test('re-entrancy: toString() may call another filter.has() -- the _HG scratch is not corrupted', async () => {
    const A = await import(pathToFileURL(FIXTURE).href);
    const B = await import(pathToFileURL(UNDER_TEST).href);
    // THE RULE's re-entrancy invariant (ROADMAP 13): no user code runs between a write to the
    // module `_HG` scratch and its read. The INNER filter is an int-keyed Cuckoo, whose has()
    // DOES write _HG[0..2] in B. The OUTER is arbitrary-keyed, so its _hash runs String(key) --
    // and the user toString() -- BEFORE it writes _HG; a re-entrant inner has() therefore lands
    // outside the forbidden window and cannot clobber the outer word.
    const makeOuter = (M, wrap) => {
        const inner = new M.Cuckoo(1024, { keys: 'int' });   // int-keyed: has() writes _HG[0..2]
        for (let i = 0; i < 200; i++) inner.add(i);
        const outer = new M.Quotient(4096);                   // arbitrary keys -> String(key) runs user code
        if (wrap) {
            // CONTROL (must have teeth): inject the inner has() BETWEEN the outer _hash's _HG
            // write and the caller's read of it -- the forbidden window. This MUST corrupt the
            // derived (quotient, remainder) and change the result.
            const realHash = M.Quotient.prototype._hash;
            outer._hash = function (key) { realHash.call(this, key); inner.has(123); };
        }
        const mk = (n) => ({ toString() { inner.has(n % 200); return 'reentrant:' + n; } });
        for (let i = 0; i < 300; i++) outer.add(mk(i));
        const res = [];
        for (let i = 0; i < 600; i++) res.push(outer.has(mk(i)));
        return res;
    };
    // A re-entrant toString() (user code BEFORE the _HG write) is byte-identical across 1.2.0
    // and the rewrite.
    assert.deepEqual(makeOuter(B, false), makeOuter(A, false), 're-entrant toString() corrupted the hash scratch');
    // Teeth: user code INSIDE the forbidden window (between the _HG write and its read) DOES
    // change the result -- proving the invariant above is load-bearing, not vacuous.
    assert.notDeepEqual(makeOuter(B, true), makeOuter(A, false), 'injecting has() between the _HG write and its read did NOT change the result -- the re-entrancy test is toothless');
});
