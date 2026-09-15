// @zakkster/lite-filter -- per-member renderers (repo-only, dump()-driven).
//
// One renderer per member, each driven STRICTLY off that member's dump() snapshot.
// A renderer reads ONLY snapshot fields; it computes pixel geometry (rendering),
// never member state (which would be shadow mechanics). OCCUPANCY ONLY: a renderer
// draws what the store actually carries (set bits, counter values, fingerprints,
// metadata bits, segment layout), never a query's probe positions -- re-deriving a
// key's hash slots would be re-implementing the member's mechanics, which this demo
// forbids. dump() is the only source of truth.
//
// Each renderer declares `fields` (the FULL ordered list of keys its dump() carries)
// and a `model(snap)` that reassembles the snapshot from exactly those keys, in that
// order. Demo.test.mjs asserts BOTH `Object.keys(model(dump()))` deep-equals `fields`
// AND `model(dump())` deep-equals `dump()` for every member: a dropped field, an
// invented field, or a wrong order all fail.
//
// draw(g, snap, geom) uses a CanvasRenderingContext2D and runs in the browser only;
// the model() path is pure and is what the node test exercises.
//
// This module imports NOTHING (pure). Repo-only dev artifact; NEVER shipped.

/** The base snapshot fields EVERY member's dump() carries (the shared provenance +
 *  sizing spine). Every member's `fields` is a superset of these; the teeth test drops
 *  one to prove a renderer that omits it fails the deep-equal. */
export const BASE_FIELDS = Object.freeze(['f', 'mem', 'cap', 'fpp', 'seed', 'keys', 'count', 'chk']);

/** Reassemble a snapshot from exactly `fields`, IN ORDER. `Object.keys` of the result
 *  is `fields`; the values are copied from the snapshot, so if `fields` omits a key
 *  dump() emits the result is missing it (deep-equal fails), and if `fields` names a
 *  key dump() does NOT emit the result carries `undefined` (deep-equal fails). */
function pick(snap, fields) {
    const o = {};
    for (let i = 0; i < fields.length; i++) o[fields[i]] = snap[fields[i]];
    return o;
}

/* ------------------------------- palette --------------------------------- */
// Hex first (a browser that ignores anything falls back cleanly).
const COL = {
    bg: '#04120c',
    empty: '#0b1f16',
    set: '#37e08a',
    edge: '#1d2b25',
    cell: '#12261c',
    cellEdge: '#2b5a44',
    label: '#9fe3bf',
    dim: '#7fa591',
    text: '#cfe8d8',
    hot: '#ffcf5a',
    seg0: '#37e08a', seg1: '#46b0ff', seg2: '#ffcf5a', // XOR three-segment tint
    metaShift: '#ff8a6a',
    building: '#7fa591',
};

/** popcount of a 32-bit word. */
function popcount32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (Math.imul(x, 0x01010101) >>> 24);
}

/** Draw a label above a body region. Returns the body's top y. */
function drawLabel(g, x, y, text) {
    g.fillStyle = COL.label;
    g.font = '12px ui-monospace, monospace';
    g.fillText(text, x, y);
    return y + 8;
}

/**
 * Draw a heat GRID of aggregated occupancy over a flat count of `total` items: the
 * region is divided into `cols x rows` cells, each cell aggregates a contiguous chunk
 * and is tinted by its fill fraction in [0, 1] returned by `frac(startIdx, endIdx)`.
 * Pure geometry -- occupancy only.
 */
function drawHeatGrid(g, x, y, w, h, total, cols, rows, frac, tint) {
    const cw = w / cols, ch = h / rows;
    const cells = cols * rows;
    for (let c = 0; c < cells; c++) {
        const lo = Math.floor((c * total) / cells);
        const hi = Math.floor(((c + 1) * total) / cells);
        const f = hi > lo ? frac(lo, hi) : 0;
        const cx = x + (c % cols) * cw;
        const cy = y + Math.floor(c / cols) * ch;
        g.fillStyle = f <= 0 ? COL.empty : (tint || COL.set);
        g.globalAlpha = f <= 0 ? 1 : Math.min(1, 0.28 + 0.72 * f);
        g.fillRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
        g.globalAlpha = 1;
    }
    g.strokeStyle = COL.edge; g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** Bit-fill fraction over words[lo..hi) counted in BITS (Uint32 store). */
function bitFrac(words, totalBits) {
    return function (lo, hi) {
        let set = 0;
        const wLo = lo >>> 5, wHi = (hi + 31) >>> 5;
        for (let wi = wLo; wi < wHi && wi < words.length; wi++) {
            let word = words[wi] >>> 0;
            const base = wi << 5;
            // Mask to the [lo, hi) window within this word.
            for (let b = 0; b < 32; b++) {
                const idx = base + b;
                if (idx < lo || idx >= hi || idx >= totalBits) continue;
                if (word & (1 << b)) set++;
            }
        }
        return set / (hi - lo);
    };
}

/** The "building..." placeholder for the static members before the BUILD cursor
 *  completes. Drawn from ENGINE state (geom.building), NEVER a dump field. */
function drawBuilding(g, geom) {
    g.fillStyle = COL.building;
    g.font = '13px ui-monospace, monospace';
    g.fillText('building... peeling the 3-uniform hypergraph', geom.x, geom.y + 28);
    g.fillText('(static: no incremental add -- built once from the whole key set)', geom.x, geom.y + 48);
}

/* ----------------------------- renderers --------------------------------- */

export const RENDERERS = {
    Bloom: {
        fields: ['f', 'mem', 'm', 'k', 'cap', 'fpp', 'seed', 'keys', 'count', 'bits', 'chk'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            const y = drawLabel(g, geom.x, geom.y + 12, 'bit array  m=' + s.m + '  k=' + s.k + '  set-bit occupancy');
            drawHeatGrid(g, geom.x, y + 4, geom.w, geom.h - 40, s.m, 64, 12, bitFrac(s.bits, s.m), COL.set);
        },
    },
    CountingBloom: {
        fields: ['f', 'mem', 'w', 'm', 'k', 'cap', 'fpp', 'seed', 'keys', 'count', 'cnts', 'chk'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            // Two 4-bit counters (0..15) per byte; heat by the MAX counter in a chunk.
            const cnts = s.cnts, ncnt = s.m;
            const frac = (lo, hi) => {
                let mx = 0;
                for (let i = lo; i < hi && i < ncnt; i++) {
                    const byte = cnts[i >>> 1] | 0;
                    const nib = (i & 1) ? (byte >>> 4) & 0xf : byte & 0xf;
                    if (nib > mx) mx = nib;
                }
                return mx / 15;
            };
            const y = drawLabel(g, geom.x, geom.y + 12, '4-bit counters (0..15)  m=' + s.m + '  heat = max in chunk');
            drawHeatGrid(g, geom.x, y + 4, geom.w, geom.h - 40, ncnt, 64, 12, frac, COL.hot);
        },
    },
    BlockedBloom: {
        fields: ['f', 'mem', 'bb', 'nb', 'm', 'k', 'cap', 'fpp', 'seed', 'keys', 'count', 'bits', 'chk'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            // One cell per 512-bit block (bb bits = 16 Uint32 words = one cache line).
            const words = s.bits, nb = s.nb, wordsPerBlock = s.bb >>> 5;
            const cols = Math.min(nb, 48), rows = Math.ceil(nb / cols);
            const cw = geom.w / cols, ch = (geom.h - 40) / Math.max(1, rows);
            const y = drawLabel(g, geom.x, geom.y + 12, s.nb + ' cache-line blocks (' + s.bb + ' bits each)  one key -> one block');
            for (let bidx = 0; bidx < nb; bidx++) {
                let set = 0;
                const base = bidx * wordsPerBlock;
                for (let wi = 0; wi < wordsPerBlock; wi++) set += popcount32(words[base + wi] >>> 0);
                const f = set / s.bb;
                const cx = geom.x + (bidx % cols) * cw;
                const cy = y + 4 + Math.floor(bidx / cols) * ch;
                g.fillStyle = f <= 0 ? COL.empty : COL.set;
                g.globalAlpha = f <= 0 ? 1 : Math.min(1, 0.28 + 0.72 * f * 4);
                g.fillRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
                g.globalAlpha = 1;
            }
        },
    },
    Cuckoo: {
        fields: ['f', 'mem', 'fw', 'b', 'nb', 'cap', 'fpp', 'seed', 'keys', 'count', 'fp', 'chk'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            // One cell per bucket (b=4 slots); tint by how many slots hold a nonzero
            // fingerprint (0 is the empty-slot sentinel). Two candidate buckets per key
            // are NOT re-derived (occupancy only, no shadow hashing).
            const fp = s.fp, nb = s.nb, b = s.b;
            const cols = Math.min(nb, 48), rows = Math.ceil(nb / cols);
            const cw = geom.w / cols, ch = (geom.h - 40) / Math.max(1, rows);
            const y = drawLabel(g, geom.x, geom.y + 12, s.nb + ' buckets x b=' + s.b + ' slots  fw=' + s.fw + '-bit fingerprints');
            for (let bk = 0; bk < nb; bk++) {
                let occ = 0;
                const base = bk * b;
                for (let sIdx = 0; sIdx < b; sIdx++) if ((fp[base + sIdx] | 0) !== 0) occ++;
                const f = occ / b;
                const cx = geom.x + (bk % cols) * cw;
                const cy = y + 4 + Math.floor(bk / cols) * ch;
                g.fillStyle = f <= 0 ? COL.empty : COL.set;
                g.globalAlpha = f <= 0 ? 1 : Math.min(1, 0.28 + 0.72 * f);
                g.fillRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
                g.globalAlpha = 1;
            }
        },
    },
    Quotient: {
        fields: ['f', 'mem', 'r', 'q', 'p', 'nslots', 'load', 'cap', 'fpp', 'seed', 'keys', 'count', 'store', 'chk'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            // One cell per chunk of the linear slot array. A slot is OCCUPIED iff any of
            // its low-3 metadata bits are set; a chunk is tinted by occupancy and
            // outlined red if it holds any SHIFTED slot (a run pushed off its home =
            // clustering). Metadata: bit0 occupied, bit1 continuation, bit2 shifted.
            const store = s.store, ns = s.store.length;
            const cols = 64, rows = 10, cells = cols * rows;
            const cw = geom.w / cols, ch = (geom.h - 40) / rows;
            const y = drawLabel(g, geom.x, geom.y + 12, 'linear slots nslots=' + s.nslots + '  r=' + s.r + '  occupancy + shift (red)');
            for (let c = 0; c < cells; c++) {
                const lo = Math.floor((c * ns) / cells), hi = Math.floor(((c + 1) * ns) / cells);
                let occ = 0, shifted = 0, tot = 0;
                for (let i = lo; i < hi; i++) {
                    tot++;
                    const meta = store[i] & 7;
                    if (meta !== 0) occ++;
                    if (meta & 4) shifted++;
                }
                const f = tot ? occ / tot : 0;
                const cx = geom.x + (c % cols) * cw;
                const cy = y + 4 + Math.floor(c / cols) * ch;
                g.fillStyle = f <= 0 ? COL.empty : COL.set;
                g.globalAlpha = f <= 0 ? 1 : Math.min(1, 0.28 + 0.72 * f);
                g.fillRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
                g.globalAlpha = 1;
                if (shifted > 0) {
                    g.strokeStyle = COL.metaShift; g.lineWidth = 1;
                    g.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
                }
            }
        },
    },
    Xor: {
        fields: ['f', 'mem', 'fw', 'bl', 'cap', 'fpp', 'seed', 'keys', 'count', 'fp', 'chk'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            if (geom.building) { drawBuilding(g, geom); return; }
            // Three DISJOINT segments of length bl (the array is 3*bl). One heat row per
            // segment; a slot is "occupied" iff its fingerprint is nonzero.
            const fp = s.fp, bl = s.bl;
            const segTints = [COL.seg0, COL.seg1, COL.seg2];
            const rowH = (geom.h - 56) / 3;
            let y = drawLabel(g, geom.x, geom.y + 12, '3 disjoint segments x bl=' + s.bl + ' slots  fw=' + s.fw + '  one slot per segment / key') + 4;
            for (let seg = 0; seg < 3; seg++) {
                const base = seg * bl;
                const frac = (lo, hi) => {
                    let occ = 0;
                    for (let i = lo; i < hi; i++) if ((fp[base + i] | 0) !== 0) occ++;
                    return occ / (hi - lo);
                };
                drawHeatGrid(g, geom.x, y, geom.w, rowH - 6, bl, 64, 3, frac, segTints[seg]);
                y += rowH;
            }
        },
    },
    BinaryFuse: {
        fields: ['f', 'mem', 'fw', 'sl', 'sc', 'cap', 'fpp', 'seed', 'keys', 'count', 'fp', 'chk'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            if (geom.building) { drawBuilding(g, geom); return; }
            // A single segmented array of (sc+2) OVERLAPPING segments, each sl long. Draw
            // one continuous heat strip and tick the segment boundaries -- the overlap is
            // tighter than XOR's disjoint segments (~1.13x vs ~1.23x). Occupancy only.
            const fp = s.fp, total = fp.length, sl = s.sl, nseg = s.sc + 2;
            const frac = (lo, hi) => {
                let occ = 0;
                for (let i = lo; i < hi; i++) if ((fp[i] | 0) !== 0) occ++;
                return occ / (hi - lo);
            };
            const bodyY = drawLabel(g, geom.x, geom.y + 12,
                (s.sc + 2) + ' overlapping segments x sl=' + s.sl + '  fw=' + s.fw + '  ~1.13x (tighter than XOR)') + 4;
            const bodyH = geom.h - 44;
            drawHeatGrid(g, geom.x, bodyY, geom.w, bodyH, total, 96, 6, frac, COL.set);
            // Segment boundary ticks along the top edge.
            g.strokeStyle = COL.hot; g.lineWidth = 1;
            for (let seg = 1; seg < nseg; seg++) {
                const px = geom.x + (geom.w * (seg * sl)) / total;
                g.beginPath(); g.moveTo(px, bodyY); g.lineTo(px, bodyY + 6); g.stroke();
            }
        },
    },
};

/** The members this module renders. Demo.test.mjs asserts this covers every engine
 *  member (no member silently unrendered). */
export const RENDERED_MEMBERS = Object.keys(RENDERERS);
