/**
 * @zakkster/lite-filter -- the conservation invariant (test/debug only).
 *
 * O(words), NEVER on a hot path. It is the structural spine of the torture suite:
 * almost every bit-store or sizing bug violates it immediately (ROADMAP section 9,
 * discipline point 4 -- each member ships its conservation invariant).
 *
 * For Bloom the invariant is BITS-SET CONSISTENCY:
 *
 *   words.length === ceil(m / 32)            (the store matches the sizing)
 *   m >= 1 && k >= 1                          (a validly sized filter)
 *   count === 0  ->  popcount === 0           (an empty filter has NO bits set)
 *   popcount <= min(m, k * count)             (each add sets at most k bits)
 *   count > 0   ->  popcount >= 1             (a non-empty filter has >= 1 bit set)
 *
 * The last three are the teeth: a filter that sets bits it never should (or none
 * when it added a key) fails here. Written GENERALIZED (a `bitsSet` helper) so a
 * future member extends it with one more term, not a rewrite.
 *
 * Zero dependency on the profiler so `node --test` imports it without pulling the
 * torture peers. Throws an Error naming the first violation, or returns void.
 */

/** Population count of a 32-bit word (Hamming weight). Cold -- test only. */
function popcount32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (Math.imul(x, 0x01010101) >>> 24);
}

/** Total set bits across a Bloom's word store. */
export function bitsSet(filter) {
    const words = filter._words;
    let n = 0;
    for (let i = 0; i < words.length; i++) n += popcount32(words[i]);
    return n;
}

/** Assert the bits-set conservation invariant for a Bloom filter. */
export function validate(filter) {
    const m = filter._m;
    const k = filter._k;
    const words = filter._words;
    const count = filter._count;

    const expectedWords = (m + 31) >>> 5;
    if (words.length !== expectedWords) {
        throw new Error(
            "[validate] word store length " + words.length +
            " != ceil(m/32)=" + expectedWords);
    }
    if (!(m >= 1) || !(k >= 1)) {
        throw new Error("[validate] invalid sizing m=" + m + " k=" + k);
    }

    const pop = bitsSet(filter);
    if (count === 0 && pop !== 0) {
        throw new Error("[validate] empty filter has " + pop + " bits set (expected 0)");
    }
    const ceil = Math.min(m, k * count);
    if (pop > ceil) {
        throw new Error(
            "[validate] popcount " + pop + " exceeds k*count bound " + ceil +
            " (k=" + k + ", count=" + count + ")");
    }
    if (count > 0 && pop < 1) {
        throw new Error("[validate] non-empty filter (count=" + count + ") has 0 bits set");
    }
}

/**
 * Assert the CONSERVATION invariant for a CountingBloom (test/debug only, O(bytes)).
 *
 *   cnts.length === ceil(m / 2)                (the store matches the sizing)
 *   m >= 1 && k >= 1                           (a validly sized filter)
 *   every packed nibble is in 0..15            (no negative, no overflow past 4 bits)
 *   sum(nibbles) <= k * count                  (each add raises the sum by <= k;
 *                                               saturation only lowers it further,
 *                                               and remove only lowers it -- decisions/0008)
 *
 * A byte is 0..255 by Uint8Array construction, so both its nibbles are 0..15 already;
 * the nibble check is asserted anyway as a backstop against a packing bug. Throws an
 * Error naming the first violation, or returns void.
 */
export function validateCounting(filter) {
    const m = filter._m;
    const k = filter._k;
    const cnts = filter._cnts;
    const count = filter._count;

    const expectedBytes = (m + 1) >>> 1;
    if (cnts.length !== expectedBytes) {
        throw new Error(
            "[validate] counter store length " + cnts.length +
            " != ceil(m/2)=" + expectedBytes);
    }
    if (!(m >= 1) || !(k >= 1)) {
        throw new Error("[validate] invalid sizing m=" + m + " k=" + k);
    }

    let sum = 0;
    for (let i = 0; i < cnts.length; i++) {
        const byte = cnts[i];
        const lo = byte & 0x0f;
        const hi = (byte >>> 4) & 0x0f;
        if (lo < 0 || lo > 15 || hi < 0 || hi > 15) {
            throw new Error("[validate] nibble out of 0..15 at byte " + i + " (byte=" + byte + ")");
        }
        sum += lo + hi;
    }
    if (count < 0) {
        throw new Error("[validate] negative count " + count);
    }
    if (sum > k * count) {
        throw new Error(
            "[validate] nibble sum " + sum + " exceeds k*count bound " + (k * count) +
            " (k=" + k + ", count=" + count + ")");
    }
    if (count > 0 && sum < 1) {
        throw new Error("[validate] non-empty CountingBloom (count=" + count + ") has all-zero counters");
    }
}

/**
 * Assert the CONSERVATION invariant for a BlockedBloom (test/debug only, O(words)).
 *
 *   words.length === nb * 16                   (16 words per 512-bit block)
 *   nb === ceil(m / 512) && nb >= 1            (the block count matches the sizing)
 *   m >= 1 && k >= 1 && k <= 512               (a validly sized, clamped filter)
 *   count === 0  ->  popcount === 0            (an empty filter has NO bits set)
 *   popcount <= min(nb*512, k * count)         (each add sets at most k bits, all in
 *                                               ONE block -- decisions/0012)
 *   count > 0   ->  popcount >= 1              (a non-empty filter has >= 1 bit set)
 *
 * The store is exactly `nb*512` bits, so "no bit set outside nb*512" holds by
 * construction and is enforced via the length check. Throws an Error naming the first
 * violation, or returns void.
 */
export function validateBlocked(filter) {
    const m = filter._m;
    const k = filter._k;
    const nb = filter._nb;
    const words = filter._words;
    const count = filter._count;

    const expectedWords = nb * 16;
    if (words.length !== expectedWords) {
        throw new Error(
            "[validate] block store length " + words.length + " != nb*16=" + expectedWords);
    }
    if (!(nb >= 1)) {
        throw new Error("[validate] invalid block count nb=" + nb);
    }
    if (nb !== Math.ceil(m / 512)) {
        throw new Error(
            "[validate] block count nb=" + nb + " != ceil(m/512)=" + Math.ceil(m / 512));
    }
    if (!(m >= 1) || !(k >= 1)) {
        throw new Error("[validate] invalid sizing m=" + m + " k=" + k);
    }
    if (!(k <= 512)) {
        throw new Error("[validate] k=" + k + " exceeds the 512-bit block (must be clamped)");
    }

    const pop = bitsSet(filter);
    if (count === 0 && pop !== 0) {
        throw new Error("[validate] empty BlockedBloom has " + pop + " bits set (expected 0)");
    }
    const ceil = Math.min(nb * 512, k * count);
    if (pop > ceil) {
        throw new Error(
            "[validate] popcount " + pop + " exceeds k*count bound " + ceil +
            " (k=" + k + ", count=" + count + ")");
    }
    if (count > 0 && pop < 1) {
        throw new Error("[validate] non-empty BlockedBloom (count=" + count + ") has 0 bits set");
    }
}

/**
 * Assert the LOCALITY property (decisions/0012): a BlockedBloom into which EXACTLY ONE
 * key was added must have ALL its set bits inside ONE 16-word (512-bit) aligned block.
 * Hash-independent -- it does not replicate the address math -- so it proves the whole
 * key landed in a single block, i.e. every set bit lies in `[blk<<4, blk<<4+16)`.
 * Throws if two distinct blocks carry set bits (a locality bug). Returns the block
 * index (or -1 if nothing was set).
 */
export function validateBlockedLocality(filter) {
    const words = filter._words;
    let block = -1;
    for (let i = 0; i < words.length; i++) {
        if (words[i] !== 0) {
            const blk = i >> 4;
            if (block === -1) block = blk;
            else if (blk !== block) {
                throw new Error(
                    "[validate] single key set bits across two blocks: " + block + " and " + blk +
                    " (locality broken, decisions/0012)");
            }
        }
    }
    return block;
}

/**
 * Assert the CONSERVATION invariant for a Cuckoo filter (test/debug only, O(slots)).
 *
 *   store.length === nb * b                     (nb buckets of b slots each)
 *   nb is a power of two && nb >= 1             (the bucket index is a mask)
 *   b === 4 && 1 <= f <= 16                     (pinned bucket size, valid width)
 *   every slot is in 0..fpMask                  (0 = empty; a fingerprint fits the width)
 *   count of NONZERO slots === count            (each add stores one fingerprint, each
 *                                                remove clears one -- exact, not an estimate)
 *
 * The nonzero-slot / count equality is the teeth: a lost or duplicated fingerprint (a kick
 * bug, a bad remove) breaks it immediately. "Every present key resolves in i1 or i2" is
 * guaranteed by construction (kicks preserve candidacy) and proven at scale by the torture
 * differential (0 false negatives), so it is not re-derived here. Throws an Error naming
 * the first violation, or returns void.
 */
export function validateCuckoo(filter) {
    const f = filter._f;
    const b = filter._b;
    const nb = filter._nb;
    const store = filter._store;
    const count = filter._count;
    const fpMask = filter._fpMask;

    if (b !== 4) {
        throw new Error("[validate] Cuckoo bucket size b=" + b + " != 4 (pinned)");
    }
    if (!(f >= 1) || !(f <= 16)) {
        throw new Error("[validate] Cuckoo fingerprint width f=" + f + " out of 1..16");
    }
    if (!(nb >= 1) || (nb & (nb - 1)) !== 0) {
        throw new Error("[validate] Cuckoo bucket count nb=" + nb + " is not a power of two >= 1");
    }
    const expectedSlots = nb * b;
    if (store.length !== expectedSlots) {
        throw new Error(
            "[validate] Cuckoo store length " + store.length + " != nb*b=" + expectedSlots);
    }
    if (fpMask !== (1 << f) - 1) {
        throw new Error("[validate] Cuckoo fpMask " + fpMask + " != (1<<f)-1=" + ((1 << f) - 1));
    }

    let nonzero = 0;
    for (let i = 0; i < store.length; i++) {
        const v = store[i];
        if (v < 0 || v > fpMask) {
            throw new Error("[validate] Cuckoo slot " + i + " value " + v + " out of 0.." + fpMask);
        }
        if (v !== 0) nonzero++;
    }
    if (count < 0) {
        throw new Error("[validate] negative count " + count);
    }
    if (nonzero !== count) {
        throw new Error(
            "[validate] Cuckoo nonzero-slot count " + nonzero + " != size " + count);
    }
}

/**
 * Assert the CONSERVATION + STRUCTURE invariant for a Quotient filter (test/debug only,
 * O(nslots)). This is the teeth for the metadata repair the planner flagged as the one
 * place a subtle bug passes the false-negative tests but breaks structure:
 *
 *   store.length === nslots === 2^q                 (the store matches the sizing)
 *   1 <= r, r + 3 <= 16, every slot word in range   (a valid, byte-aligned layout)
 *   every remainder <= (1<<r)-1                      (the remainder fits its field)
 *   an EMPTY slot (metadata 0) carries a 0 remainder (emptiness is carried by metadata)
 *   (count of slots with any metadata bit set) === size   (each stored element = one slot)
 *   slot 0 is never is_shifted                       (nothing can be shifted left of 0)
 *   a cluster's first slot is neither continuation nor shifted (it is a run head at home)
 *   per cluster: #occupied homes === #runs          (each run maps to exactly one home)
 *   each run's remainders are non-decreasing         (runs are kept sorted on insert)
 *
 * The metadata-set-count === size and the per-cluster #homes === #runs checks are the
 * ones a shift-back repair bug trips immediately. Throws an Error naming the first
 * violation, or returns void.
 */
export function validateQuotient(filter) {
    const r = filter._r;
    const q = filter._q;
    const nslots = filter._nslots;
    const len = filter._len;
    const store = filter._store;
    const count = filter._count;
    const rMask = (1 << r) - 1;
    const OCC = 1, CONT = 2, SHIFT = 4, META = 7;

    if (!(r >= 1) || !(r + 3 <= 16)) {
        throw new Error("[validate] Quotient remainder width r=" + r + " out of 1..13");
    }
    if (!(nslots >= 2) || (nslots & (nslots - 1)) !== 0) {
        throw new Error("[validate] Quotient nslots=" + nslots + " is not a power of two >= 2");
    }
    if (nslots !== Math.pow(2, q)) {
        throw new Error("[validate] Quotient nslots=" + nslots + " != 2^q=" + Math.pow(2, q));
    }
    // The physical store carries GUARD spillover slots beyond nslots (a linear filter,
    // decisions/0016), so its length is nslots + guard, never just nslots.
    if (!(len > nslots) || store.length !== len) {
        throw new Error(
            "[validate] Quotient store length " + store.length + " != _len=" + len +
            " (nslots=" + nslots + " + guard)");
    }

    let metaSet = 0;
    for (let i = 0; i < len; i++) {
        const w = store[i];
        const meta = w & META;
        const rem = w >>> 3;
        if (rem < 0 || rem > rMask) {
            throw new Error("[validate] Quotient slot " + i + " remainder " + rem + " > " + rMask);
        }
        if (meta === 0) {
            if (rem !== 0) {
                throw new Error(
                    "[validate] Quotient empty slot " + i + " carries remainder " + rem +
                    " (an empty slot must be exactly 0)");
            }
        } else {
            metaSet++;
        }
    }
    if (metaSet !== count) {
        throw new Error(
            "[validate] Quotient metadata-set slot count " + metaSet + " != size " + count);
    }
    if ((store[0] & SHIFT) !== 0) {
        throw new Error("[validate] Quotient slot 0 is is_shifted (nothing lies left of 0)");
    }

    // Walk clusters: a cluster is a maximal run of non-empty slots. Its first slot must be a
    // run head at its home (no continuation, no shifted). Within it, #runs must equal
    // #occupied homes, and each run's remainders must be non-decreasing.
    let p = 0;
    while (p < len) {
        if ((store[p] & META) === 0) { p++; continue; }
        const cs = p;
        let ce = p;
        while (ce < len && (store[ce] & META) !== 0) ce++;
        if ((store[cs] & CONT) !== 0) {
            throw new Error("[validate] Quotient cluster start " + cs + " is a continuation");
        }
        if ((store[cs] & SHIFT) !== 0) {
            throw new Error("[validate] Quotient cluster start " + cs + " is is_shifted");
        }
        let homes = 0, runs = 0;
        let prevRem = -1;
        for (let i = cs; i < ce; i++) {
            if (store[i] & OCC) homes++;
            const isRunStart = (i === cs) || !(store[i] & CONT);
            if (isRunStart) { runs++; prevRem = store[i] >>> 3; }
            else {
                const rem = store[i] >>> 3;
                if (rem < prevRem) {
                    throw new Error(
                        "[validate] Quotient run not sorted at slot " + i + " (" + rem +
                        " < " + prevRem + ")");
                }
                prevRem = rem;
            }
        }
        if (homes !== runs) {
            throw new Error(
                "[validate] Quotient cluster [" + cs + "," + ce + ") has " + homes +
                " occupied homes but " + runs + " runs");
        }
        p = ce;
    }
}

/**
 * Assert the CONSERVATION invariant for an XOR filter (test/debug only, O(slots)). An XOR
 * filter is STATIC (decisions/0018): built once, no fill counter to reconcile. The teeth
 * here are STRUCTURAL soundness -- a store whose geometry does not tie back to the deduped
 * key count is a corrupt build:
 *
 *   fw is 8 or 16                              (a byte-aligned fingerprint width)
 *   bl >= 1 && fp.length === 3 * bl            (three equal segments)
 *   bl === ceil(1.23 * count / 3) + 32         (the segment length is derived from count)
 *   count >= 1 && count === capacity           (built over >= 1 key; cap == count)
 *   every slot is in 0..(1<<fw)-1              (each word fits the fingerprint width)
 *
 * The "every present key resolves" law is proven at scale by the torture differential (0
 * false negatives, which can ONLY hold if the peel was COMPLETE), so it is not re-derived
 * here. Throws an Error naming the first violation, or returns void.
 */
export function validateXor(filter) {
    const fw = filter._fw;
    const bl = filter._bl;
    const fp = filter._fp;
    const count = filter._count;
    const cap = filter._cap;

    if (fw !== 8 && fw !== 16) {
        throw new Error("[validate] XOR fingerprint width fw=" + fw + " is not 8 or 16");
    }
    if (!(bl >= 1)) {
        throw new Error("[validate] XOR segment length bl=" + bl + " out of range");
    }
    const expectedLen = 3 * bl;
    if (!fp || fp.length !== expectedLen) {
        throw new Error(
            "[validate] XOR store length " + (fp ? fp.length : String(fp)) +
            " != 3*bl=" + expectedLen);
    }
    if (!(count >= 1)) {
        throw new Error("[validate] XOR count=" + count + " must be >= 1 (a static filter over a non-empty set)");
    }
    if (count !== cap) {
        throw new Error("[validate] XOR count=" + count + " != capacity=" + cap);
    }
    const expectedBl = Math.ceil((1.23 * count) / 3) + 32;
    if (bl !== expectedBl) {
        throw new Error(
            "[validate] XOR segment length bl=" + bl + " != ceil(1.23*count/3)+32=" + expectedBl);
    }
    const fpMask = (1 << fw) - 1;
    for (let i = 0; i < fp.length; i++) {
        const v = fp[i];
        if (v < 0 || v > fpMask) {
            throw new Error("[validate] XOR slot " + i + " value " + v + " out of 0.." + fpMask);
        }
    }
}

/** Re-derive the Binary Fuse geometry from a deduped key count (decisions/0022), MIRRORING
 *  `_bfDims` in Filter.js. Test-only: the validator does not import module internals, so it
 *  reproduces the sizing math to cross-check the instance's stored geometry against its
 *  count. Returns { segLen, segCount, arrayLen }. */
function bfDims(n) {
    let segLen = 1 << Math.floor(Math.log(n) / Math.log(3.33) + 2.25);
    if (segLen > 262144) segLen = 262144;
    if (segLen < 4) segLen = 4;
    let segCount;
    if (n <= 1) {
        segCount = 1;
    } else {
        const sizeFactor = Math.max(1.125, 0.875 + 0.25 * Math.log(1000000) / Math.log(n));
        const capacity = Math.round(n * sizeFactor);
        const initSeg = Math.ceil(capacity / segLen) - 2;
        segCount = initSeg < 1 ? 1 : initSeg;
    }
    return { segLen: segLen, segCount: segCount, arrayLen: (segCount + 2) * segLen };
}

/**
 * Assert the CONSERVATION invariant for a BinaryFuse filter (test/debug only, O(slots)). A
 * Binary Fuse filter is STATIC (decisions/0022): built once, no fill counter to reconcile.
 * The teeth are STRUCTURAL soundness -- a store whose geometry does not tie back to the
 * deduped key count is a corrupt build:
 *
 *   fw is 8 or 16                                   (a byte-aligned fingerprint width)
 *   segLen is a power of two in [4, 262144]         (a valid, exact multiply-shift domain)
 *   segCount >= 1 && fp.length === (segCount+2)*sl  (arity 3 -> +2 overlap segments)
 *   (segLen, segCount) === _bfDims(count)           (the geometry is derived from count)
 *   count >= 1 && count === capacity                (built over >= 1 key; cap == count)
 *   scl === segCount * segLen                       (the stored multiply-shift domain)
 *   every slot is in 0..(1<<fw)-1                   (each word fits the fingerprint width)
 *
 * The "every present key resolves" law is proven at scale by the torture differential (0
 * false negatives, which can ONLY hold if the peel was COMPLETE), so it is not re-derived
 * here. Throws an Error naming the first violation, or returns void.
 */
export function validateBinaryFuse(filter) {
    const fw = filter._fw;
    const segLen = filter._segLen;
    const segCount = filter._segCount;
    const scl = filter._scl;
    const arrayLen = filter._arrayLen;
    const fp = filter._fp;
    const count = filter._count;
    const cap = filter._cap;

    if (fw !== 8 && fw !== 16) {
        throw new Error("[validate] BinaryFuse fingerprint width fw=" + fw + " is not 8 or 16");
    }
    if (!(segLen >= 4) || segLen > 262144 || (segLen & (segLen - 1)) !== 0) {
        throw new Error("[validate] BinaryFuse segLen=" + segLen + " is not a power of two in [4, 262144]");
    }
    if (!(segCount >= 1)) {
        throw new Error("[validate] BinaryFuse segCount=" + segCount + " out of range");
    }
    const expectedLen = (segCount + 2) * segLen;
    if (!fp || fp.length !== expectedLen) {
        throw new Error(
            "[validate] BinaryFuse store length " + (fp ? fp.length : String(fp)) +
            " != (segCount+2)*segLen=" + expectedLen);
    }
    if (arrayLen !== expectedLen) {
        throw new Error(
            "[validate] BinaryFuse _arrayLen=" + arrayLen + " != (segCount+2)*segLen=" + expectedLen);
    }
    if (scl !== segCount * segLen) {
        throw new Error(
            "[validate] BinaryFuse scl=" + scl + " != segCount*segLen=" + (segCount * segLen));
    }
    if (!(count >= 1)) {
        throw new Error("[validate] BinaryFuse count=" + count + " must be >= 1 (a static filter over a non-empty set)");
    }
    if (count !== cap) {
        throw new Error("[validate] BinaryFuse count=" + count + " != capacity=" + cap);
    }
    const d = bfDims(count);
    if (segLen !== d.segLen || segCount !== d.segCount) {
        throw new Error(
            "[validate] BinaryFuse geometry (segLen=" + segLen + ", segCount=" + segCount +
            ") != _bfDims(count=" + count + ") (segLen=" + d.segLen + ", segCount=" + d.segCount + ")");
    }
    const fpMask = (1 << fw) - 1;
    for (let i = 0; i < fp.length; i++) {
        const v = fp[i];
        if (v < 0 || v > fpMask) {
            throw new Error("[validate] BinaryFuse slot " + i + " value " + v + " out of 0.." + fpMask);
        }
    }
}
