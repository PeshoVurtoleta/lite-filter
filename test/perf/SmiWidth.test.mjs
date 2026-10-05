// test/perf/SmiWidth.test.mjs -- the Node 32-bit-Smi no-inline gate (ROADMAP 13, H2).
// The H1 perf gate measured with inlining ON, so it never saw the no-inline boxing
// (RESEARCH 2.2). This lane spawns the probe under --max-inlined-bytecode-size=0 AND
// inline, full int32 keys (hashes uniform over 32 bits -> half are >= 2^31, not Smis
// on this build), and asserts 8x the work adds NO scavenges (s(200k) === s(1.6M)).
// FAILS on test/fixtures/Filter.1.2.0.js (set LF_FILE); revert-check before /release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROBE = HERE + 'smi-probe.mjs';
const FILE = process.env.LF_FILE
    ? (process.env.LF_FILE[0] === '/' ? process.env.LF_FILE : process.cwd() + '/' + process.env.LF_FILE)
    : HERE + '../../Filter.js';
const N = 200000;

// A pointer-compressed Node build has 31-bit Smis: the full-int32 lane would conflate
// caller boxing with library boxing. Fail closed with the reason (suite law: no skip).
const PC = process.config && process.config.variables && process.config.variables.v8_enable_pointer_compression;
test('Node build has 32-bit Smis (no pointer compression)', () => {
    assert.equal(PC, 0, 'pointer-compressed Node build (31-bit Smis): run the d8 lane instead; this Node lane is meaningless here');
});

function scav(member, n, noinl, op, ks, mixed) {
    const a = ['--trace-gc', '--min-semi-space-size=4', '--max-semi-space-size=4'];
    if (noinl) a.push('--max-inlined-bytecode-size=0');
    a.push(PROBE, FILE, member, String(n), op || 'mix', ks || 'full', mixed ? '1' : '0');
    const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0) throw new Error('probe ' + member + ' exited ' + r.status + ': ' + ((r.stderr || '') + (r.stdout || '')).split('\n').filter(Boolean).slice(-3).join(' | '));
    return (r.stdout.match(/Scavenge|Minor Mark-Sweep/g) || []).length;
}
// grow = extra scavenges when the SAME loop runs 8x longer. 0 == zero-alloc steady state.
const grow = (member, noinl, op, ks, mixed) => scav(member, 8 * N, noinl, op, ks, mixed) - scav(member, N, noinl, op, ks, mixed);

const MEMBERS = ['Bloom', 'CountingBloom', 'BlockedBloom', 'Cuckoo', 'Quotient', 'XorFilter', 'BinaryFuse'];

test('nop control is flat (0 -> 0) on both lanes', { timeout: 120000 }, () => {
    assert.equal(grow('nop', false), 0, 'nop inline grew');
    assert.equal(grow('nop', true), 0, 'nop no-inline grew');
});

test('controls have teeth (object grows both lanes, box grows no-inline)', { timeout: 120000 }, () => {
    assert.ok(grow('object', false) >= 3, 'object control did not grow inline -- gate is vacuous');
    assert.ok(grow('object', true) >= 3, 'object control did not grow no-inline -- gate is vacuous');
    assert.ok(grow('box', true) >= 3, 'box control did not grow no-inline -- the gate cannot see a box');
});

for (const m of MEMBERS) {
    test('int hot path zero-alloc: ' + m + ' (inline + no-inline, mixed warm)', { timeout: 180000 }, () => {
        assert.equal(grow(m, false, 'mix', 'full', false), 0, m + ' grew inline (full-range int keys)');
        assert.equal(grow(m, true, 'mix', 'full', false), 0, m + ' grew no-inline (full-range int keys)');
        // Shared module helpers must not box when all 7 maps are warm in one process.
        assert.equal(grow(m, true, 'mix', 'full', true), 0, m + ' grew no-inline with all classes warmed (megamorphic helper box)');
    });
}

test('int add is zero-alloc EVERY op (Bloom, BlockedBloom, CountingBloom)', { timeout: 180000 }, () => {
    // The `mix` lane's `if (!has) add` stops adding after 4096 distinct keys, so add() is never
    // in the measured window; this lane calls add() on every op (bits/counters just re-set).
    for (const m of ['Bloom', 'BlockedBloom', 'CountingBloom']) {
        assert.equal(grow(m, false, 'add', 'full', false), 0, m + ' add grew inline');
        assert.equal(grow(m, true, 'add', 'full', false), 0, m + ' add grew no-inline');
    }
});

test('deletable churn is zero-alloc (CountingBloom, Cuckoo, Quotient)', { timeout: 180000 }, () => {
    for (const m of ['CountingBloom', 'Cuckoo', 'Quotient']) {
        assert.equal(grow(m, true, 'churn', 'full', false), 0, m + ' churn grew no-inline');
    }
});

test('Cuckoo kick path (~0.93 of maxLoad, sliding window) is zero-alloc', { timeout: 120000 }, () => {
    assert.equal(grow('Cuckoo', true, 'kick', 'full', false), 0, 'Cuckoo kick grew no-inline');
});
