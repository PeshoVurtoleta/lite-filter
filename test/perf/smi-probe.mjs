// test/perf/smi-probe.mjs -- ENGINE-NEUTRAL scavenge probe (Node AND d8).
// One lane per child process. The DRIVER (SmiWidth*.test) pins
// --min-semi-space-size=4 --max-semi-space-size=4 and (optionally)
// --max-inlined-bytecode-size=0, then counts `Scavenge` lines at N vs 8N.
// This file only RUNS the loop; it imports nothing (no node: deps) so d8 can load it.
//
// args: <file> <member> <N> <op> <ks> <mixed>
//   file   module path to the Filter under test (absolute).
//   member Bloom|CountingBloom|BlockedBloom|Cuckoo|Quotient|XorFilter|BinaryFuse
//          or a control: nop | object | box
//   N      iteration count.
//   op     mix | has | add | churn | kick   (control members ignore op)
//   ks     smi31 (keys >> 1, all Smi on 31-bit engines) | full (whole int32 range)
//   mixed  "1" warms all 7 classes in THIS process first (shared-IC / megamorphic check)

const _argv = (typeof globalThis !== 'undefined' && typeof globalThis.arguments !== 'undefined')
    ? globalThis.arguments
    : process.argv.slice(2);
const [file, member, N0, op0, ks0, mixed0] = _argv;
const N = +N0;
const op = op0 || 'mix';
const SH = (ks0 === 'smi31') ? 1 : 0;
const MIXED = mixed0 === '1';

const keys = new Int32Array(4096);
for (let i = 0; i < 4096; i++) keys[i] = (Math.imul(i + 1, 2654435761) >> SH);
if (SH === 0) { keys[0] = -2147483648; keys[1] = 2147483647; } // +-2^31 edges (full-range lane)

let sink = 0;
let _kicks = 0;   // Cuckoo kick lane: count of ops where the kick path actually ran (_rng moved)
let _rngPrev = 0;

// Non-inlinable boxing control: returns an unsigned 32-bit int that is >= 2^31 half the
// time, so a non-inlined caller boxes it (the exact defect H2 removes). MUST grow the gate.
function boxfmix(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}

async function main() {
    const C = 8192;
    let run;

    if (member === 'nop') {
        run = (i) => { sink ^= keys[i & 4095]; };
    } else if (member === 'object') {
        // Escape the object into a fixed ring so V8 cannot scalar-replace it: one real
        // heap allocation per op (bounded live set), the always-grows teeth control.
        const ring = new Array(1024);
        run = (i) => { const o = { k: keys[i & 4095] }; ring[i & 1023] = o; sink ^= o.k; };
    } else if (member === 'box') {
        run = (i) => { sink += boxfmix(keys[i & 4095]); };
    } else {
        const F = await import(file);
        if (MIXED) {
            // Warm every class so the field-free module helpers (_ckAlt / mulhiU32) and any
            // shared IC see all 7 maps BEFORE the measured member runs.
            const warm = (m, ctor) => { try { const w = ctor(m); for (let i = 0; i < 64; i++) { w.has ? w.has(keys[i]) : 0; } } catch (e) {} };
            warm('Bloom', (m) => new F[m](C, { keys: 'int' }));
            warm('CountingBloom', (m) => new F[m](C, { keys: 'int' }));
            warm('BlockedBloom', (m) => new F[m](C, { keys: 'int' }));
            warm('Cuckoo', (m) => new F[m](C, { keys: 'int' }));
            warm('Quotient', (m) => new F[m](C, { keys: 'int' }));
            warm('XorFilter', (m) => F[m].from(Array.from(keys.subarray(0, 64)), { keys: 'int' }));
            warm('BinaryFuse', (m) => F[m].from(Array.from(keys.subarray(0, 64)), { keys: 'int' }));
        }

        const isStatic = member === 'XorFilter' || member === 'BinaryFuse';
        const deletable = member === 'CountingBloom' || member === 'Cuckoo' || member === 'Quotient';
        const bloomFam = member === 'Bloom' || member === 'CountingBloom' || member === 'BlockedBloom';
        let f;

        if (isStatic) {
            f = F[member].from(Array.from(keys.subarray(0, 2048)), { keys: 'int' });
            run = (i) => { if (f.has(keys[i & 4095])) sink++; };
        } else if (op === 'kick' && member === 'Cuckoo') {
            // Fill to ~0.93 of the REAL ceiling (maxLoad = nb*b, not capacity), then slide a
            // live window of L fresh keys over a ring pool P > L: each op frees the OLDEST slot
            // and inserts a NEW key, so nearly every add fights for space and takes the kick
            // path. `_rng` moves ONLY when the kick loop runs, so counting its changes measures
            // real kicks; the lane fails closed (throws, non-zero exit) if it never kicks.
            f = new F[member](C, { keys: 'int' });
            const ML = f.maxLoad;
            const L = (0.93 * ML) | 0;
            let P = 1; while (P < ML * 2) P <<= 1;   // P > L, power of two
            const PM = P - 1;
            const pool = new Int32Array(P);
            for (let i = 0; i < P; i++) pool[i] = (Math.imul(i + 1, 2654435761) >> SH);
            for (let i = 0; i < L; i++) f.add(pool[i]);
            // Track kicks via the LOW 30 bits of `_rng` (a kick runs the xorshift, moving them).
            // Masking to 2^30 keeps the compared value a Smi on BOTH engines, so the counter
            // itself never boxes and cannot pollute the measurement it guards.
            _rngPrev = f._rng & 0x3fffffff;
            run = (i) => {
                const j = i & PM;
                f.remove(pool[j]);
                f.add(pool[(j + L) & PM]);
                const r = f._rng & 0x3fffffff;
                if (r !== _rngPrev) { _kicks++; _rngPrev = r; }
            };
        } else if (op === 'churn' && deletable) {
            f = new F[member](C, { keys: 'int' });
            run = (i) => { const k = keys[i & 4095]; f.add(k); f.remove(k); };
        } else if (op === 'add') {
            // Add EVERY op (add-only Bloom family: bits/counters just re-set or saturate, no
            // throw). `if (!has) add` would stop after 4096 distinct keys and never exercise add
            // inside the measured window -- the blocker this lane fixes.
            f = new F[member](C, { keys: 'int' });
            run = (i) => { f.add(keys[i & 4095]); };
        } else if (op === 'has') {
            f = new F[member](C, { keys: 'int' });
            for (let i = 0; i < 2048; i++) f.add(keys[i & 4095]);
            run = (i) => { if (f.has(keys[i & 4095])) sink++; };
        } else { // 'mix' -- the RESEARCH 2.1 shape.
            f = new F[member](C, { keys: 'int' });
            if (bloomFam) {
                run = (i) => { const k = keys[i & 4095]; if (!f.has(k)) f.add(k); };
            } else {
                for (let i = 0; i < 2048; i++) f.add(keys[i & 4095]);
                run = (i) => { if (f.has(keys[i & 4095])) sink++; };
            }
        }
    }

    for (let i = 0; i < N; i++) run(i);
    if (sink === 0.5) (typeof print === 'function' ? print : console.log)(sink);
    // Fail closed: a kick lane that never kicked proves nothing (the bug it guards would hide).
    if (member === 'Cuckoo' && op === 'kick' && _kicks === 0) {
        throw new Error('kick lane never kicked (_rng never moved) -- lane is vacuous');
    }
}

await main();
