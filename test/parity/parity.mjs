// test/parity/parity.mjs -- ENGINE-NEUTRAL parity oracle (no node: imports).
// Compares two Filter modules (A reference, B under test) over every member x
// {int, string} x seeds, and over the add/remove/has/getters/dump/restore surface.
// Returns { checks, fails, digest, diffs }. The digest is a 32-bit FNV-1a fold of
// EVERY result on BOTH sides, so it is identical across engines iff the arithmetic
// is -- the "the math must not depend on the engine" witness (ROADMAP 13).
//
// Runnable directly on d8 (`d8 parity.mjs -- <A> <B>`) and on Node
// (`node parity.mjs <A> <B>`); importable as `{ runParity }` from a node:test file.

const MEM = ['Bloom', 'CountingBloom', 'BlockedBloom', 'Cuckoo', 'Quotient', 'XorFilter', 'BinaryFuse'];
const DELETABLE = { CountingBloom: 1, Cuckoo: 1, Quotient: 1 };
const STATIC = { XorFilter: 1, BinaryFuse: 1 };

export function runParity(A, B) {
    let checks = 0, fails = 0;
    const diffs = [];
    let dig = 0x811c9dc5 | 0;
    const f32 = (x) => { dig = Math.imul(dig ^ (x | 0), 0x01000193) | 0; };
    const fstr = (s) => { for (let i = 0; i < s.length; i++) f32(s.charCodeAt(i)); f32(s.length ^ 0x55555555); };
    const fold = (v) => {
        if (v === true) f32(0x1111);
        else if (v === false) f32(0x2222);
        else if (v === null) f32(0x3333);
        else if (v === undefined) f32(0x4444);
        else if (typeof v === 'number') { f32(0x5000); f32(v | 0); f32(Math.floor(v / 0x100000000) | 0); }
        else if (typeof v === 'string') { f32(0x6000); fstr(v); }
        else if (typeof v === 'object') {
            f32(0x7000);
            const len = v.length;
            if (typeof len === 'number') { f32(len); for (let i = 0; i < len; i++) fold(v[i]); }
            else { const ks = Object.keys(v).sort(); f32(ks.length); for (const k of ks) { fstr(k); fold(v[k]); } }
        } else f32(0x8888);
    };
    const eq = (x, y, what) => {
        checks++;
        fold(x); fold(y);
        const sx = ser(x), sy = ser(y);
        if (sx !== sy) { fails++; if (diffs.length < 12) diffs.push(what + ' :: ' + sx.slice(0, 90) + ' | ' + sy.slice(0, 90)); }
    };

    // Deterministic key generators (one PRNG, reset per combo so A and B see the same stream).
    const mkRnd = () => { let s = 7 | 0; return () => (s = (Math.imul(s, 1103515245) + 12345) | 0); };
    const INT_EDGES = [-2147483648, 2147483647, 0, -1, 1, 1073741824, -1073741824, 1073741823, -1073741825];
    const intKeys = (n) => { const r = mkRnd(); const a = []; for (let i = 0; i < n; i++) a.push(r()); for (const e of INT_EDGES) a.push(e); return a; };
    const strKeys = (n) => { const r = mkRnd(); const a = []; for (let i = 0; i < n; i++) a.push('sig:' + (r() >>> 0).toString(36) + ':' + i); return a; };

    for (const mem of MEM) {
        for (const mode of ['int', 'str']) {
            for (const sd of [undefined, 1, 0xdeadbeef, 0x80000000]) {
                const tag = mem + '/' + mode + '/seed' + sd;
                const ins = mode === 'int' ? intKeys(3000) : strKeys(3000);
                const probe = mode === 'int' ? intKeys(50000) : strKeys(50000);
                const opts = mode === 'int' ? { keys: 'int' } : {};
                if (sd !== undefined) opts.seed = sd;
                let fa, fb;
                if (STATIC[mem]) {
                    fa = A[mem].from(ins, { ...opts });
                    fb = B[mem].from(ins, { ...opts });
                } else {
                    fa = new A[mem](4096, { ...opts });
                    fb = new B[mem](4096, { ...opts });
                    for (const k of ins) {
                        let ea = null, eb = null;
                        try { fa.add(k); } catch (e) { ea = e.message; }
                        try { fb.add(k); } catch (e) { eb = e.message; }
                        eq(ea, eb, tag + ' add-throw');
                    }
                    if (DELETABLE[mem]) {
                        for (let i = 0; i < ins.length; i += 3) {
                            let ra, rb;
                            try { ra = fa.remove(ins[i]); } catch (e) { ra = 'T:' + e.message; }
                            try { rb = fb.remove(ins[i]); } catch (e) { rb = 'T:' + e.message; }
                            eq(ra, rb, tag + ' remove');
                        }
                    }
                }
                // has over inserted + fresh probe set.
                for (let i = 0; i < ins.length; i++) eq(fa.has(ins[i]), fb.has(ins[i]), tag + ' has-ins' + i);
                for (let i = 0; i < probe.length; i++) eq(fa.has(probe[i]), fb.has(probe[i]), tag + ' has-probe' + i);
                // getters.
                eq(fa.size, fb.size, tag + ' size');
                eq(fa.seed, fb.seed, tag + ' seed');
                eq(fa.capacity, fb.capacity, tag + ' capacity');
                eq(fa.keysMode, fb.keysMode, tag + ' keysMode');
                eq(fa.maxLoad, fb.maxLoad, tag + ' maxLoad');
                // dump() bytes + restore() round-trip: same has results and same re-dump.
                if (typeof fa.dump === 'function') {
                    const da = fa.dump(), db = fb.dump();
                    eq(da, db, tag + ' dump');
                    const ra = A[mem].restore(da), rb = B[mem].restore(db);
                    for (let i = 0; i < probe.length; i += 7) eq(ra.has(probe[i]), rb.has(probe[i]), tag + ' restore-has' + i);
                    eq(ra.dump(), rb.dump(), tag + ' redump');
                }
            }
        }
        // Fill-until-throw (kick / cluster-shift path) for the deletable, bounded members.
        if (mem === 'Cuckoo' || mem === 'Quotient') {
            const ka = new A[mem](64, { keys: 'int' }), kb = new B[mem](64, { keys: 'int' });
            let ea = null, eb = null, ia = 0, ib = 0;
            for (let i = 0; i < 100000; i++) { try { ka.add(i); ia++; } catch (e) { ea = e.message; break; } }
            for (let i = 0; i < 100000; i++) { try { kb.add(i); ib++; } catch (e) { eb = e.message; break; } }
            eq(ia, ib, mem + ' fill-count');
            eq(ea, eb, mem + ' fill-throw');
            for (let i = 0; i < ia + 10; i++) eq(ka.has(i), kb.has(i), mem + ' fill-has' + i);
        }
        // Static build across a range of set sizes (peel geometry).
        if (STATIC[mem]) {
            for (const n of [1, 2, 3, 100, 3000]) {
                const keys = []; const r = mkRnd(); for (let i = 0; i < n; i++) keys.push(r());
                const xa = A[mem].from(keys, { keys: 'int' }), xb = B[mem].from(keys, { keys: 'int' });
                for (const k of keys) eq(xa.has(k), xb.has(k), mem + ' n' + n + ' has-member');
                for (let i = 0; i < 200; i++) { const k = (r() ^ 0x5a5a5a5a) | 0; eq(xa.has(k), xb.has(k), mem + ' n' + n + ' has-fresh' + i); }
                eq(xa.dump(), xb.dump(), mem + ' n' + n + ' dump');
            }
        }
    }
    return { checks, fails, digest: dig >>> 0, diffs };
}

// Stable serializer for the equality decision (engine-neutral; handles typed arrays).
function ser(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undef';
    const t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string') return t[0] + ':' + v;
    if (t === 'object') {
        const len = v.length;
        if (typeof len === 'number') { let s = '[' + len + ':'; for (let i = 0; i < len; i++) s += ser(v[i]) + ','; return s + ']'; }
        const ks = Object.keys(v).sort(); let s = '{';
        for (const k of ks) s += k + '=' + ser(v[k]) + ','; return s + '}';
    }
    return t;
}

// --- self-run (d8 or `node parity.mjs <A> <B>`) ---------------------------------
const _argv = (typeof globalThis !== 'undefined' && typeof globalThis.arguments !== 'undefined')
    ? globalThis.arguments
    : (typeof process !== 'undefined' && process.argv ? process.argv.slice(2) : []);
if (_argv.length >= 2) {
    const A = await import(_argv[0]);
    const B = await import(_argv[1]);
    const r = runParity(A, B);
    const line = 'PARITY checks=' + r.checks + ' fails=' + r.fails + ' digest=' + r.digest;
    if (typeof print === 'function') print(line); else console.log(line);
    for (const d of r.diffs) { if (typeof print === 'function') print('DIFF ' + d); else console.log('DIFF ' + d); }
}
