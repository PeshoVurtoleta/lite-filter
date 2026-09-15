// @zakkster/lite-filter -- demo engine (repo-only visualization, dump()-driven).
//
//   npm run demo                 (headless per-member summary table)
//   node demo/Visualize.mjs      (same)
//
// The headless visualization engine. It constructs ALL SEVEN members once, feeds ONE
// shared (add-set, probe-set) to every member side by side, and reads each member's
// live state via dump() -- the SINGLE honest source. It NEVER re-implements a
// member's mechanics: the store IS the picture.
//
// Two phases per run:
//   BUILD -- one add per step to the five MUTABLE members (Bloom, CountingBloom,
//            BlockedBloom, Cuckoo, Quotient). The two STATIC members (Xor,
//            BinaryFuse) have no incremental add -- they are built ONCE from the whole
//            deduped add-set via .from() at createEngine time, and show "building..."
//            (engine state, NOT a dump field) until the BUILD cursor completes.
//   PROBE -- one probe per step across ALL seven members. Every probe key is drawn
//            from a set DISJOINT from the add-set (Bench.mjs guarantees it), so a
//            probe that reads true is unambiguously a FALSE POSITIVE.
//
// This module imports ONLY ../Filter.js, so it loads unchanged in the browser
// (demo/visuals.html). The Node-main block (npm run demo) DYNAMICALLY imports
// benchmark/Bench.mjs + node:url, guarded by `typeof process`, so that path never
// runs in the browser.
//
// Repo-only dev artifact; NEVER shipped in the npm tarball.

import { Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter, BinaryFuse } from '../Filter.js';

/** The seven family members, in roster order: the five MUTABLE members first, then
 *  the two STATIC members. `name` is each member's dump() `mem` tag (NOTE: XorFilter's
 *  tag is "Xor", not "XorFilter"); `ctor` is the class; `isStatic` selects the
 *  build-once-from-a-set path. Constructed once per engine. */
export const MEMBER_DEFS = Object.freeze([
    { name: 'Bloom', ctor: Bloom, isStatic: false },
    { name: 'CountingBloom', ctor: CountingBloom, isStatic: false },
    { name: 'BlockedBloom', ctor: BlockedBloom, isStatic: false },
    { name: 'Cuckoo', ctor: Cuckoo, isStatic: false },
    { name: 'Quotient', ctor: Quotient, isStatic: false },
    { name: 'Xor', ctor: XorFilter, isStatic: true },
    { name: 'BinaryFuse', ctor: BinaryFuse, isStatic: true },
]);

/** The seven dump() `mem` tags, frozen, in roster order (so a demo run and a bench run
 *  line up member-for-member). The five mutable members come first. */
export const MEMBER_NAMES = Object.freeze(MEMBER_DEFS.map((d) => d.name));

/** The count of MUTABLE members (the first N entries of MEMBER_DEFS). The BUILD phase
 *  adds to exactly these; the two static members are already built. */
export const MUTABLE_COUNT = 5;

/** Engine phase codes (packed into the cursor Int32Array; never allocated per step). */
export const PHASE_BUILD = 0;
export const PHASE_PROBE = 1;

/** Last-op codes for the frame readout (also cursor-packed). */
export const OP_NONE = 0;
export const OP_ADD = 1;
export const OP_PROBE = 2;

/**
 * The exact bit cost of a member's store, derived STRICTLY from its dump() (the
 * serialized store length x the element width the dump's own fields imply). This is
 * dump-driven -- no private field is read -- so it stays honest to the "dump() is the
 * only source of truth" law. Fails closed on an unknown member tag (null is not zero).
 */
export function memBits(snap) {
    switch (snap.mem) {
        case 'Bloom': return snap.bits.length * 32;          // Uint32 words
        case 'CountingBloom': return snap.cnts.length * 8;   // Uint8 nibble store
        case 'BlockedBloom': return snap.bits.length * 32;   // Uint32 words
        case 'Cuckoo': return snap.fp.length * (snap.fw <= 8 ? 8 : 16);
        case 'Quotient': return snap.store.length * ((snap.r + 3) <= 8 ? 8 : 16);
        case 'Xor': return snap.fp.length * (snap.fw <= 8 ? 8 : 16);
        case 'BinaryFuse': return snap.fp.length * (snap.fw <= 8 ? 8 : 16);
        default:
            throw new Error('[demo] memBits: unknown member tag ' + String(snap.mem));
    }
}

/** Dedupe an iterable of int keys into a fresh Int32Array (a SET, matching the static
 *  members' own dedupe). Insertion order is preserved (deterministic). Cold. */
function dedupeInt(keys) {
    const set = new Set();
    for (let i = 0; i < keys.length; i++) set.add(keys[i] | 0);
    const out = new Int32Array(set.size);
    let i = 0;
    for (const k of set) out[i++] = k;
    return out;
}

/**
 * Build a visualization engine over ONE shared workload: an add-set (deduped to a SET)
 * and a DISJOINT probe-set (the false-positive oracle). Constructs all seven members
 * once: the five mutable members empty (filled during the BUILD phase), the two static
 * members built ONCE from the whole deduped add-set via .from().
 *
 * @param {{ keys:number[], probes:number[], fpp?:number, seed?:number,
 *           kind?:string, n?:number }} spec
 */
export function createEngine(spec) {
    if (spec === null || typeof spec !== 'object') {
        throw new TypeError('[demo] engine spec must be an object');
    }
    if (!Array.isArray(spec.keys) && !ArrayBuffer.isView(spec.keys)) {
        throw new TypeError('[demo] engine spec.keys must be an array of int keys');
    }
    if (!Array.isArray(spec.probes) && !ArrayBuffer.isView(spec.probes)) {
        throw new TypeError('[demo] engine spec.probes must be an array of int probes');
    }
    const fpp = spec.fpp === undefined ? 0.01 : spec.fpp;
    if (typeof fpp !== 'number' || !(fpp > 0) || !(fpp < 1)) {
        throw new RangeError('[demo] engine spec.fpp must be a number in (0, 1), got ' + String(fpp));
    }
    const seed = spec.seed === undefined ? 0x9e3779b9 : (spec.seed >>> 0);

    const addKeys = dedupeInt(spec.keys);
    if (addKeys.length < 1) {
        // Static members are undefined over zero keys (null is not zero); fail closed.
        throw new RangeError('[demo] engine needs a non-empty add-set (static members are undefined over zero keys)');
    }
    const probeKeys = new Int32Array(spec.probes.length);
    for (let i = 0; i < spec.probes.length; i++) probeKeys[i] = spec.probes[i] | 0;

    // Capacity is the distinct add count. Power-of-two rounding inside the members'
    // sizing gives comfortable load headroom, so no add on the hot path ever throws.
    const cap = addKeys.length;
    const opts = { fpp, seed, keys: 'int', stats: true };

    const all = new Array(MEMBER_NAMES.length);
    for (let i = 0; i < MEMBER_DEFS.length; i++) {
        const d = MEMBER_DEFS[i];
        if (d.isStatic) {
            all[i] = d.ctor.from(addKeys, opts);   // built ONCE from the whole SET
        } else {
            all[i] = new d.ctor(cap, opts);         // empty; filled during BUILD
        }
    }

    // The per-step cursor + counters, all preallocated so step() allocates NOTHING.
    //   cur[0]=buildIdx  cur[1]=probeIdx  cur[2]=phase  cur[3]=lastKey  cur[4]=lastOp
    const cur = new Int32Array(5);
    cur[2] = PHASE_BUILD;
    cur[4] = OP_NONE;

    // FN is measured ONCE, lazily, at the first PROBE-phase render (the add-set is fixed
    // after BUILD, so it cannot change). -1 means "not yet measured".
    const fnCount = new Int32Array(MEMBER_NAMES.length);
    fnCount.fill(-1);

    return {
        kind: spec.kind === undefined ? 'custom' : spec.kind,
        seed,
        fpp,
        cap,
        addKeys,
        probeKeys,
        all,
        cur,
        fpCount: new Int32Array(MEMBER_NAMES.length),   // false positives seen in PROBE
        lastVerdict: new Int32Array(MEMBER_NAMES.length), // last probe result per member
        fnCount,
        builtStatic: false,
    };
}

/**
 * Apply the next op to the engine and advance. HOT BODY -- one add (BUILD) or one probe
 * (PROBE) across the fixed member array, using only the preallocated cursor + counter
 * views. Zero allocation, zero closures, no dump(). Returns false when both phases are
 * exhausted.
 */
export function step(engine) {
    const cur = engine.cur;
    const all = engine.all;
    if (cur[2] === PHASE_BUILD) {
        const bi = cur[0];
        const keys = engine.addKeys;
        if (bi < keys.length) {
            const k = keys[bi];
            for (let i = 0; i < MUTABLE_COUNT; i++) all[i].add(k);
            cur[0] = bi + 1;
            cur[3] = k;
            cur[4] = OP_ADD;
            if (bi + 1 >= keys.length) { cur[2] = PHASE_PROBE; engine.builtStatic = true; }
            return true;
        }
        cur[2] = PHASE_PROBE;
        engine.builtStatic = true;
    }
    const pi = cur[1];
    const probes = engine.probeKeys;
    if (pi < probes.length) {
        const k = probes[pi];
        const fp = engine.fpCount;
        const lv = engine.lastVerdict;
        const n = all.length;
        for (let i = 0; i < n; i++) {
            const hit = all[i].mightContain(k) ? 1 : 0;
            lv[i] = hit;
            fp[i] += hit;   // every probe is a known non-member -> a hit IS a false positive
        }
        cur[1] = pi + 1;
        cur[3] = k;
        cur[4] = OP_PROBE;
        return true;
    }
    return false;
}

/** Run BUILD + PROBE to completion (headless). Returns the total step count. */
export function runToEnd(engine) {
    let n = 0;
    while (step(engine)) n++;
    return n;
}

/**
 * The current frame the renderers consume: engine phase state + each member's LIVE
 * dump() snapshot. The snapshot IS the render model -- no field is added to it. dump()
 * is COLD and MAY allocate; this is a render-time call, not a hot-path step. The
 * "building..." signal for the static members is carried here as `builtStatic` (engine
 * state), NEVER as a dump field.
 */
export function frameModel(engine) {
    const members = {};
    const verdict = {};
    const all = engine.all;
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        members[name] = all[i].dump();
        verdict[name] = engine.lastVerdict[i];
    }
    return {
        phase: engine.cur[2],
        buildIdx: engine.cur[0],
        probeIdx: engine.cur[1],
        buildTotal: engine.addKeys.length,
        probeTotal: engine.probeKeys.length,
        lastKey: engine.cur[3],
        lastOp: engine.cur[4],
        builtStatic: engine.builtStatic,
        members,
        verdict,
    };
}

/**
 * Per-member honesty summary. COLD (recomputed from the full arrays, so it is correct
 * regardless of how far the run has stepped and is fully deterministic for a given
 * spec). For each member:
 *   - measFpr    measured false-positive rate over the DISJOINT probe oracle
 *   - theoFpr    the member's own closed-form estimate (member.fpp())
 *   - bitsPerItem the real store cost per distinct item (memBits / count)
 *   - bound      the information-theoretic space floor log2(1/fpp) bits/item
 *   - overOptimalPct  100 * (bitsPerItem / bound - 1) -- % over the space floor
 *   - overTheoryPct   100 * (measFpr - theoFpr) / theoFpr -- the headline honesty axis
 *   - fn         false negatives over every distinct added key (MUST be 0 -- one-sided)
 */
export function summary(engine) {
    const out = [];
    const all = engine.all;
    const probes = engine.probeKeys;
    const keys = engine.addKeys;
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const inst = all[i];
        const snap = inst.dump();
        const distinct = snap.count;

        let fpAcc = 0;
        for (let j = 0; j < probes.length; j++) if (inst.mightContain(probes[j])) fpAcc++;
        const measFpr = probes.length ? fpAcc / probes.length : 0;

        let fn = 0;
        for (let j = 0; j < keys.length; j++) if (!inst.mightContain(keys[j])) fn++;

        const theoFpr = inst.fpp();
        const bitsPerItem = distinct ? memBits(snap) / distinct : 0;
        const bound = Math.log2(1 / snap.fpp);
        // Fail closed: a zero/undefined bound is not a 0% overhead, it is "unknown".
        const overOptimalPct = bound > 0 ? 100 * (bitsPerItem / bound - 1) : 0;
        const overTheoryPct = theoFpr > 0 ? (100 * (measFpr - theoFpr)) / theoFpr : 0;

        out.push({
            name: MEMBER_NAMES[i],
            distinct,
            bitsPerItem,
            bound,
            overOptimalPct,
            measFpr,
            theoFpr,
            overTheoryPct,
            fn,
        });
    }
    return out;
}

/**
 * A CHEAP render-time summary for the animation loop. Unlike `summary()` (the
 * authoritative, always-correct recompute the tests use), this REUSES the counts the
 * hot path already accumulated: `measFpr` comes from `engine.fpCount / probeIdx` (no
 * re-probe of the up-to-50k probe-set every redraw), `bitsPerItem` reads the dump
 * snapshots already captured in `frame` (no second dump), and `fn` is measured ONCE at
 * the first PROBE render and cached (the add-set is fixed after BUILD, so it cannot
 * change) -- reported as -1 while still building. Call `summary()` when you need the
 * authoritative false-positive count.
 *
 * @param {object} engine
 * @param {object} frame  the frame from frameModel(engine) (its dumps are reused)
 */
export function renderSummary(engine, frame) {
    // One-time authoritative FN sweep, lazily, when PROBE begins. mightContain is
    // zero-alloc and fnCount is preallocated, so this is a single O(n*7) cold pass.
    if (engine.cur[2] === PHASE_PROBE && engine.fnCount[0] === -1) {
        const keys = engine.addKeys;
        for (let i = 0; i < MEMBER_NAMES.length; i++) {
            const inst = engine.all[i];
            let fn = 0;
            for (let j = 0; j < keys.length; j++) if (!inst.mightContain(keys[j])) fn++;
            engine.fnCount[i] = fn;
        }
    }
    const probed = engine.cur[1];
    const out = [];
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        const snap = frame.members[name];
        const distinct = snap.count;
        const measFpr = probed > 0 ? engine.fpCount[i] / probed : 0;
        const theoFpr = engine.all[i].fpp();
        const bitsPerItem = distinct ? memBits(snap) / distinct : 0;
        const bound = Math.log2(1 / snap.fpp);
        const overOptimalPct = bound > 0 ? 100 * (bitsPerItem / bound - 1) : 0;
        const overTheoryPct = theoFpr > 0 ? (100 * (measFpr - theoFpr)) / theoFpr : 0;
        out.push({
            name, distinct, bitsPerItem, bound, overOptimalPct,
            measFpr, theoFpr, overTheoryPct, fn: engine.fnCount[i],
        });
    }
    return out;
}

/* -------------------------------------------------------------------------- *
 * Workload loading (browser). The /workload.json route is DYNAMIC (computed by
 * demo/serve.mjs), so it exists ONLY under the Node server. Opened as a static file,
 * via an IDE static preview, or with the server down, the fetch REJECTS or returns a
 * non-OK status. We fail CLOSED with an actionable, dependency-free message instead of
 * hanging on "loading...".
 * -------------------------------------------------------------------------- */

/** The actionable message shown when /workload.json cannot be loaded. ASCII-only. */
export const WORKLOAD_SERVER_HINT =
    'This demo needs its Node server. Run  npm run demo:serve  and open  ' +
    'http://localhost:8017/  (a static file or IDE preview will not work: ' +
    '/workload.json is a dynamic route).';

/**
 * Fetch a workload payload, failing CLOSED. Never throws. Returns `{ ok:true, data }`
 * on a 2xx JSON body of the right shape, or `{ ok:false, message }` on a rejected
 * fetch, a non-OK status, a server-reported `{ error }` body, or a malformed payload.
 * `fetchImpl` defaults to the global `fetch` so a test can inject a stub.
 *
 * @param {string} url
 * @param {(url:string)=>Promise<any>} [fetchImpl]
 * @returns {Promise<{ok:true,data:any}|{ok:false,message:string}>}
 */
export async function fetchWorkload(url, fetchImpl) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (f === null) return { ok: false, message: WORKLOAD_SERVER_HINT + '  [no fetch available]' };
    try {
        const resp = await f(url);
        if (!resp || !resp.ok) throw new Error('server ' + (resp ? resp.status : 'unreachable'));
        const data = await resp.json();
        if (data && data.error) throw new Error(data.error);
        // Fail closed on a well-formed 200 whose BODY is the wrong shape: ok:true must
        // guarantee createEngine can consume it (arrays keys + probes, an fpp in (0,1)).
        if (data === null || typeof data !== 'object' ||
            !Array.isArray(data.keys) || data.keys.length < 1 ||
            !Array.isArray(data.probes) ||
            typeof data.fpp !== 'number' || !(data.fpp > 0) || !(data.fpp < 1)) {
            return { ok: false, message: WORKLOAD_SERVER_HINT + '  [malformed workload payload]' };
        }
        return { ok: true, data };
    } catch (err) {
        const detail = err && err.message ? String(err.message) : String(err);
        return { ok: false, message: WORKLOAD_SERVER_HINT + '  [' + detail + ']' };
    }
}

/* -------------------------------------------------------------------------- *
 * Node-main: npm run demo. DYNAMICALLY imports Bench.mjs + node:url so the browser
 * (which has no `process`) never touches the node:url path.
 * -------------------------------------------------------------------------- */

async function main() {
    const { pathToFileURL } = await import('node:url');
    if (!process.argv[1] || import.meta.url !== pathToFileURL(process.argv[1]).href) return;

    const bench = await import('../benchmark/Bench.mjs');

    // Defaults: a uniform workload at 1% fpp. Overridable:
    //   node demo/Visualize.mjs <kind> <n> <fpp> <seed>
    const kind = process.argv[2] || 'uniform';
    const n = Number(process.argv[3]) || 5000;
    const fpp = Number(process.argv[4]) || 0.01;
    const seed = Number(process.argv[5]) || 0x9e3779b9;
    const probeCount = Math.max(4 * n, 20000);

    const gen = pickGen(bench, kind);
    const { keys, probes } = gen(n, probeCount, seed);
    const engine = createEngine({ keys, probes, fpp, seed, kind, n });
    runToEnd(engine);

    const rows = summary(engine);
    const line = (s) => process.stdout.write(s + '\n');
    line('@zakkster/lite-filter demo  (dump()-driven visualization engine, headless)');
    line('kind=' + kind + '  n=' + n + '  distinct=' + engine.addKeys.length +
        '  probes=' + probes.length + '  fpp=' + fpp + '  seed=0x' + (seed >>> 0).toString(16));
    line('space floor log2(1/fpp) = ' + Math.log2(1 / fpp).toFixed(2) + ' bits/item');
    line('');
    line(pad('member', 14) + padLeft('bits/it', 9) + padLeft('%over', 8) +
        padLeft('measFPR', 10) + padLeft('theoFPR', 10) + padLeft('%vsTheo', 9) + padLeft('FN', 5));
    line('-'.repeat(65));
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        line(pad(r.name, 14) +
            padLeft(r.bitsPerItem.toFixed(2), 9) +
            padLeft(r.overOptimalPct.toFixed(0) + '%', 8) +
            padLeft(r.measFpr.toFixed(5), 10) +
            padLeft(r.theoFpr.toFixed(5), 10) +
            padLeft(r.overTheoryPct.toFixed(0) + '%', 9) +
            padLeft(String(r.fn), 5));
    }
}

/** Pick a Bench.mjs generator by kind, failing closed on an unknown kind. Node-only. */
function pickGen(bench, kind) {
    if (kind === 'uniform') return bench.uniform;
    if (kind === 'zipfian') return bench.zipfian;
    if (kind === 'sequential') return bench.sequential;
    if (kind === 'adversarial') return bench.adversarial;
    throw new Error('[demo] unknown workload kind ' + String(kind) + ' (uniform|zipfian|sequential|adversarial)');
}

function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padLeft(s, w) { s = String(s); return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

if (typeof process !== 'undefined' && process.argv) {
    main();
}
