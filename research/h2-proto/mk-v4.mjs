// SPIKE (Bloom only): V3 + a Smi-width-proof int mixer. No 32-bit hash crosses a call:
// mixPair() takes only tagged refs (filter, key), runs the fmix32 body in its OWN frame,
// and writes both words into a module Int32Array. The caller reads them back locally.
import { readFileSync, writeFileSync } from 'node:fs';
const D = new URL('.', import.meta.url).pathname;
let s = readFileSync(D + 'Filter.v3.js', 'utf8');
const helper = `
const _HG = new Int32Array(2);
function mixPair(f, key) {
    let h = (key ^ f._seed) | 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    _HG[0] = h;
    let g = (Math.imul(key | 0, 0x9e3779b1) ^ f._seed2) | 0;
    g ^= g >>> 16; g = Math.imul(g, 0x85ebca6b); g ^= g >>> 13; g = Math.imul(g, 0xc2b2ae35); g ^= g >>> 16;
    _HG[1] = g;
}
`;
s = s.replace('/**\n * The high 32 bits of the 32x32', helper + '\n/**\n * The high 32 bits of the 32x32');
const OLD = `            a = (fmix32((key ^ this._seed) | 0) >>> 0);
            b = ((fmix32((Math.imul(key | 0, 0x9e3779b1) ^ this._seed2) | 0) >>> 0) | 1) >>> 0;`;
const NEW = `            mixPair(this, key);
            a = _HG[0] >>> 0;
            b = (_HG[1] | 1) >>> 0;`;
const start = s.indexOf('export class Bloom {'), end = s.indexOf('\nexport class ', start + 10);
let body = s.slice(start, end); const n = body.split(OLD).length - 1;
body = body.split(OLD).join(NEW);
s = s.slice(0, start) + body + s.slice(end);
writeFileSync(D + 'Filter.v4.js', s);
console.log('Bloom int sites replaced:', n);
