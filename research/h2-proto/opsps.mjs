// research/h2-proto/opsps.mjs -- wall-clock int `has` ops/s, current ../../Filter.js vs the
// frozen 1.2.0 fixture, Node inline (default). ROADMAP 13 asks for the int-has ops/s ratio;
// a regression over 10% needs a written CHANGELOG justification.
//
// Each measurement runs in its OWN child process (no cross-contamination of JIT state or
// megamorphic ICs from running several classes / both modules through one call site). To damp
// run-to-run variance the parent runs K pairs INTERLEAVED (OLD, NEW, OLD, NEW, ...) per member
// and reports the MEDIAN per side, the ratio of medians, and the min..max of the per-pair ratios.
//
// Child: `node opsps.mjs --child <member> <modulePath> <N>` -> prints `OPS <ops/s>`.
// Parent (no args): spawns the interleaved children, prints the per-member summary.
//   env OPSPS_K -- pairs per member (default 7).
//   env OPSPS_N -- ops per timed trial (default 30000000). Set tiny (e.g. 200000) to smoke-test
//                  without loading the CPU.
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const NEW = fileURLToPath(new URL('../../Filter.js', import.meta.url));
const OLD = fileURLToPath(new URL('../../test/fixtures/Filter.1.2.0.js', import.meta.url));
const MEMBERS = ['Bloom', 'CountingBloom', 'BlockedBloom', 'Cuckoo', 'Quotient', 'XorFilter', 'BinaryFuse'];
const WARM = 3_000_000;
const N = Number(process.env.OPSPS_N || 30_000_000);
const K = Number(process.env.OPSPS_K || 7);

const median = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

if (process.argv[2] === '--child') {
    const member = process.argv[3];
    const path = process.argv[4];
    const n = Number(process.argv[5] || N);
    const F = await import(path);
    const keys = new Int32Array(4096);
    for (let i = 0; i < 4096; i++) keys[i] = (Math.imul(i + 1, 2654435761) | 0);
    const isStatic = member === 'XorFilter' || member === 'BinaryFuse';
    let f;
    if (isStatic) {
        f = F[member].from(Array.from(keys.subarray(0, 2048)), { keys: 'int' });
    } else {
        f = new F[member](8192, { keys: 'int' });
        for (let i = 0; i < 2048; i++) f.add(keys[i]);
    }
    let sink = 0;
    for (let i = 0; i < Math.min(WARM, n); i++) if (f.has(keys[i & 4095])) sink++;
    let best = 0;
    for (let trial = 0; trial < 5; trial++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) if (f.has(keys[i & 4095])) sink++;
        const ops = n / ((performance.now() - t0) / 1000);
        if (ops > best) best = ops;
    }
    if (sink === -1) console.log(sink);
    console.log('OPS ' + best);
} else {
    const childOps = (member, path) => {
        const r = spawnSync(process.execPath, [SELF, '--child', member, path, String(N)], { encoding: 'utf8', timeout: 180000 });
        if (r.status !== 0) throw new Error('child ' + member + ' exited ' + r.status + ': ' + (r.stderr || ''));
        const m = r.stdout.match(/OPS ([\d.]+)/);
        if (!m) throw new Error('child ' + member + ' (' + path + ') produced no OPS line: ' + r.stdout.slice(0, 200));
        return Number(m[1]);
    };
    console.log('opsps: K=' + K + ' pairs/member, N=' + N + ' ops/trial, best-of-5 per child, interleaved');
    for (const member of MEMBERS) {
        const olds = [], news = [], ratios = [];
        for (let k = 0; k < K; k++) {
            const o = childOps(member, OLD);   // interleaved: OLD then NEW, K times
            const nw = childOps(member, NEW);
            olds.push(o); news.push(nw); ratios.push(nw / o);
        }
        const mOld = median(olds), mNew = median(news);
        const rMed = mNew / mOld;
        const rMin = Math.min(...ratios), rMax = Math.max(...ratios);
        console.log(
            member.padEnd(11) +
            ' old=' + (mOld / 1e6).toFixed(1).padStart(6) + ' Mops/s' +
            ' new=' + (mNew / 1e6).toFixed(1).padStart(6) + ' Mops/s' +
            ' ratio(medians)=' + rMed.toFixed(3) +
            ' per-pair=[' + rMin.toFixed(3) + '..' + rMax.toFixed(3) + ']' +
            (rMed >= 0.90 ? ' OK' : ' REGRESSION>10%')
        );
    }
}
