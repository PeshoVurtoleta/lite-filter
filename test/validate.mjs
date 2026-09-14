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
