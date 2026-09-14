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
