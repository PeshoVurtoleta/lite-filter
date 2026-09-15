// @zakkster/lite-filter -- demo workload server (repo-only dev artifact).
//
//   npm run demo:serve            (then open http://localhost:8017/)
//   node demo/serve.mjs [port]
//
// A zero-dependency Node http server. It exists because the browser page cannot import
// benchmark/Bench.mjs (Bench.mjs statically imports ../Filter.js and is a Node tool).
// So the SERVER generates the shared (add-set, probe-set) with Bench.mjs and hands them
// to the page as JSON:
//
//   GET /workload.json?kind=uniform&seed=1&n=5000&fpp=0.01
//     -> { keys:[...], probes:[...], kind, seed, n, fpp, probeCount }
//
// The probe-set is DISJOINT from the add-set by construction (Bench.mjs draws probes
// from the negative int32 half), so it is the false-positive oracle: a probe that reads
// true is unambiguously a false positive. It also serves the repo's static files so the
// page's `../Filter.js` import resolves (static root = the repo root; the page lives at
// /demo/visuals.html).
//
// Zero runtime deps ship: this server is a dev artifact, NEVER in the tarball.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, sep, extname } from 'node:path';

import { uniform, zipfian, sequential, adversarial } from '../benchmark/Bench.mjs';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DEMO_DIR); // repo root -- so `../Filter.js` from /demo resolves to /Filter.js

/** The default port. Overridable via `node demo/serve.mjs [port]`. */
export const DEFAULT_PORT = 8017;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

const GENERATORS = { uniform, zipfian, sequential, adversarial };

/**
 * Build the shared (add-set, probe-set) for one workload kind. Fails closed on every
 * bad input (null is not zero). The probe count scales with n so a low fpp is still
 * measurable, capped so the JSON payload stays reasonable.
 *
 * @returns {{keys:number[], probes:number[], kind:string, seed:number, n:number,
 *            fpp:number, probeCount:number}}
 */
export function serveWorkload(kind, seed, n, fpp) {
    const gen = GENERATORS[kind];
    if (gen === undefined) {
        throw new Error('[demo] unknown workload kind ' + String(kind) +
            ' (uniform|zipfian|sequential|adversarial)');
    }
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError('[demo] n must be an integer >= 1, got ' + String(n));
    }
    if (typeof fpp !== 'number' || !(fpp > 0) || !(fpp < 1)) {
        throw new RangeError('[demo] fpp must be a number in the open interval (0, 1), got ' + String(fpp));
    }
    const s = (seed >>> 0) || 1;   // seed 0 would freeze the xorshift32 state; fail closed to 1
    const probeCount = Math.min(Math.max(4 * n, 8000), 50000);
    const { keys, probes } = gen(n, probeCount, s);
    return { keys, probes, kind, seed: s, n, fpp, probeCount };
}

/** Resolve a URL path to a real file under ROOT, or null if it is malformed or escapes
 *  ROOT. decodeURIComponent throws URIError on a malformed percent-encoding (e.g. "/%"
 *  or "/%zz"); we catch it and fail CLOSED (null -> 404) rather than let it bubble into
 *  an unhandled rejection that crashes the process. */
function safePath(urlPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return null; // malformed percent-encoding -> fail closed
    }
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    const abs = join(ROOT, rel);
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null; // path traversal guard
    return abs;
}

/** The one-line request handler. Exported so a test can drive it without a socket. */
export async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/workload.json') {
        try {
            const kind = url.searchParams.get('kind') || 'uniform';
            // `|| default` would treat an EXPLICIT "n=0" / "fpp=0" as absent (0 is falsy)
            // and silently substitute the default instead of failing closed through
            // serveWorkload's own RangeError -- "null is not zero". Only a genuinely
            // ABSENT param uses the default; a present-but-invalid value is passed
            // through to serveWorkload, which rejects it.
            const seedParam = url.searchParams.get('seed');
            const nParam = url.searchParams.get('n');
            const fppParam = url.searchParams.get('fpp');
            // A present-but-non-numeric seed must fail closed with a 400, NOT silently
            // fall back to 1 (Number("abc") -> NaN -> NaN>>>0 -> 0 -> ||1). Only a
            // genuinely ABSENT seed uses the default (null is not zero, and not "abc").
            if (seedParam !== null && !Number.isFinite(Number(seedParam))) {
                throw new RangeError('[demo] seed must be a finite number, got ' + String(seedParam));
            }
            const seed = seedParam === null ? 1 : Number(seedParam);
            const n = nParam === null ? 5000 : Number(nParam);
            const fpp = fppParam === null ? 0.01 : Number(fppParam);
            const payload = serveWorkload(kind, seed >>> 0, n, fpp);
            const body = JSON.stringify(payload);
            res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
            res.end(body);
        } catch (err) {
            res.writeHead(400, { 'content-type': MIME['.json'] });
            res.end(JSON.stringify({ error: String(err && err.message || err) }));
        }
        return;
    }

    // "/" -> 302 REDIRECT to the page's real path (NOT an in-place serve). Serving the
    // HTML in place at "/" leaves the browser's document base URL at "/", so the page's
    // relative module imports (./Visualize.mjs, ./renderers.mjs) resolve to the repo
    // root and 404. Redirecting makes the browser re-request /demo/visuals.html, so the
    // base URL becomes /demo/ and the imports resolve.
    if (url.pathname === '/') {
        res.writeHead(302, { location: '/demo/visuals.html' });
        res.end();
        return;
    }

    // Static files. A malformed path, a traversal escape, or a missing file all fail
    // CLOSED with a 404 -- never a throw that escapes the handler.
    const pathname = url.pathname;
    try {
        const abs = safePath(pathname);
        if (abs !== null) {
            const data = await readFile(abs);
            const type = MIME[extname(abs)] || 'application/octet-stream';
            res.writeHead(200, { 'content-type': type });
            res.end(data);
            return;
        }
    } catch {
        // fall through to the 404 below (missing file / read error)
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 ' + pathname);
}

/** Create (but do not start) the http server. The handler is async; a rejection (from
 *  any unforeseen path) is caught here and turned into a 500, so it can NEVER surface as
 *  an unhandled promise rejection that crashes the process. */
export function createServer() {
    return http.createServer((req, res) => {
        handle(req, res).catch((err) => {
            try {
                if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('500 ' + String((err && err.message) || err));
            } catch {
                /* the response is already gone -- nothing more to do */
            }
        });
    });
}

/** Start listening. Returns the server. */
export function start(port) {
    const server = createServer();
    server.listen(port, () => {
        process.stdout.write('lite-filter demo server on http://localhost:' + port + '/\n');
        process.stdout.write('  page:      http://localhost:' + port + '/\n');
        process.stdout.write('  workload:  http://localhost:' + port + '/workload.json?kind=uniform&seed=1&n=5000&fpp=0.01\n');
    });
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    start(Number(process.argv[2]) || DEFAULT_PORT);
}
