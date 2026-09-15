// @zakkster/lite-filter -- demo assertions (repo-only).
//
//   node --test demo/Demo.test.mjs               (green)
//   node --expose-gc --test demo/Demo.test.mjs   (adds the heap-bound checks)
//
// Dev-only: NOT part of the shipped test/ suite that `npm test` runs (demo/ never
// ships). Proves the demo cannot lie -- every member is drawn strictly from dump(),
// the one-sided FN=0 guarantee holds, runs are deterministic, the hot path allocates
// nothing, and the shipped surface (Filter.js) is never written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { uniform, zipfian, sequential, adversarial } from '../benchmark/Bench.mjs';
import { XorFilter, BinaryFuse } from '../Filter.js';
import {
    createEngine, step, runToEnd, frameModel, summary, renderSummary, memBits,
    MEMBER_NAMES, MEMBER_DEFS, MUTABLE_COUNT, PHASE_BUILD, PHASE_PROBE,
    fetchWorkload, WORKLOAD_SERVER_HINT,
} from './Visualize.mjs';
import { RENDERERS, RENDERED_MEMBERS, BASE_FIELDS, drawPeel, PEEL_MEMBERS } from './renderers.mjs';
import { serveWorkload, handle, DEFAULT_PORT } from './serve.mjs';
import {
    derivePeel, frameModel as peelFrameModel, peelCore, shippedFp,
    GEOM_XOR, GEOM_BF, demoKeys, PEEL_N, PEEL_SEED, PEEL_FPP,
} from './peel.mjs';

// Dev-only peers (already devDependencies of this package -- the torture-harness
// skill's own tools). Used ONLY by the gated assertion-4c/5c tests below; both skip
// cleanly (t.skip, never a vacuous pass) when the process is not run with --expose-gc.
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker, createOwnerCascadeOrphanKernel } from '@zakkster/lite-leak';
import { createRoot, effect, dispose } from '@zakkster/lite-signal';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(DEMO_DIR);
const FILTER_JS = join(REPO_ROOT, 'Filter.js');

const GEN = { uniform, zipfian, sequential, adversarial };

/** Build a spec straight from a Bench.mjs generator (the shipped workload source). */
function makeSpec(kind, n, probes, seed, fpp) {
    const w = GEN[kind](n, probes, seed);
    return { keys: w.keys, probes: w.probes, fpp: fpp === undefined ? 0.01 : fpp, seed, kind, n };
}

/* ------------------------------- structure -------------------------------- */

test('every engine member has a renderer (no member silently unrendered), 7 members', () => {
    assert.deepEqual([...MEMBER_NAMES].sort(), [...RENDERED_MEMBERS].sort());
    assert.equal(MEMBER_NAMES.length, 7);
    assert.equal(MEMBER_DEFS.length, 7);
    assert.equal(MUTABLE_COUNT, 5);
    // The dump mem tags are exactly these (note: "Xor", not "XorFilter").
    assert.deepEqual([...MEMBER_NAMES],
        ['Bloom', 'CountingBloom', 'BlockedBloom', 'Cuckoo', 'Quotient', 'Xor', 'BinaryFuse']);
});

test('MEMBER_NAMES is frozen', () => {
    assert.ok(Object.isFrozen(MEMBER_NAMES));
});

/* ---------------------------- assertion 1 --------------------------------- */

test('assertion 1: Object.keys(model(dump())) === fields AND model === dump, all 7, over >= 2000 ops', () => {
    // sequential guarantees n distinct keys, so the add-set is exactly n.
    const spec = makeSpec('sequential', 2500, 3000, 5);
    const engine = createEngine(spec);
    assert.ok(engine.addKeys.length >= 2000, 'add-set must be >= 2000 distinct, got ' + engine.addKeys.length);

    const checkpoints = new Set([600, 1500, 2500, 4000]);
    let steps = 0;
    while (step(engine)) {
        steps++;
        if (checkpoints.has(steps)) {
            const frame = frameModel(engine);
            for (let i = 0; i < MEMBER_NAMES.length; i++) {
                const name = MEMBER_NAMES[i];
                const snap = frame.members[name];
                const r = RENDERERS[name];
                const model = r.model(snap);
                assert.deepStrictEqual(Object.keys(model), r.fields, name + ' Object.keys(model) must equal declared fields (order included)');
                assert.deepStrictEqual(model, snap, name + ' model must deep-equal its own dump() snapshot (0 shadow fields)');
            }
        }
    }
    assert.ok(steps >= 2000, 'exercised >= 2000 ops, got ' + steps);
});

test('assertion 1b: a renderer that drops or invents a field fails the deep-equal', () => {
    const spec = makeSpec('uniform', 300, 400, 7);
    const engine = createEngine(spec);
    runToEnd(engine);
    const snap = engine.all[0].dump(); // Bloom
    const good = RENDERERS.Bloom.model(snap);
    assert.deepStrictEqual(good, snap);
    const dropped = { ...good }; delete dropped.bits;
    assert.notDeepStrictEqual(dropped, snap);
    const invented = { ...good, shadow: 123 };
    assert.notDeepStrictEqual(invented, snap);
});

test('teeth: dropping or inventing ANY field fails deep-equal for all 7 members', () => {
    const spec = makeSpec('uniform', 800, 1000, 0x77);
    const engine = createEngine(spec);
    runToEnd(engine);
    const frame = frameModel(engine);
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        const snap = frame.members[name];
        const r = RENDERERS[name];
        const good = r.model(snap);
        assert.deepStrictEqual(good, snap, name + ' baseline model must match');
        for (let j = 0; j < r.fields.length; j++) {
            const broken = { ...good };
            delete broken[r.fields[j]];
            assert.notDeepStrictEqual(broken, snap, name + ': dropping "' + r.fields[j] + '" must fail');
        }
        // Every declared field set is a superset of the shared base.
        for (let b = 0; b < BASE_FIELDS.length; b++) {
            assert.ok(r.fields.includes(BASE_FIELDS[b]), name + ' fields must include base field ' + BASE_FIELDS[b]);
        }
        const invented = { ...good, __shadow: 'nope' };
        assert.notDeepStrictEqual(invented, snap, name + ': inventing a field must fail');
    }
});

test('all four workloads exercise assertion 1 for all 7 members', () => {
    const n = 1500;
    for (const kind of ['uniform', 'zipfian', 'sequential', 'adversarial']) {
        const engine = createEngine(makeSpec(kind, n, 2000, 0x1a));
        runToEnd(engine);
        const frame = frameModel(engine);
        for (let i = 0; i < MEMBER_NAMES.length; i++) {
            const name = MEMBER_NAMES[i];
            const snap = frame.members[name];
            const model = RENDERERS[name].model(snap);
            assert.deepStrictEqual(model, snap, kind + ': ' + name + ' model != dump()');
        }
    }
});

/* ---------------------------- assertion 2 --------------------------------- */

test('assertion 2: FN === 0 over all n>=2000 added keys, re-probed each frame, all 7', () => {
    const spec = makeSpec('sequential', 2500, 3000, 11);
    const engine = createEngine(spec);
    const n = engine.addKeys.length;
    assert.ok(n >= 2000, 'non-vacuous: >= 2000 keys re-probed, got ' + n);

    // The one-sided guarantee is over keys that HAVE been added. The two static members
    // are built from the whole set at construction, so their FN over the FULL add-set is
    // 0 even DURING the BUILD phase; assert that up front.
    const early = summary(engine);
    assert.equal(early.find((r) => r.name === 'Xor').fn, 0, 'static Xor FN must be 0 even during BUILD');
    assert.equal(early.find((r) => r.name === 'BinaryFuse').fn, 0, 'static BinaryFuse FN must be 0 even during BUILD');

    // Drain BUILD so the full add-set is present in every member, then re-probe every one
    // of the n added keys against every member at several PROBE-phase frames.
    while (engine.cur[2] === PHASE_BUILD) step(engine);
    let checked = 0;
    let probeSteps = 0;
    do {
        if (probeSteps === 0 || probeSteps === 400 || probeSteps === 1200) {
            const rows = summary(engine);
            assert.equal(rows.length, 7);
            for (let i = 0; i < rows.length; i++) {
                assert.equal(rows[i].fn, 0, rows[i].name + ' had ' + rows[i].fn + ' false negatives (n=' + n + ' re-probed)');
            }
            checked++;
        }
        probeSteps++;
    } while (step(engine));
    assert.ok(checked >= 2, 'must have re-probed all added keys at >= 2 frames, got ' + checked);
});

/* ---------------------------- assertion 3 --------------------------------- */

test('assertion 3: two engines from the same seed produce deep-equal summaries (determinism)', () => {
    const specA = makeSpec('zipfian', 1800, 2200, 42);
    const specB = makeSpec('zipfian', 1800, 2200, 42);
    assert.deepStrictEqual(specA.keys, specB.keys, 'same seed must build the same add-set');
    assert.deepStrictEqual(specA.probes, specB.probes, 'same seed must build the same probe-set');

    const a = createEngine(specA);
    const b = createEngine(specB);
    runToEnd(a);
    runToEnd(b);
    assert.deepStrictEqual(summary(a), summary(b), 'summaries diverged for identical seeds');

    // Frame sequences match in lockstep too.
    const a2 = createEngine(makeSpec('zipfian', 1800, 2200, 42));
    const b2 = createEngine(makeSpec('zipfian', 1800, 2200, 42));
    const cps = new Set([1, 500, 1800, 3000]);
    let n = 0, okA = true, okB = true;
    while (okA || okB) {
        okA = step(a2); okB = step(b2); n++;
        assert.equal(okA, okB, 'engines diverged in length at step ' + n);
        if (!okA) break;
        if (cps.has(n)) {
            const fa = frameModel(a2), fb = frameModel(b2);
            for (let i = 0; i < MEMBER_NAMES.length; i++) {
                assert.deepStrictEqual(fa.members[MEMBER_NAMES[i]], fb.members[MEMBER_NAMES[i]], MEMBER_NAMES[i] + ' frame diverged at step ' + n);
            }
        }
    }
});

test('assertion 3b: the ONLY randomness in the engine/summary path is the seeded makePrng', () => {
    // Non-vacuous: prove the scan actually inspects nonempty source text and that the
    // known-good seeded generator call sites (makePrng) are present, so a scan that
    // matched nothing (e.g. an empty read) could not spuriously pass.
    const NO_RANDOM = /Math\.random|Date\.now\(\)/;
    const engineFiles = ['Visualize.mjs', 'renderers.mjs', 'serve.mjs'];
    for (const f of engineFiles) {
        const src = readFileSync(join(DEMO_DIR, f), 'utf8');
        assert.ok(src.length > 100, f + ' must be nonempty (scan would be vacuous)');
        assert.ok(!NO_RANDOM.test(src), f + ' must not call Math.random or Date.now');
    }
    // The workload generators the engine actually consumes must themselves be
    // seed-only (Bench.mjs's `measure`/`runBench` timing helpers use performance.now,
    // but those are NOT on the engine/summary path -- only the four generators are).
    const benchSrc = readFileSync(join(DEMO_DIR, '..', 'benchmark', 'Bench.mjs'), 'utf8');
    assert.ok(/function makePrng/.test(benchSrc), 'makePrng must exist (scan setup sanity)');
    for (const kind of ['uniform', 'zipfian', 'sequential', 'adversarial']) {
        const re = new RegExp('export function ' + kind + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}\\n');
        const m = benchSrc.match(re);
        assert.ok(m, kind + ' generator body must be found (scan setup sanity)');
        const body = m[1];
        assert.ok(!NO_RANDOM.test(body), kind + ' generator must not call Math.random or Date.now');
        assert.ok(!/performance\.now/.test(body), kind + ' generator must not read wall-clock time');
    }
});

/* ---------------------------- assertion 4 --------------------------------- */

test('assertion 4: 10k probe step()s reuse instances and grow no store (zero-alloc hot path)', () => {
    const spec = makeSpec('uniform', 2000, 12000, 9);
    const engine = createEngine(spec);
    assert.ok(engine.probeKeys.length >= 10000, 'need >= 10k probes to measure, got ' + engine.probeKeys.length);

    // Drain the BUILD phase so the measured window is PURE probes.
    while (engine.cur[2] === PHASE_BUILD) step(engine);
    assert.equal(engine.cur[2], PHASE_PROBE);

    // Snapshot instance identity + serialized store length (dump-driven) before the run.
    const refs = [], storeLen = [];
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        refs[i] = engine.all[i];
        const d = engine.all[i].dump();
        storeLen[i] = (d.bits || d.cnts || d.fp || d.store).length;
    }

    let heapBefore = 0;
    if (typeof global.gc === 'function') { global.gc(); heapBefore = process.memoryUsage().heapUsed; }

    let probeSteps = 0;
    while (probeSteps < 10000 && step(engine)) probeSteps++;
    assert.ok(probeSteps >= 10000, 'ran >= 10k probe steps, got ' + probeSteps);

    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        assert.equal(engine.all[i], refs[i], MEMBER_NAMES[i] + ' instance was replaced (must be reused)');
        const d = engine.all[i].dump();
        assert.equal((d.bits || d.cnts || d.fp || d.store).length, storeLen[i], MEMBER_NAMES[i] + ' store grew');
    }

    if (typeof global.gc === 'function') {
        global.gc();
        const grown = process.memoryUsage().heapUsed - heapBefore;
        assert.ok(grown < 2 * 1024 * 1024, 'heap grew ' + grown + ' B across 10k probe steps (alloc on hot path?)');
    } else {
        assert.ok(true, '(run with --expose-gc for the heap-bound check)');
    }
});

test('assertion 4c: 10k probe step()s -- 0 major GC and max pause < 2ms (lite-gc-profiler)', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    const spec = makeSpec('uniform', 2000, 12000, 9);
    const engine = createEngine(spec);
    assert.ok(engine.probeKeys.length >= 10000, 'need >= 10k probes to measure, got ' + engine.probeKeys.length);
    while (engine.cur[2] === PHASE_BUILD) step(engine);
    assert.equal(engine.cur[2], PHASE_PROBE);

    global.gc();
    const gc = new GcProfiler().start();
    let probeSteps = 0;
    while (probeSteps < 10000 && step(engine)) {
        probeSteps++;
        if ((probeSteps & 1023) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(probeSteps >= 10000, 'ran >= 10k probe steps, got ' + probeSteps);
    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 2 });
    gc.stop();

    assert.equal(s.gc.major, 0, '10k probe steps must trigger 0 major GC, got ' + s.gc.major);
    assert.ok(s.gc.maxMs < 2, '10k probe steps max GC pause must be < 2ms, got ' + s.gc.maxMs.toFixed(3));
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
});

/* ---------------------------- assertion 5 --------------------------------- */

test('assertion 5: 50 create/run/reset cycles leak nothing AND never write Filter.js', () => {
    const mtimeBefore = statSync(FILTER_JS).mtimeMs;
    const w = uniform(1000, 1500, 21);

    let heapBefore = 0;
    if (typeof global.gc === 'function') { global.gc(); heapBefore = process.memoryUsage().heapUsed; }
    for (let c = 0; c < 50; c++) {
        const engine = createEngine({ keys: w.keys, probes: w.probes, fpp: 0.01, seed: 21, kind: 'uniform', n: 1000 });
        runToEnd(engine);
        // clear() only the MUTABLE members -- static members throw on clear (immutable).
        for (let i = 0; i < MUTABLE_COUNT; i++) engine.all[i].clear();
        // engine drops out of scope here -- nothing outside holds it.
    }
    if (typeof global.gc === 'function') {
        global.gc();
        const grown = process.memoryUsage().heapUsed - heapBefore;
        assert.ok(grown < 8 * 1024 * 1024, '50 cycles grew heap ' + grown + ' B (retention?)');
    } else {
        assert.ok(true, '(run with --expose-gc for the heap-bound check)');
    }

    const mtimeAfter = statSync(FILTER_JS).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'Filter.js mtime changed -- the demo must never write the shipped surface');
});

test('assertion 5b: demo source never opens the shipped surface (Filter.js/Filter.d.ts/Bench.mjs) for writing', () => {
    const demoFiles = readdirSync(DEMO_DIR).filter(
        (f) => (f.endsWith('.mjs') || f.endsWith('.js')) && f !== 'Demo.test.mjs');
    assert.ok(demoFiles.length > 0, 'no demo source files found (setup invalid)');
    const WRITE_CALL = /writeFile(Sync)?|createWriteStream|appendFile(Sync)?/g;
    const SHIPPED_PATH_HINT = /Filter\.(js|d\.ts)|Bench\.mjs/;
    for (const f of demoFiles) {
        const src = readFileSync(join(DEMO_DIR, f), 'utf8');
        for (const m of src.matchAll(WRITE_CALL)) {
            const around = src.slice(Math.max(0, m.index - 200), m.index + 200);
            assert.ok(!SHIPPED_PATH_HINT.test(around),
                f + ' writes near a shipped-surface path token (' + m[0] + ')');
        }
    }
});

test('assertion 5c: 50 create/run/clear cycles -- lite-leak retention tracker returns to size 0', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    const leaks = [];
    const tracker = createLeakTracker({ name: 'demo-torture', onLeak: (r) => leaks.push(r.kind + ':' + String(r.tag)) });
    tracker.registerKernel(createOwnerCascadeOrphanKernel());

    const w = uniform(1000, 1500, 21);
    createRoot(() => {
        for (let c = 0; c < 50; c++) {
            // The cleanup + tag are detached primitives: neither closes over `engine`
            // (the lite-leak held-value contract -- capturing either defeats finalization
            // and the harness would silently report clean).
            const e = effect(() => {
                const engine = createEngine({ keys: w.keys, probes: w.probes, fpp: 0.01, seed: 21, kind: 'uniform', n: 1000 });
                runToEnd(engine);
                for (let i = 0; i < MUTABLE_COUNT; i++) engine.all[i].clear();
                tracker.track(engine, () => {}, 'engine', { audit: true });
            });
            dispose(e); // disposing the owner untracks the engine -> collectable
        }
    });

    global.gc();
    await new Promise((r) => setTimeout(r, 50)); // GC/finalizer entries arrive asynchronously
    const live = tracker.size();
    const findings = tracker.audit();
    assert.equal(live, 0, 'retention tracker must return to size 0 after 50 cycles, got ' + live);
    assert.equal(leaks.length, 0, 'no leak findings expected, got ' + leaks.join(','));
    assert.equal(findings.length, 0, 'no audit findings expected, got ' + findings.map((f) => f.kind + ':' + f.reason).join(','));
});

/* ------------------------------- memBits ---------------------------------- */

test('memBits is dump-driven, positive for all 7, and fails closed on an unknown tag', () => {
    const engine = createEngine(makeSpec('uniform', 1000, 1200, 3));
    runToEnd(engine);
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const snap = engine.all[i].dump();
        const bits = memBits(snap);
        assert.ok(bits > 0, MEMBER_NAMES[i] + ' memBits must be > 0');
        assert.ok(Number.isInteger(bits), MEMBER_NAMES[i] + ' memBits must be an integer count');
    }
    assert.throws(() => memBits({ mem: 'Nope' }), /unknown member tag/);
});

test('space honesty: the static space-optimal members cost fewer bits/item than plain Bloom', () => {
    // At fpp ~ 2^-8 the byte-aligned fingerprint of the static members lands on its sweet
    // spot, and at a large n their asymptotic ~1.13x/~1.23x overhead beats Bloom's 1.44x.
    const fpp = 0.004;
    const engine = createEngine(makeSpec('sequential', 20000, 4000, 1, fpp));
    runToEnd(engine);
    const rows = summary(engine);
    const byName = {};
    for (const r of rows) byName[r.name] = r;
    assert.ok(byName.BinaryFuse.bitsPerItem < byName.Bloom.bitsPerItem,
        'BinaryFuse (' + byName.BinaryFuse.bitsPerItem.toFixed(2) + ') must be leaner than Bloom (' + byName.Bloom.bitsPerItem.toFixed(2) + ')');
    assert.ok(byName.Xor.bitsPerItem < byName.Bloom.bitsPerItem,
        'Xor (' + byName.Xor.bitsPerItem.toFixed(2) + ') must be leaner than Bloom (' + byName.Bloom.bitsPerItem.toFixed(2) + ')');
    assert.ok(Math.abs(byName.Bloom.bound - Math.log2(1 / fpp)) < 1e-9, 'bound must be log2(1/fpp)');
});

test('FPR honesty: measured Bloom FPR is near-or-over its theoretical estimate (never absurdly under)', () => {
    const engine = createEngine(makeSpec('uniform', 5000, 40000, 2, 0.01));
    runToEnd(engine);
    const rows = summary(engine);
    const bloom = rows.find((r) => r.name === 'Bloom');
    // A tuned Bloom lands close to target; allow the measured rate up to 3x theory
    // (small-sample noise) but it must be a real, finite number.
    assert.ok(bloom.measFpr >= 0 && bloom.measFpr < 3 * bloom.theoFpr + 0.01, 'Bloom measured FPR out of honest band: ' + bloom.measFpr);
    assert.ok(Number.isFinite(bloom.overTheoryPct));
});

/* --------------------------- engine lifecycle ----------------------------- */

test('static "building" signal is engine state: builtStatic false during BUILD, true after', () => {
    const engine = createEngine(makeSpec('uniform', 500, 600, 4));
    let f = frameModel(engine);
    assert.equal(f.builtStatic, false, 'builtStatic must start false');
    assert.equal(f.phase, PHASE_BUILD);
    // "building" is NEVER a dump field.
    assert.ok(!('building' in f.members.Xor), 'Xor dump must not carry a building field');
    while (engine.cur[2] === PHASE_BUILD) step(engine);
    f = frameModel(engine);
    assert.equal(f.builtStatic, true, 'builtStatic must flip true when BUILD completes');
    assert.equal(f.phase, PHASE_PROBE);
});

test('renderSummary reuses hot-path counts, caches FN once in PROBE, and matches summary() at end', () => {
    const engine = createEngine(makeSpec('uniform', 1500, 4000, 17));
    // During BUILD, FN is not yet measured -> reported as -1 (pending), never a wrong 0.
    let f = frameModel(engine);
    let rows = renderSummary(engine, f);
    for (const r of rows) assert.equal(r.fn, -1, r.name + ' FN must be pending (-1) during BUILD');
    // Run to end, then renderSummary must agree with the authoritative summary().
    runToEnd(engine);
    f = frameModel(engine);
    rows = renderSummary(engine, f);
    const auth = summary(engine);
    const byName = {};
    for (const r of auth) byName[r.name] = r;
    for (const r of rows) {
        assert.equal(r.fn, 0, r.name + ' FN must be 0 after a full build');
        assert.equal(r.fn, byName[r.name].fn, r.name + ' FN must match summary()');
        // Measured FPR from accumulated counts must equal the authoritative re-probe
        // (all probes are known-absent, so both count the same false positives).
        assert.ok(Math.abs(r.measFpr - byName[r.name].measFpr) < 1e-12, r.name + ' measFpr diverged from summary()');
        assert.ok(Math.abs(r.bitsPerItem - byName[r.name].bitsPerItem) < 1e-9, r.name + ' bitsPerItem diverged');
    }
});

test('renderSummary fnCount cache never leaks across engines and cannot go stale mid-PROBE', () => {
    // Two independently created engines over the SAME workload must have their OWN
    // fnCount cache (a fresh Int32Array per createEngine) -- proves no shared/global
    // cache could leak a stale value from one engine's run into another's.
    const spec = makeSpec('uniform', 800, 1000, 0x2a);
    const e1 = createEngine(spec);
    const e2 = createEngine(makeSpec('uniform', 800, 1000, 0x2a));
    assert.notEqual(e1.fnCount, e2.fnCount, 'each engine must own a distinct fnCount array');
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        assert.equal(e1.fnCount[i], -1, 'fnCount must start pending (-1) before any PROBE frame');
        assert.equal(e2.fnCount[i], -1, 'a second engine must independently start pending (-1)');
    }
    // Drive only e1 to completion; e2's cache must remain untouched (-1), proving the
    // cache is per-engine state, not a module-level or shared cache.
    runToEnd(e1);
    const f1 = frameModel(e1);
    renderSummary(e1, f1);
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        assert.equal(e1.fnCount[i], 0, 'e1 fnCount must be measured (0) after a full run');
        assert.equal(e2.fnCount[i], -1, 'e2 fnCount must be untouched by e1 running to completion');
    }
    // Within a single PROBE phase, fnCount must not be recomputed (identical value
    // across repeated renderSummary calls at different probe cursors -- "cannot go
    // stale" means it also cannot silently CHANGE mid-phase, since the add-set is fixed).
    const e3 = createEngine(makeSpec('uniform', 800, 1000, 0x2b));
    while (e3.cur[2] === PHASE_BUILD) step(e3);
    const before = renderSummary(e3, frameModel(e3)).map((r) => r.fn);
    for (let i = 0; i < 50 && step(e3); i++) { /* advance mid-PROBE */ }
    const mid = renderSummary(e3, frameModel(e3)).map((r) => r.fn);
    assert.deepStrictEqual(before, mid, 'fnCount must not change mid-PROBE (cache cannot go stale within a phase)');
});

test('createEngine boundary matrix: bad keys/probes/fpp/empty add-set all fail closed', () => {
    assert.throws(() => createEngine(null), TypeError);
    assert.throws(() => createEngine({ keys: 'nope', probes: [] }), TypeError);
    assert.throws(() => createEngine({ keys: [1], probes: 'nope' }), TypeError);
    assert.throws(() => createEngine({ keys: [1], probes: [], fpp: 0 }), RangeError, 'fpp=0 must throw');
    assert.throws(() => createEngine({ keys: [1], probes: [], fpp: 1 }), RangeError, 'fpp=1 must throw');
    assert.throws(() => createEngine({ keys: [1], probes: [], fpp: -0.1 }), RangeError);
    assert.throws(() => createEngine({ keys: [], probes: [1] }), RangeError, 'empty add-set must throw (static members undefined over 0 keys)');
    // A minimal valid spec builds and runs.
    assert.doesNotThrow(() => runToEnd(createEngine({ keys: [1, 2, 3], probes: [-1, -2], fpp: 0.02 })));
});

test('runToEnd step count equals build distinct + probe totals; step() past end returns false', () => {
    const engine = createEngine(makeSpec('uniform', 400, 500, 8));
    const total = runToEnd(engine);
    assert.equal(total, engine.addKeys.length + engine.probeKeys.length, 'total steps = distinct adds + probes');
    for (let i = 0; i < 20; i++) assert.equal(step(engine), false, 'step past end must stay false');
});

test('probe oracle is disjoint from the add-set (a probe true is a real false positive)', () => {
    const w = uniform(1000, 2000, 13);
    const keys = new Set(w.keys);
    let overlap = 0;
    for (let i = 0; i < w.probes.length; i++) if (keys.has(w.probes[i])) overlap++;
    assert.equal(overlap, 0, 'probes must be disjoint from keys');
});

test('all members use the keys:"int" backing and report it in dump()', () => {
    const engine = createEngine(makeSpec('uniform', 300, 400, 6));
    runToEnd(engine);
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        assert.equal(engine.all[i].dump().keys, 'int', MEMBER_NAMES[i] + ' must use the int backing');
    }
});

test('workload generators are deterministic for a fixed seed', () => {
    for (const kind of ['uniform', 'zipfian', 'sequential', 'adversarial']) {
        const a = GEN[kind](500, 600, 99);
        const b = GEN[kind](500, 600, 99);
        assert.deepStrictEqual(a.keys, b.keys, kind + ' keys not deterministic');
        assert.deepStrictEqual(a.probes, b.probes, kind + ' probes not deterministic');
    }
});

/* ------------------------------ serve.mjs --------------------------------- */

test('serveWorkload fails closed on bad kind/n/fpp and normalizes seed 0 -> 1', () => {
    assert.throws(() => serveWorkload('bogus', 1, 100, 0.01), /unknown workload kind/);
    assert.throws(() => serveWorkload('uniform', 1, 0, 0.01), RangeError, 'n=0 must throw');
    assert.throws(() => serveWorkload('uniform', 1, -3, 0.01), RangeError);
    assert.throws(() => serveWorkload('uniform', 1, 1.5, 0.01), RangeError, 'non-integer n');
    assert.throws(() => serveWorkload('uniform', 1, NaN, 0.01), RangeError);
    assert.throws(() => serveWorkload('uniform', 1, 100, 0), RangeError, 'fpp=0 must throw');
    assert.throws(() => serveWorkload('uniform', 1, 100, 1), RangeError, 'fpp=1 must throw');
    assert.throws(() => serveWorkload('uniform', 1, 100, NaN), RangeError);
    const a = serveWorkload('uniform', 0, 50, 0.01);
    const b = serveWorkload('uniform', 0, 50, 0.01);
    assert.equal(a.seed, 1, 'seed 0 must normalize to 1');
    assert.deepStrictEqual(a.keys, b.keys, 'normalized seed must stay deterministic');
    assert.equal(a.probes.length, a.probeCount);
    assert.equal(DEFAULT_PORT, 8017);
});

function mockRes() {
    const res = {
        statusCode: 0, headers: {}, chunks: [], ended: false,
        writeHead(code, hdrs) { res.statusCode = code; if (hdrs) Object.assign(res.headers, hdrs); },
        end(body) { if (body !== undefined) res.chunks.push(body); res.ended = true; },
    };
    return res;
}
async function drive(url) { const res = mockRes(); await handle({ url }, res); return res; }

test('/workload.json 400s on a bad kind (JSON error body) over the actual handler', async () => {
    const res = await drive('/workload.json?kind=nonsense&seed=1&n=50&fpp=0.01');
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.chunks.join(''));
    assert.match(body.error, /unknown workload kind/);
});

test('/workload.json 400s on n=0 and on a bad fpp (0 is not absent -- null is not zero)', async () => {
    const badN = await drive('/workload.json?kind=uniform&seed=1&n=0&fpp=0.01');
    assert.equal(badN.statusCode, 400);
    const badFpp = await drive('/workload.json?kind=uniform&seed=1&n=50&fpp=0');
    assert.equal(badFpp.statusCode, 400);
    const badFpp2 = await drive('/workload.json?kind=uniform&seed=1&n=50&fpp=2');
    assert.equal(badFpp2.statusCode, 400);
});

test('/workload.json 400s on a non-numeric seed (no silent fallback to 1)', async () => {
    // Number("abc") -> NaN -> NaN>>>0 -> 0 -> ||1 would silently return a seed:1 200.
    for (const bad of ['abc', '12x', 'NaN', '1e']) {
        const res = await drive('/workload.json?kind=uniform&seed=' + bad + '&n=50&fpp=0.01');
        assert.equal(res.statusCode, 400, 'seed=' + bad + ' must 400, not silently default');
        const body = JSON.parse(res.chunks.join(''));
        assert.match(body.error, /seed/);
    }
    // An ABSENT seed still uses the default (200).
    const ok = await drive('/workload.json?kind=uniform&n=50&fpp=0.01');
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.chunks.join('')).seed, 1);
});

test('a malformed percent-encoded path 404s (never an unhandled URIError crash)', async () => {
    // decodeURIComponent("/%") throws URIError; safePath must fail closed to a 404, not
    // let it bubble into an unhandled rejection that crashes the process.
    for (const p of ['/%', '/%zz', '/demo/%E0%A4%A']) {
        const res = await drive(p);
        assert.equal(res.statusCode, 404, p + ' must 404, not crash');
    }
});

test('/workload.json 400s on non-finite seed values (Infinity/-Infinity), not a silent default', async () => {
    for (const bad of ['Infinity', '-Infinity']) {
        const res = await drive('/workload.json?kind=uniform&seed=' + bad + '&n=50&fpp=0.01');
        assert.equal(res.statusCode, 400, 'seed=' + bad + ' must 400, not silently default');
        const body = JSON.parse(res.chunks.join(''));
        assert.match(body.error, /seed/);
    }
});

test('/workload.json 400s on a present-but-non-finite n or fpp (NaN/Infinity), never a silent default', async () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity', '1.5']) {
        const r = await drive('/workload.json?kind=uniform&seed=1&n=' + bad + '&fpp=0.01');
        assert.equal(r.statusCode, 400, 'n=' + bad + ' must 400');
    }
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
        const r = await drive('/workload.json?kind=uniform&seed=1&n=50&fpp=' + bad);
        assert.equal(r.statusCode, 400, 'fpp=' + bad + ' must 400');
    }
});

test('path traversal that WOULD escape ROOT stays 404 -- confinement holds, never serves outside-repo content', async () => {
    // Every one of these, if the traversal guard were broken, would resolve outside
    // REPO_ROOT (e.g. to a real /etc/passwd or the parent LiteLibrariesSuite dir).
    // safePath must confine all of them: either they collapse to a path still inside
    // ROOT (served normally) or they are rejected outright -- NEVER a 200 with content
    // whose source lies outside ROOT. /etc/passwd is guaranteed to exist off-repo, so a
    // 200 here would be unambiguous proof of an escape.
    const escapes = [
        '/../../../../../../etc/passwd',
        '/..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
        '/....//....//....//etc/passwd',
        '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        '/demo/....%2f....%2fpackage.json',
    ];
    for (const p of escapes) {
        const res = await drive(p);
        assert.equal(res.statusCode, 404, p + ' must not escape ROOT (expected 404)');
    }
});

test('/workload.json returns a well-shaped, seed-deterministic payload', async () => {
    const r1 = await drive('/workload.json?kind=zipfian&seed=7&n=200&fpp=0.01');
    const r2 = await drive('/workload.json?kind=zipfian&seed=7&n=200&fpp=0.01');
    assert.equal(r1.statusCode, 200);
    const p1 = JSON.parse(r1.chunks.join(''));
    const p2 = JSON.parse(r2.chunks.join(''));
    assert.deepStrictEqual(p1, p2, 'same query must produce a byte-identical payload');
    assert.equal(p1.keys.length, 200);
    assert.ok(Array.isArray(p1.probes));
    assert.equal(p1.fpp, 0.01);
    // The payload builds an engine.
    assert.doesNotThrow(() => createEngine({ keys: p1.keys, probes: p1.probes, fpp: p1.fpp, seed: p1.seed }));
});

test('"/" 302-redirects to /demo/visuals.html and the page + its imports load', async () => {
    const root = await drive('/');
    assert.equal(root.statusCode, 302, '"/" must redirect, not serve in place');
    assert.equal(root.headers.location, '/demo/visuals.html');
    const page = await drive('/demo/visuals.html');
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    for (const p of ['/demo/Visualize.mjs', '/demo/renderers.mjs', '/Filter.js']) {
        const src = await drive(p);
        assert.equal(src.statusCode, 200, p + ' must load');
        assert.match(src.headers['content-type'], /javascript/, p + ' must be JS');
    }
});

test('static route 404s on a missing file and stays confined to REPO_ROOT', async () => {
    const missing = await drive('/demo/does-not-exist.mjs');
    assert.equal(missing.statusCode, 404);
    const escaped = await drive('/..%2fpackage.json');
    assert.equal(escaped.statusCode, 200, 'traversal must resolve inside REPO_ROOT');
    const body = JSON.parse(escaped.chunks.join(''));
    assert.equal(body.name, '@zakkster/lite-filter', 'traversal must stay confined to REPO_ROOT');
});

/* ----------------------------- fetchWorkload ------------------------------ */

test('fetchWorkload: a REJECTED fetch fails closed with the actionable hint, never throws', async () => {
    const reject = () => Promise.reject(new TypeError('Failed to fetch'));
    const result = await fetchWorkload('/workload.json?kind=uniform', reject);
    assert.equal(result.ok, false);
    assert.ok(result.message.startsWith(WORKLOAD_SERVER_HINT));
    assert.match(result.message, /Failed to fetch/);
});

test('fetchWorkload: a non-OK status fails closed with the hint', async () => {
    const notFound = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    const result = await fetchWorkload('/workload.json?kind=uniform', notFound);
    assert.equal(result.ok, false);
    assert.match(result.message, /server 404/);
});

test('fetchWorkload: a 200 with a server {error} body fails closed', async () => {
    const errBody = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ error: 'bad kind' }) });
    const result = await fetchWorkload('/workload.json?kind=bogus', errBody);
    assert.equal(result.ok, false);
    assert.match(result.message, /bad kind/);
});

test('fetchWorkload: a well-shaped 200 succeeds and the data builds an engine', async () => {
    const payload = { keys: [1, 2, 3], probes: [-1, -2], fpp: 0.01, seed: 1, kind: 'uniform', n: 3 };
    const okFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    const result = await fetchWorkload('/workload.json?kind=uniform', okFetch);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.data, payload);
    assert.doesNotThrow(() => createEngine(result.data));
});

test('fetchWorkload: a valid-JSON but WRONG-SHAPE 200 fails closed (no ok:true)', async () => {
    const bodies = [{}, { keys: [] }, { keys: [1] }, { keys: [1], probes: 'no' },
        { keys: [1], probes: [], fpp: 0 }, { keys: [1], probes: [], fpp: 2 }];
    for (const body of bodies) {
        const ok200 = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        const result = await fetchWorkload('/workload.json?kind=uniform', ok200);
        assert.equal(result.ok, false, 'wrong shape ' + JSON.stringify(body) + ' must fail closed');
        assert.match(result.message, /malformed workload payload/);
    }
});

test('WORKLOAD_SERVER_HINT is ASCII-only and names the command, the URL (8017), and the reason', () => {
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x00-\x7F]*$/.test(WORKLOAD_SERVER_HINT), 'hint must be ASCII-only');
    assert.match(WORKLOAD_SERVER_HINT, /npm run demo:serve/);
    assert.match(WORKLOAD_SERVER_HINT, /http:\/\/localhost:8017\//);
    assert.match(WORKLOAD_SERVER_HINT, /dynamic route/);
});

/* ==========================================================================
 * Session B -- the peel / construction animation for the two STATIC members.
 * The animation RE-DERIVES the shipped construction (peel.mjs) because the real
 * peel stack is local + discarded and the hash primitives are unexported. These
 * tests are the honesty teeth: they prove the re-derivation reproduces the
 * shipped fingerprints EXACTLY, that the peel invariants hold, that it is
 * deterministic, and that it fails CLOSED on an unpeelable set.
 * ========================================================================== */

// The reseed rule, mirrored from peel.mjs / Filter.js: seed ^ (attempt * 0x9e3779b1).
function attemptSeed(baseSeed, attempt) {
    return (baseSeed ^ Math.imul(attempt, 0x9e3779b1)) >>> 0;
}

// The shipped chosen seed for (keys, fpp, seed, member) -- dump().seed reveals which
// reseed attempt Filter.js actually landed on.
function shippedSeed(keys, fpp, seed, member) {
    const opts = { fpp, seed: seed >>> 0, keys: 'int', stats: true };
    const inst = member === 'Xor' ? XorFilter.from(keys, opts) : BinaryFuse.from(keys, opts);
    return inst.dump().seed;
}

test('Session B assertion 1: re-derived peel reproduces the shipped fp EXACTLY (4/4: {Xor,BinaryFuse} x {48,2000}) and picks the SAME attempt', () => {
    let exact = 0;
    for (const member of PEEL_MEMBERS) {
        for (const n of [48, 2000]) {
            const keys = demoKeys(n);
            const derived = derivePeel({ keys, fpp: PEEL_FPP, seed: PEEL_SEED, member, withFrames: false });
            const shipped = shippedFp(keys, PEEL_FPP, PEEL_SEED, member);
            // (a) SAME successful reseed attempt: the derived attempt-seed must equal the
            // seed the shipped filter actually built with.
            const wantSeed = shippedSeed(keys, PEEL_FPP, PEEL_SEED, member);
            assert.equal(attemptSeed(PEEL_SEED, derived.attempt), wantSeed,
                member + ' n=' + n + ' must pick the SAME reseed attempt as the shipped build');
            // (b) byte-exact fingerprint array.
            assert.deepStrictEqual(derived.fp, shipped,
                member + ' n=' + n + ' re-derived fp must deep-equal the shipped dump().fp');
            exact++;
        }
    }
    assert.equal(exact, 4, 'all 4 (member x n) faithfulness cases must pass');
});

test('Session B: frameModel VERIFIES live (returns verified:true), is frozen, and layout tiles the store', () => {
    for (const member of PEEL_MEMBERS) {
        const model = peelFrameModel({ member });
        assert.equal(model.verified, true, member + ' frameModel must be live-verified');
        assert.equal(model.member, member);
        assert.equal(model.n, PEEL_N);
        assert.ok(Object.isFrozen(model), member + ' model must be frozen');
        assert.ok(Object.isFrozen(model.frames), member + ' frames must be frozen');
        assert.equal(model.layout.rows * model.layout.cols, model.m,
            member + ' layout rows*cols must equal the store size m');
    }
});

test('Session B assertion 2: peel invariants -- sp === n, 3n incidences, every vertex lit exactly once', () => {
    for (const member of PEEL_MEMBERS) {
        const n = PEEL_N;
        const model = peelFrameModel({ member });
        const frames = model.frames;

        const graph = frames.find((f) => f.stage === 'graph');
        const peel = frames.filter((f) => f.stage === 'peel');
        const assign = frames.filter((f) => f.stage === 'assign');

        // A complete peel: exactly n peel steps and n assign steps (sp === n).
        assert.equal(peel.length, n, member + ' must have exactly n peel frames (complete peel, sp === n)');
        assert.equal(assign.length, n, member + ' must have exactly n assign frames');
        assert.equal(frames.length, 1 + 2 * n, member + ' frame count = 1 graph + n peel + n assign');

        // 3n incidences: the initial degree sum over all vertices is 3 per edge.
        let degSum = 0;
        for (let v = 0; v < graph.deg.length; v++) degSum += graph.deg[v];
        assert.equal(degSum, 3 * n, member + ' initial incidence count must be 3n');

        // Every vertex lit EXACTLY once: each assign frame lights exactly one new slot, and
        // the final lit vector has exactly n ones (n distinct owned slots).
        let prevOnes = 0;
        for (let i = 0; i < assign.length; i++) {
            let ones = 0;
            const lit = assign[i].lit;
            for (let v = 0; v < lit.length; v++) ones += lit[v] ? 1 : 0;
            assert.equal(ones, prevOnes + 1, member + ' assign frame ' + i + ' must light exactly one new slot');
            // The slot lit this frame is the cursor vertex, and it was NOT lit before.
            const cur = assign[i].cursor;
            assert.ok(cur !== null, member + ' assign frame must name the slot it lit');
            assert.equal(lit[cur.v], 1, member + ' the cursor slot must be lit this frame');
            prevOnes = ones;
        }
        assert.equal(prevOnes, n, member + ' exactly n slots must be lit in total');
    }
});

test('Session B assertion 3: determinism -- two frameModel runs produce byte-identical frames', () => {
    for (const member of PEEL_MEMBERS) {
        const a = peelFrameModel({ member });
        const b = peelFrameModel({ member });
        assert.deepStrictEqual(a.frames, b.frames, member + ' frames must be byte-identical across runs');
        assert.equal(a.attempt, b.attempt, member + ' attempt must be deterministic');
        // derivePeel (frameless) is deterministic too.
        const da = derivePeel({ keys: demoKeys(64), fpp: PEEL_FPP, seed: PEEL_SEED, member, withFrames: false });
        const db = derivePeel({ keys: demoKeys(64), fpp: PEEL_FPP, seed: PEEL_SEED, member, withFrames: false });
        assert.deepStrictEqual(da.fp, db.fp, member + ' frameless fp must be deterministic');
    }
});

test('Session B: peelCore returns null on a partial peel (fail-OPEN guard, never assigns from a short stack)', () => {
    // A pathological geometry that maps EVERY edge to the same 3 slots: with n >= 2 edges
    // no vertex ever reaches degree 1, so the peel stalls at sp === 0 (a 2-core survives).
    // peelCore must return null, NOT a fingerprint array -- that guard is the only thing
    // between a partial peel and a fail-OPEN filter with silent false negatives.
    const collapse = {
        name: 'Xor',
        dims() { return { m: 3 }; },
        layout() { return { rows: 1, cols: 3 }; },
        slots() { return [0, 1, 2]; },
    };
    const keys = demoKeys(8);
    const dims = { m: 3, seed: PEEL_SEED, seed2: 0, fw: 8, attempt: 0, withFrames: false };
    const built = peelCore(keys, collapse, dims);
    assert.equal(built, null, 'peelCore must return null on an incomplete peel');
});

test('Session B assertion 4: derivePeel FAILS CLOSED (throws [demo]) when a set cannot peel in 100 attempts', () => {
    // The same collapse geometry, driven through derivePeel: every one of the 100 reseeds
    // yields the same unpeelable structure, so the loop exhausts and throws -- never a
    // partial build.
    const collapse = {
        name: 'Xor',
        dims() { return { m: 3 }; },
        layout() { return { rows: 1, cols: 3 }; },
        slots() { return [0, 1, 2]; },
    };
    assert.throws(
        () => derivePeel({ keys: demoKeys(8), fpp: PEEL_FPP, seed: PEEL_SEED, member: 'Xor', geom: collapse }),
        (err) => err instanceof Error && /^\[demo\]/.test(err.message) && /exhausted/.test(err.message),
        'derivePeel must throw an actionable [demo] exhaustion error, never return a partial build');
});

test('Session B: derivePeel / frameModel fail closed on an unknown member and an empty key set', () => {
    assert.throws(() => derivePeel({ keys: demoKeys(4), member: 'Nope' }), /unknown member/);
    assert.throws(() => peelFrameModel({ member: 'Nope' }), /unknown member/);
    assert.throws(() => derivePeel({ keys: [], member: 'Xor' }), /non-empty/);
});

test('Session B: derivePeel / frameModel boundary matrix -- opts null/undefined, keys null/undefined, n=1', () => {
    // opts itself missing or the wrong shape.
    assert.throws(() => derivePeel(null), /opts must be an object/);
    assert.throws(() => derivePeel(undefined), /opts must be an object/);
    assert.throws(() => derivePeel({ keys: null, member: 'Xor' }), /array of int keys/);
    assert.throws(() => derivePeel({ member: 'Xor' }), /array of int keys/, 'keys undefined must fail closed');
    // n=1: the smallest legal static filter (one key, one edge, three slots, always peels
    // in one step since all three slots start at degree 1... unless two of the three slot
    // triples collide, which the reseed loop then handles). Must not throw and must still
    // verify against the shipped build.
    for (const member of PEEL_MEMBERS) {
        const model = peelFrameModel({ member, n: 1 });
        assert.equal(model.verified, true, member + ' n=1 must still verify against the shipped fp');
        assert.equal(model.n, 1);
    }
});

test('Session B assertion 5: a NaN int key is REJECTED by the production entry point (frameModel), even though derivePeel alone silently coerces it -- the live faithfulness check is the actual fail-closed backstop; -0 is legitimate (Number.isInteger(-0) is true, same slot as 0) and must NOT be rejected', () => {
    // peelCore mirrors Filter.js's int-key mixing (`key | 0`) but, unlike Filter.js's own
    // `add()`/`from()` (which gate on `Number.isInteger(key)` BEFORE mixing), it does not
    // itself validate the key. `NaN | 0` silently becomes the valid slot index 0, so
    // derivePeel() called STANDALONE (withFrames only, no verification) does NOT reject a
    // NaN key -- prove that first, non-vacuously.
    assert.doesNotThrow(() => derivePeel({ keys: [1, 2, NaN, 4], member: 'Xor', withFrames: false }),
        'documents the current gap: derivePeel alone does not itself reject a NaN key');
    // But the actual production surface the renderer calls -- frameModel, which ALWAYS
    // runs verifyAgainstShipped -- must still fail closed, because Filter.js's own from()
    // rejects the NaN key with an actionable message (Number.isInteger(NaN) is false),
    // and that rejection propagates.
    assert.throws(() => peelFrameModel({ keys: [1, 2, NaN, 4], member: 'Xor' }),
        /requires a 32-bit signed integer key/,
        'frameModel must fail closed on a NaN key via the live shipped-fp comparison');
    // -0, by contrast, IS a legitimate int key (Number.isInteger(-0) === true, and -0|0 ===
    // 0 === 0|0): Filter.js accepts it as plain 0, so frameModel must NOT reject it, and
    // the re-derivation must still verify byte-exact against the shipped build.
    const m0 = peelFrameModel({ keys: [1, 2, -0, 4], member: 'BinaryFuse' });
    assert.equal(m0.verified, true, '-0 is a legitimate key (same as 0) and must still verify');
});

test('Session B assertion 5: Symbol/BigInt seed and key inputs must fail closed with a clean, actionable rejection -- never a raw coercion TypeError (the family lesson)', () => {
    // Filter.js validates its own seed/int-key inputs BEFORE any arithmetic touches them
    // (`typeof seed !== "number"`, `Number.isInteger(key)`), so a Symbol or BigInt never
    // reaches a coercing operator and always gets an actionable "[lite-filter] ..." message.
    // peel.mjs entry points that take keys/options must hold to the same discipline: a
    // Symbol or BigInt must be rejected with an actionable "[demo] ..." message, not left
    // to fall through into `>>> 0` / `| 0`, which throw a raw, non-actionable
    // "Cannot convert a Symbol value to a number" / "Cannot mix BigInt and other types".
    const ACTIONABLE = (err) => err instanceof Error && /^\[demo\]/.test(err.message);
    for (const bad of [Symbol('x'), 10n]) {
        assert.throws(() => derivePeel({ keys: demoKeys(4), member: 'Xor', seed: bad }), ACTIONABLE,
            'derivePeel({ seed: ' + String(bad) + ' }) must throw an actionable [demo] message');
        assert.throws(() => derivePeel({ keys: [bad, 1, 2, 3], member: 'Xor' }), ACTIONABLE,
            'derivePeel({ keys: [' + String(bad) + ', ...] }) must throw an actionable [demo] message');
        assert.throws(() => peelFrameModel({ member: 'Xor', seed: bad }), ACTIONABLE,
            'frameModel({ seed: ' + String(bad) + ' }) must throw an actionable [demo] message');
    }
});

test('Session B: renderers.mjs (the peel/construction renderer host) has zero imports -- a pure frame consumer, no module dependencies', () => {
    const src = readFileSync(join(DEMO_DIR, 'renderers.mjs'), 'utf8');
    assert.ok(src.length > 100, 'renderers.mjs must be nonempty (scan would be vacuous)');
    assert.ok(!/^\s*import\b/m.test(src), 'renderers.mjs must not import anything (drawPeel consumes a plain frozen model only)');
});

test('Session B: GEOM slot triples land in-range and in DISTINCT slots (no self-collision)', () => {
    // XOR: three disjoint segments h0 < bl <= h1 < 2bl <= h2 < 3bl.
    const dx = GEOM_XOR.dims(48);
    for (let key = 0; key < 200; key++) {
        const h = (key * 2654435761) >>> 0, g = (key * 40503 + 7) >>> 0, t = (key ^ 0x5bd1e995) >>> 0;
        const s = GEOM_XOR.slots(h, g, t, dx);
        assert.ok(s[0] >= 0 && s[0] < dx.bl, 'xor h0 in seg0');
        assert.ok(s[1] >= dx.bl && s[1] < 2 * dx.bl, 'xor h1 in seg1');
        assert.ok(s[2] >= 2 * dx.bl && s[2] < 3 * dx.bl, 'xor h2 in seg2');
        assert.equal(new Set(s).size, 3, 'xor slots must be distinct');
    }
    // BinaryFuse: h0 in [0, scl), h1 one segment up, h2 two -- always in range and distinct.
    const db = GEOM_BF.dims(48);
    for (let key = 0; key < 200; key++) {
        const h = (key * 2654435761) >>> 0, g = (key * 40503 + 7) >>> 0, t = (key ^ 0x5bd1e995) >>> 0;
        const s = GEOM_BF.slots(h, g, t, db);
        for (let j = 0; j < 3; j++) assert.ok(s[j] >= 0 && s[j] < db.m, 'bf slot ' + j + ' in range');
        assert.equal(new Set(s).size, 3, 'bf slots must be distinct');
    }
});

test('Session B: drawPeel fails closed (no throw) on a missing/malformed model', () => {
    // A minimal CanvasRenderingContext2D stub -- drawPeel must never throw, even with no
    // frames (the panel shows an "unavailable" message and stays in a safe state).
    const g = {
        fillStyle: '', font: '', strokeStyle: '', lineWidth: 0,
        fillText() {}, fillRect() {}, strokeRect() {}, clearRect() {},
    };
    const geom = { x: 14, y: 10, w: 872, h: 280 };
    assert.doesNotThrow(() => drawPeel(g, null, 0, geom));
    assert.doesNotThrow(() => drawPeel(g, { frames: [] }, 0, geom));
    // A real model draws without throwing at every frame index (clamped).
    const model = peelFrameModel({ member: 'Xor' });
    assert.doesNotThrow(() => drawPeel(g, model, -5, geom));
    assert.doesNotThrow(() => drawPeel(g, model, 0, geom));
    assert.doesNotThrow(() => drawPeel(g, model, model.frames.length + 99, geom));
});

test('Session B: peel.mjs never writes the shipped surface and imports only ../Filter.js', () => {
    const src = readFileSync(join(DEMO_DIR, 'peel.mjs'), 'utf8');
    assert.ok(src.length > 100, 'peel.mjs must be nonempty');
    // No writes at all in this file.
    assert.ok(!/writeFile|createWriteStream|appendFile/.test(src), 'peel.mjs must not write any file');
    // The only bare-specifier / relative import of the shipped surface is ../Filter.js.
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
        const ok = spec === '../Filter.js' || spec.startsWith('node:');
        assert.ok(ok, 'peel.mjs may import only ../Filter.js (or node: in the guarded main), got ' + spec);
    }
    // ASCII-only source (suite law).
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x00-\x7F]*$/.test(src), 'peel.mjs must be ASCII-only');
});
