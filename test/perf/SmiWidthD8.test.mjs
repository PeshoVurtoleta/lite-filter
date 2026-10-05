// test/perf/SmiWidthD8.test.mjs -- the 31-bit-Smi no-inline gate (ROADMAP 13, H2).
// Chrome/d8 have pointer compression and 31-bit Smis: a signed int32 outside
// [-2^30, 2^30) still boxes at a non-inlined boundary, so V3 (Node-clean) is still
// RED here (RESEARCH 2.6). Keys are `>> 1` (smi31) so every key is a Smi on d8 and
// the caller never boxes -- every scavenge counted is the LIBRARY's. The probe runs
// as a d8 child process (no runtime dep). FAILS CLOSED when d8 is absent (never skips).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROBE = HERE + 'smi-probe.mjs';
const PARITY = HERE + '../parity/parity.mjs';
const FIXTURE = HERE + '../fixtures/Filter.1.2.0.js';
const FILE = process.env.LF_FILE
    ? (process.env.LF_FILE[0] === '/' ? process.env.LF_FILE : process.cwd() + '/' + process.env.LF_FILE)
    : HERE + '../../Filter.js';
const D8 = process.env.D8 || (homedir() + '/.jsvu/engines/v8/d8');
const N = 200000;
const PINNED_DIGEST = 3005699213; // must equal test/Parity.test.js (same oracle, Node run)

const D8_HINT = 'd8 not found at ' + D8 + '. Install with `npx jsvu --os=<mac64arm|mac64|linux64|win64> --engines=v8` (the gate looks for ~/.jsvu/engines/v8/d8), or set $D8. ' +
    'The 31-bit-Smi lane is mandatory (ROADMAP 13 SETTLED: Smi-width-proof) -- a missing d8 is a FAIL, never a skip.';

test('d8 is present (fail closed, never skip)', () => {
    assert.ok(existsSync(D8), D8_HINT);
});

test('d8 has 31-bit Smis (%IsSmi(2**30) === false)', () => {
    assert.ok(existsSync(D8), D8_HINT);
    const r = spawnSync(D8, ['--allow-natives-syntax', '-e', 'print(%IsSmi(2**30 - 1), %IsSmi(2**30));'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'd8 self-check failed: ' + (r.stderr || ''));
    assert.equal(r.stdout.trim(), 'true false', 'd8 is not a 31-bit-Smi engine; this lane is meaningless');
});

function scav(member, n, noinl, op, mixed) {
    const a = ['--trace-gc', '--min-semi-space-size=4', '--max-semi-space-size=4'];
    if (noinl) a.push('--max-inlined-bytecode-size=0');
    a.push('--module', PROBE, '--', FILE, member, String(n), op || 'mix', 'smi31', mixed ? '1' : '0');
    const r = spawnSync(D8, a, { encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0) throw new Error('d8 probe ' + member + ' exited ' + r.status + ': ' + ((r.stderr || '') + (r.stdout || '')).split('\n').filter(Boolean).slice(-3).join(' | '));
    return (r.stdout.match(/Scavenge|Minor Mark-Sweep/g) || []).length;
}
const grow = (member, noinl, op, mixed) => scav(member, 8 * N, noinl, op, mixed) - scav(member, N, noinl, op, mixed);

const MEMBERS = ['Bloom', 'CountingBloom', 'BlockedBloom', 'Cuckoo', 'Quotient', 'XorFilter', 'BinaryFuse'];

test('nop control is flat (0 -> 0) on d8', { timeout: 120000 }, () => {
    assert.ok(existsSync(D8), D8_HINT);
    assert.equal(grow('nop', false), 0, 'nop inline grew on d8');
    assert.equal(grow('nop', true), 0, 'nop no-inline grew on d8 (caller is boxing -- smi31 keys should prevent it)');
});

test('controls have teeth on d8 (object grows, box grows no-inline)', { timeout: 120000 }, () => {
    assert.ok(existsSync(D8), D8_HINT);
    assert.ok(grow('object', true) >= 3, 'object control did not grow on d8 -- gate is vacuous');
    assert.ok(grow('box', true) >= 3, 'box control did not grow no-inline on d8 -- cannot see a box');
});

for (const m of MEMBERS) {
    test('d8 int hot path zero-alloc: ' + m + ' (inline + no-inline + mixed)', { timeout: 180000 }, () => {
        assert.ok(existsSync(D8), D8_HINT);
        assert.equal(grow(m, false, 'mix', false), 0, m + ' grew inline on d8');
        assert.equal(grow(m, true, 'mix', false), 0, m + ' grew no-inline on d8 (31-bit-Smi box)');
        assert.equal(grow(m, true, 'mix', true), 0, m + ' grew no-inline on d8 with all classes warmed');
    });
}

test('d8 int add is zero-alloc EVERY op (Bloom, BlockedBloom, CountingBloom)', { timeout: 180000 }, () => {
    assert.ok(existsSync(D8), D8_HINT);
    for (const m of ['Bloom', 'BlockedBloom', 'CountingBloom']) {
        assert.equal(grow(m, false, 'add', false), 0, m + ' add grew inline on d8');
        assert.equal(grow(m, true, 'add', false), 0, m + ' add grew no-inline on d8');
    }
});

test('d8 deletable churn + Cuckoo kick are zero-alloc', { timeout: 180000 }, () => {
    assert.ok(existsSync(D8), D8_HINT);
    for (const m of ['CountingBloom', 'Cuckoo', 'Quotient']) assert.equal(grow(m, true, 'churn', false), 0, m + ' churn grew no-inline on d8');
    assert.equal(grow('Cuckoo', true, 'kick', false), 0, 'Cuckoo kick grew no-inline on d8');
});

test('parity runs on d8: 0 fails + digest === Node digest', { timeout: 120000 }, () => {
    assert.ok(existsSync(D8), D8_HINT);
    const r = spawnSync(D8, ['--module', PARITY, '--', FILE, FIXTURE], { encoding: 'utf8', timeout: 180000 });
    assert.equal(r.status, 0, 'd8 parity exited ' + r.status + ': ' + (r.stderr || ''));
    const line = (r.stdout.match(/PARITY .*/) || [''])[0];
    const mFails = line.match(/fails=(\d+)/), mDig = line.match(/digest=(\d+)/);
    assert.ok(mFails && mDig, 'd8 parity produced no PARITY line: ' + r.stdout.slice(0, 200));
    assert.equal(Number(mFails[1]), 0, 'd8 parity fails: ' + r.stdout);
    assert.equal(Number(mDig[1]), PINNED_DIGEST, 'd8 digest != Node digest -- arithmetic depends on the engine');
});
