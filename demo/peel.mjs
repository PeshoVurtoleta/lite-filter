// @zakkster/lite-filter -- peel re-derivation for the two STATIC members (repo-only).
//
//   node demo/peel.mjs            (headless construction dump + full-n faithfulness proof)
//
// Session B of the demo: the CONSTRUCTION animation for XorFilter and BinaryFuse. The
// shipped peel (Filter.js `_xorTryBuild` / `_bfTryBuild`) builds a LOCAL peel stack and
// DISCARDS it -- `dump()` keeps only the finished fingerprint array + geometry, and the
// hash primitives are module-private and unexported. So this animation cannot read a real
// instance's peel order: it must FAITHFULLY RE-DERIVE the construction here, byte-for-byte
// against Filter.js's own primitives, and PROVE the re-derivation reproduces the shipped
// filter EXACTLY. That proof (`verifyAgainstShipped`) is the whole point -- an animation
// that showed a peel order the filter never used would be a lie.
//
// To reproduce the shipped fingerprints exactly this file mirrors, verbatim:
//   - fmix32          (Filter.js ~462) the murmur3 finalizer / int-key mixer
//   - mulhiU32        (Filter.js ~479) Lemire multiply-shift, the BF segment-base selector
//   - the int-key h/g/t derivation used in _xorTryBuild / _bfTryBuild
//   - the XOR geometry (bl from _xorGuard ~742) + its 3-disjoint-segment slot triple
//   - the BinaryFuse geometry (_bfDims ~773) + its overlapping-segment slot triple with
//     within-segment perturbation
//   - the fingerprint width fw from fpp (_xorSizeError ~725)
//   - the reseed rule seed ^ (attempt * 0x9e3779b1) via Math.imul, up to 100 attempts
//   - the reverse-peel assignment order
//
// It imports the PUBLIC surface of ../Filter.js ONLY to VERIFY the re-derivation (call
// Member.from(...).dump().fp and compare). It never reads a private field. Browser-safe
// (Filter.js is pure ESM); the Node-main block is guarded by `typeof process`.
//
// Repo-only dev artifact; NEVER shipped in the npm tarball.

import { XorFilter, BinaryFuse } from '../Filter.js';

/* ----------------------------- primitives -------------------------------- *
 * Byte-for-byte copies of Filter.js's private hash primitives. If either drifts from the
 * shipped version, verifyAgainstShipped() fails closed and the demo throws.
 * -------------------------------------------------------------------------- */

/** murmur3 fmix32 -- EXACT copy of Filter.js ~462. Returns an unsigned 32-bit int. */
function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/** High 32 bits of the 32x32 product -- EXACT copy of Filter.js `mulhiU32` ~479 (Lemire
 *  multiply-shift). Four 16x16 partials so no intermediate exceeds 2^53. */
function mulhiU32(a, b) {
    const ah = a >>> 16, al = a & 0xffff;
    const bh = b >>> 16, bl = b & 0xffff;
    const albl = al * bl;
    const albh = al * bh;
    const ahbl = ah * bl;
    const ahbh = ah * bh;
    const carry = ((albl >>> 16) + (albh & 0xffff) + (ahbl & 0xffff)) >>> 16;
    return (ahbh + (albh >>> 16) + (ahbl >>> 16) + carry) >>> 0;
}

/* ------------------------------ constants -------------------------------- *
 * Mirrors of the Filter.js constants the peel depends on (decisions/0018, 0020, 0022).
 * -------------------------------------------------------------------------- */

/** The demo default seed. Matches Visualize.mjs's engine default (0x9e3779b9), which is
 *  the seed the engine passes to the static members' .from(). */
export const PEEL_SEED = 0x9e3779b9;

/** The demo default fpp -- the textbook 1% baseline (an 8-bit fingerprint). */
export const PEEL_FPP = 0.01;

/** The animated instance is its OWN small 48-key filter: small enough that the 3-uniform
 *  hypergraph is legible, and separately faithfulness-proven. Full-n (n=2000) is proven in
 *  the tests but not animated. */
export const PEEL_N = 48;

/** The deterministic reseed multiplier, `seed ^ (attempt * 0x9e3779b1)` (Filter.js ~3266,
 *  ~3625). Applied with Math.imul (an exact 32-bit multiply). */
const RESEED_MUL = 0x9e3779b1;

/** The second-seed-word XOR constant, `seed2 = fmix32(seed ^ 0x9e3779b9)` (Filter.js
 *  ~3267, ~3626). NOTE: distinct from RESEED_MUL despite the near-identical hex. */
const SEED2_XOR = 0x9e3779b9;

/** The `g` mixer multiplier for int keys (Filter.js _xorTryBuild ~931 / _bfTryBuild
 *  ~1046). Again 0x9e3779b1 -- the same value as RESEED_MUL, a coincidence of the golden
 *  ratio prime; kept as its own named const so the two roles never blur. */
const G_MUL = 0x9e3779b1;

/** Reseed cap, `XOR_MAX_ATTEMPTS` / `BF_MAX_ATTEMPTS` (both 100, Filter.js ~295, ~401). */
const MAX_ATTEMPTS = 100;

/** XOR fingerprint-width doors, `XOR_FP8_FPP` / `XOR_FP16_FPP` (Filter.js ~300, ~305). */
const FP8_FPP = 0.00390625;
const FP16_FPP = 0.0000152587890625;

/**
 * Fingerprint width in bits for a target fpp -- EXACT mirror of `_xorSizeError` (Filter.js
 * ~725), reused by both static members. Fails closed outside (0, 1) and below the 16-bit
 * floor (null is not zero). Returns 8 or 16.
 */
function xorFw(fpp) {
    if (typeof fpp !== 'number' || !(fpp > 0) || !(fpp < 1)) {
        throw new RangeError('[demo] fpp must be a number in the open interval (0, 1), got ' + String(fpp));
    }
    if (fpp >= FP8_FPP) return 8;
    if (fpp >= FP16_FPP) return 16;
    throw new RangeError('[demo] fpp below the 16-bit fingerprint floor (2^-16); the static members cap there');
}

/**
 * Validate + normalize the optional seed -- EXACT mirror of Filter.js `validateSeed`
 * (~1125). Guards `typeof` BEFORE any coercion: `seed >>> 0` on a Symbol or BigInt throws
 * a raw engine TypeError, so a PRESENT non-finite-number seed is rejected with an
 * actionable `[demo]` message (built with String(), the only concat safe on Symbol AND
 * BigInt). An ABSENT seed uses the demo default (null is not zero). Returns a u32.
 */
function validateSeed(seed) {
    if (seed === undefined) return PEEL_SEED >>> 0;
    if (typeof seed !== 'number' || !Number.isFinite(seed)) {
        throw new TypeError('[demo] seed must be a finite number, got ' + String(seed));
    }
    return seed >>> 0;
}

/* ------------------------------ geometry --------------------------------- *
 * GEOM_XOR and GEOM_BF differ in ONLY the slot-triple function (and the derived
 * dims/layout). peelCore is shared. Each geom exposes:
 *   dims(n)          the store geometry { m, ... } (mirrors _xorGuard / _bfDims)
 *   layout(dims)     { rows, cols } for the renderer's grid (m === rows*cols)
 *   slots(h,g,t,d)   the three ABSOLUTE slot positions for one edge
 * -------------------------------------------------------------------------- */

/** XOR geometry (decisions/0018, 0020). Three DISJOINT segments of length bl; the store is
 *  3*bl. `bl = ceil(1.23*n/3) + 32` mirrors `_xorGuard` (Filter.js ~742). */
export const GEOM_XOR = Object.freeze({
    name: 'Xor',
    dims(n) {
        const bl = Math.ceil((1.23 * n) / 3) + 32;
        return { bl: bl, m: 3 * bl };
    },
    layout(d) {
        return { rows: 3, cols: d.bl };
    },
    // h -> [h0 in seg0, bl+h1 in seg1, 2bl+h2 in seg2] (Filter.js _xorTryBuild ~937-939).
    slots(h, g, t, d) {
        const bl = d.bl;
        return [h % bl, bl + (g % bl), 2 * bl + (t % bl)];
    },
});

/** Binary Fuse geometry (decisions/0022). One array of (segCount+2) OVERLAPPING segments,
 *  each segLen long; the store is (segCount+2)*segLen. Mirrors `_bfDims` (Filter.js ~773). */
export const GEOM_BF = Object.freeze({
    name: 'BinaryFuse',
    dims(n) {
        let segLen = 1 << Math.floor(Math.log(n) / Math.log(3.33) + 2.25);
        if (segLen > 262144) segLen = 262144;
        if (segLen < 4) segLen = 4;
        let segCount;
        if (n <= 1) {
            segCount = 1;
        } else {
            const sizeFactor = Math.max(1.125, 0.875 + 0.25 * Math.log(1000000) / Math.log(n));
            const capacity = Math.round(n * sizeFactor);
            const initSegmentCount = Math.ceil(capacity / segLen) - 2;
            segCount = initSegmentCount < 1 ? 1 : initSegmentCount;
        }
        const arrayLen = (segCount + 2) * segLen;
        const scl = segCount * segLen;
        return { segLen: segLen, segMask: segLen - 1, segCount: segCount, scl: scl, m: arrayLen };
    },
    layout(d) {
        return { rows: d.segCount + 2, cols: d.segLen };
    },
    // mulhiU32(h, scl) base; the other two are one/two segments further, each perturbed
    // within its segment by ^(g & segMask) / ^(t & segMask) (Filter.js _bfTryBuild ~1052-1055).
    slots(h, g, t, d) {
        const segLen = d.segLen, segMask = d.segMask;
        const hi = mulhiU32(h, d.scl);
        return [hi, (hi + segLen) ^ (g & segMask), (hi + 2 * segLen) ^ (t & segMask)];
    },
});

/* -------------------------------- peel ----------------------------------- */

/**
 * ONE peeling attempt over a fixed (keys, geom, dims). Mirrors `_xorTryBuild` /
 * `_bfTryBuild` (Filter.js ~914 / ~1022) exactly: build the 3-uniform hypergraph incidence,
 * peel degree-1 vertices onto a stack (a plain-array LIFO with the stale-entry guard), and
 * -- ONLY on a COMPLETE peel (`sp === n`) -- reverse-assign so each key's three slots XOR to
 * its fingerprint. Returns null on a short stack (a 2-core survived); it NEVER assigns from
 * a partial stack, which is the fail-OPEN the shipped code guards against.
 *
 * `dims` carries the geometry (m + geom params) PLUS the per-attempt {seed, seed2, fw,
 * attempt, withFrames}. When withFrames is true it also emits a renderer-consumable frame
 * sequence (graph -> peel* -> assign*); when false it skips that (used for the full-n proof
 * where only the fingerprint array matters).
 *
 * @returns {{ fp:number[], sp:number, frames:ReadonlyArray }|null}
 */
export function peelCore(keys, geom, dims) {
    const n = keys.length;
    const m = dims.m;
    const seed = dims.seed >>> 0;
    const seed2 = dims.seed2 >>> 0;
    const fw = dims.fw;
    const fpMask = (1 << fw) - 1;
    const withFrames = dims.withFrames !== false;

    // Per-edge geometry: the three ABSOLUTE slot positions and the fingerprint, with the
    // int-key h/g/t derivation copied verbatim from _xorTryBuild / _bfTryBuild.
    const eh0 = new Uint32Array(n);
    const eh1 = new Uint32Array(n);
    const eh2 = new Uint32Array(n);
    const efp = new Uint16Array(n);
    for (let e = 0; e < n; e++) {
        const k = keys[e];
        // Guard the key TYPE before any coercion: `k | 0` on a Symbol or BigInt throws a
        // raw, non-actionable engine TypeError ("Cannot convert a Symbol value to a number"
        // / "Cannot mix BigInt..."). Gate on `typeof` so those fail closed with an
        // actionable [demo] message (String(k) is the only concat safe on Symbol AND
        // BigInt). A NaN key is a Number: it coerces silently (NaN | 0 === 0), matching the
        // shipped `| 0` mixing, and the live faithfulness check (Filter.js's own
        // Number.isInteger door) is the backstop that rejects it in frameModel. -0 is a
        // legitimate integer key (same slot as 0) and passes.
        if (typeof k !== 'number') {
            throw new TypeError('[demo] peel key must be a number, got ' + (typeof k) + ' ' +
                String(k) + ' (a Symbol or BigInt cannot be coerced to an int slot)');
        }
        const key = k | 0;
        const h = fmix32((key ^ seed) | 0);
        const g = fmix32((Math.imul(key | 0, G_MUL) ^ seed2) | 0);
        const t = fmix32((h ^ g) | 0);
        const s = geom.slots(h, g, t, dims);
        eh0[e] = s[0];
        eh1[e] = s[1];
        eh2[e] = s[2];
        efp[e] = fmix32((h + g) | 0) & fpMask;
    }

    // Incidence: per-vertex edge COUNT and XOR-of-edge-indices (the peeling trick).
    const tcount = new Uint32Array(m);
    const txor = new Uint32Array(m);
    for (let e = 0; e < n; e++) {
        let v = eh0[e]; tcount[v]++; txor[v] ^= e;
        v = eh1[e]; tcount[v]++; txor[v] ^= e;
        v = eh2[e]; tcount[v]++; txor[v] ^= e;
    }

    // The renderer-consumable frame sequence. `edges` is the constant incidence, shared by
    // reference across every frame (frozen -> safe to share); `deg`/`lit` are per-frame
    // frozen snapshots. `ZERO` is the shared all-zero vector (peel-stage lit / assign-stage
    // deg).
    const frames = [];
    let edges = null;
    let ZERO = null;
    if (withFrames) {
        const es = new Array(n);
        for (let e = 0; e < n; e++) {
            es[e] = Object.freeze({ slots: Object.freeze([eh0[e], eh1[e], eh2[e]]), fp: efp[e] });
        }
        edges = Object.freeze(es);
        ZERO = Object.freeze(new Array(m).fill(0));
        frames.push(Object.freeze({
            stage: 'graph', edges: edges, deg: Object.freeze(Array.from(tcount)),
            stackTop: 0, lit: ZERO, attempt: dims.attempt, cursor: null,
        }));
    }

    // Peel: LIFO plain-array queue, initial degree-1 vertices pushed in ASCENDING order,
    // the `tcount[v] !== 1` guard dropping stale entries -- byte-identical to the shipped
    // discipline, so the peel ORDER (and thus the reverse-assign, and thus the fp) matches.
    const stackV = new Uint32Array(n);
    const stackE = new Uint32Array(n);
    let sp = 0;
    const queue = [];
    for (let v = 0; v < m; v++) if (tcount[v] === 1) queue.push(v);
    while (queue.length > 0) {
        const v = queue.pop();
        if (tcount[v] !== 1) continue;
        const e = txor[v];
        stackV[sp] = v;
        stackE[sp] = e;
        sp++;
        let p = eh0[e]; tcount[p]--; txor[p] ^= e; if (tcount[p] === 1) queue.push(p);
        p = eh1[e]; tcount[p]--; txor[p] ^= e; if (tcount[p] === 1) queue.push(p);
        p = eh2[e]; tcount[p]--; txor[p] ^= e; if (tcount[p] === 1) queue.push(p);
        if (withFrames) {
            frames.push(Object.freeze({
                stage: 'peel', edges: edges, deg: Object.freeze(Array.from(tcount)),
                stackTop: sp, lit: ZERO, attempt: dims.attempt,
                cursor: Object.freeze({ v: v, e: e }),
            }));
        }
    }

    // FAIL-OPEN GUARD: a short stack means a 2-core survived. Do NOT assign; return null so
    // derivePeel reseeds (or throws on exhaustion). This mirrors the single line that stands
    // between a partial peel and a fail-OPEN filter with silent false negatives.
    if (sp !== n) return null;

    // Assign in REVERSE peel order: fp[v] = efp ^ fp[a] ^ fp[b] ^ fp[c].
    const arr = fw <= 8 ? new Uint8Array(m) : new Uint16Array(m);
    const litArr = withFrames ? new Array(m).fill(0) : null;
    for (let i = sp - 1; i >= 0; i--) {
        const e = stackE[i];
        const v = stackV[i];
        arr[v] = (efp[e] ^ arr[eh0[e]] ^ arr[eh1[e]] ^ arr[eh2[e]]) & fpMask;
        if (withFrames) {
            litArr[v] = 1;
            frames.push(Object.freeze({
                stage: 'assign', edges: edges, deg: ZERO,
                stackTop: n, lit: Object.freeze(litArr.slice()), attempt: dims.attempt,
                cursor: Object.freeze({ v: v, e: e }),
            }));
        }
    }
    return { fp: Array.from(arr), sp: sp, frames: Object.freeze(frames) };
}

/**
 * Re-derive the peel for one static member under (keys, fpp, seed), reseeding
 * deterministically `seed ^ (attempt * 0x9e3779b1)` up to 100 times exactly as the shipped
 * factories do, and THROWING an actionable `[demo]` message on exhaustion (never a partial
 * build -- fail closed). Returns `{ attempt, fp, frames }` for the SAME successful attempt
 * Filter.js would pick, so `fp` deep-equals the shipped `dump().fp`.
 *
 * @param {{ keys:number[], fpp?:number, seed?:number, member:'Xor'|'BinaryFuse',
 *           withFrames?:boolean, geom?:object }} opts
 *   `geom` is an internal test hook: a pathological geometry that never peels, used to
 *   exercise the exhaustion throw. Production callers omit it.
 */
export function derivePeel(opts) {
    if (opts === null || typeof opts !== 'object') {
        throw new TypeError('[demo] derivePeel(opts): opts must be an object');
    }
    const keys = opts.keys;
    if (!Array.isArray(keys) && !ArrayBuffer.isView(keys)) {
        throw new TypeError('[demo] derivePeel: opts.keys must be an array of int keys');
    }
    const member = opts.member;
    const geom = opts.geom || (member === 'Xor' ? GEOM_XOR : member === 'BinaryFuse' ? GEOM_BF : null);
    if (geom === null) {
        throw new Error("[demo] derivePeel: unknown member " + String(member) + " (expected 'Xor' or 'BinaryFuse')");
    }
    const fpp = opts.fpp === undefined ? PEEL_FPP : opts.fpp;
    const seed = validateSeed(opts.seed);
    const withFrames = opts.withFrames !== false;
    const fw = xorFw(fpp);
    const n = keys.length;
    if (n < 1) {
        throw new RangeError('[demo] derivePeel: keys must be non-empty (a static filter over 0 keys is undefined)');
    }
    const baseGeom = geom.dims(n);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const trySeed = (seed ^ Math.imul(attempt, RESEED_MUL)) >>> 0;
        const trySeed2 = fmix32(trySeed ^ SEED2_XOR);
        const dims = {
            bl: baseGeom.bl, m: baseGeom.m,
            segLen: baseGeom.segLen, segMask: baseGeom.segMask,
            segCount: baseGeom.segCount, scl: baseGeom.scl,
            seed: trySeed, seed2: trySeed2, fw: fw, attempt: attempt, withFrames: withFrames,
        };
        const built = peelCore(keys, geom, dims);
        if (built !== null) {
            return { attempt: attempt, fp: built.fp, frames: built.frames };
        }
    }
    throw new Error('[demo] derivePeel: ' + geom.name + ' peel exhausted ' + MAX_ATTEMPTS +
        ' deterministic reseeds over ' + n + ' keys -- degenerate key set (fail closed, never a partial build)');
}

/* --------------------------- faithfulness -------------------------------- */

/** The shipped fingerprint array for (keys, fpp, seed, member), via the PUBLIC surface
 *  only. `opts` matches the demo engine's construction: `{ fpp, seed, keys:'int',
 *  stats:true }`. Returns `dump().fp` (a plain Array). */
export function shippedFp(keys, fpp, seed, member) {
    const opts = { fpp: fpp, seed: seed >>> 0, keys: 'int', stats: true };
    const inst = member === 'Xor' ? XorFilter.from(keys, opts)
        : member === 'BinaryFuse' ? BinaryFuse.from(keys, opts)
            : null;
    if (inst === null) {
        throw new Error("[demo] shippedFp: unknown member " + String(member));
    }
    return inst.dump().fp;
}

/** Prove the re-derivation reproduces the shipped filter EXACTLY. Throws a `[demo]`
 *  message on ANY divergence (a length mismatch or a single differing word) -- fail closed,
 *  never an animation of a peel the filter never used. Returns true on an exact match. */
function verifyAgainstShipped(keys, fpp, seed, member, derived) {
    const shipped = shippedFp(keys, fpp, seed, member);
    if (shipped.length !== derived.fp.length) {
        throw new Error('[demo] faithfulness FAILED: ' + member + ' re-derived fp length ' +
            derived.fp.length + ' != shipped ' + shipped.length);
    }
    for (let i = 0; i < shipped.length; i++) {
        if (shipped[i] !== derived.fp[i]) {
            throw new Error('[demo] faithfulness FAILED: ' + member + ' fp[' + i + '] re-derived ' +
                derived.fp[i] + ' != shipped ' + shipped[i] + ' -- a primitive drifted from Filter.js');
        }
    }
    return true;
}

/** The default legible 48-key set: sequential 0..n-1 (distinct, so the dedupe order the
 *  static factories apply is exactly this order -- the peel edge-indexing lines up). */
export function demoKeys(n) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = i;
    return a;
}

/**
 * The renderer-consumable, FROZEN construction model for one static member: re-derives the
 * peel, VERIFIES it live against the shipped fingerprints (throws on any divergence -- fail
 * closed), and packages the frame sequence with layout metadata. The renderer reads
 * `verified`, `layout`, and `frames` and needs no imports.
 *
 * @param {{ member:'Xor'|'BinaryFuse', n?:number, fpp?:number, seed?:number,
 *           keys?:number[] }} opts
 */
export function frameModel(opts) {
    const o = opts || {};
    const member = o.member;
    if (member !== 'Xor' && member !== 'BinaryFuse') {
        throw new Error("[demo] frameModel: unknown member " + String(member) + " (expected 'Xor' or 'BinaryFuse')");
    }
    const fpp = o.fpp === undefined ? PEEL_FPP : o.fpp;
    const seed = validateSeed(o.seed);
    // Guard n's TYPE before `| 0` (same coercion footgun: `Symbol() | 0` throws raw). Only
    // a PRESENT non-number n rejects; absent uses the default. String() is Symbol/BigInt-safe.
    if (o.n !== undefined && typeof o.n !== 'number') {
        throw new TypeError('[demo] frameModel: n must be a number, got ' + (typeof o.n) + ' ' + String(o.n));
    }
    const nReq = o.n === undefined ? PEEL_N : (o.n | 0);
    const keys = o.keys === undefined ? demoKeys(nReq) : o.keys;
    const geom = member === 'Xor' ? GEOM_XOR : GEOM_BF;

    const derived = derivePeel({ keys: keys, fpp: fpp, seed: seed, member: member, withFrames: true });
    // Live faithfulness proof: throws (fail closed) unless the re-derivation is byte-exact.
    const verified = verifyAgainstShipped(keys, fpp, seed, member, derived);

    const dims = geom.dims(keys.length);
    const lay = geom.layout(dims);
    return Object.freeze({
        member: member,
        n: keys.length,
        fpp: fpp,
        seed: seed,
        attempt: derived.attempt,
        verified: verified,
        m: dims.m,
        layout: Object.freeze({ rows: lay.rows, cols: lay.cols }),
        frames: derived.frames,
    });
}

/* -------------------------------------------------------------------------- *
 * Node-main: node demo/peel.mjs. Headless construction dump + full-n proof.
 * -------------------------------------------------------------------------- */

async function main() {
    const { pathToFileURL } = await import('node:url');
    if (!process.argv[1] || import.meta.url !== pathToFileURL(process.argv[1]).href) return;

    const line = (s) => process.stdout.write(s + '\n');
    line('@zakkster/lite-filter demo -- peel re-derivation (static members)');
    line('seed=0x' + (PEEL_SEED >>> 0).toString(16) + '  fpp=' + PEEL_FPP);
    line('');

    // Animated instances (n=48): build the model (which verifies live) and report.
    line('animated instance (n=' + PEEL_N + '):');
    for (const member of ['Xor', 'BinaryFuse']) {
        const model = frameModel({ member: member });
        line('  ' + member.padEnd(11) +
            '  m=' + String(model.m).padStart(4) +
            '  grid=' + model.layout.rows + 'x' + model.layout.cols +
            '  attempt=' + model.attempt +
            '  frames=' + model.frames.length +
            '  verified=' + (model.verified ? 'yes (reproduces the exact fingerprints)' : 'NO'));
    }

    // Full-n faithfulness proof (n=2000, not animated): fp deep-equal + same attempt.
    line('');
    line('full-n faithfulness proof (n=2000, headless):');
    for (const member of ['Xor', 'BinaryFuse']) {
        const keys = demoKeys(2000);
        const d = derivePeel({ keys: keys, fpp: PEEL_FPP, seed: PEEL_SEED, member: member, withFrames: false });
        const shipped = shippedFp(keys, PEEL_FPP, PEEL_SEED, member);
        let ok = shipped.length === d.fp.length;
        if (ok) for (let i = 0; i < shipped.length; i++) if (shipped[i] !== d.fp[i]) { ok = false; break; }
        const trySeed = (PEEL_SEED ^ Math.imul(d.attempt, RESEED_MUL)) >>> 0;
        line('  ' + member.padEnd(11) +
            '  fp[' + d.fp.length + '] deep-equal=' + (ok ? 'yes' : 'NO') +
            '  attempt=' + d.attempt +
            '  attempt-seed=0x' + trySeed.toString(16));
        if (!ok) process.exitCode = 1;
    }
}

if (typeof process !== 'undefined' && process.argv) {
    main();
}
