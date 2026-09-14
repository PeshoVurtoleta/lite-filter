# 0012 -- BlockedBloom block size: 512 bits, pinned, not configurable

Status: accepted (v0.3.0)

## Context

A plain Bloom filter scatters its `k` bit probes across the whole `m`-bit array via
enhanced double hashing (decisions/0001), so a single `mightContain` can touch up to
`k` different cache lines -- `k` cache misses on a cold store. A BLOCKED Bloom filter
fixes this: partition the bit array into equal BLOCKS, route each key to exactly ONE
block from its first base hash, and place all `k` bits INSIDE that block. A query then
touches ONE cache line regardless of `k` -- the throughput win. The open question is
the block SIZE and whether to expose it.

## Decision

Use a **512-bit block** -- 16 x 32-bit words = 64 bytes, exactly ONE cache line on
x86-64 and Apple Silicon. It is PINNED: the ONLY production path, NOT a constructor
option. 512 bits is the sweet spot the high-performance blocked-Bloom / XOR / ribbon
implementations converge on -- large enough that `k` odd-stride positions stay
distinct (k is clamped to <= 512, decisions/0013 for the FPR consequence), small
enough to be a single cache line.

### Store layout

    _nb    = ceil(m / 512)              block count (>= 1, fail-closed)
    _words = new Uint32Array(_nb * 16)  16 words per block, one flat array

`m` and `k` are the SAME `(n, fpp)` derivation as Bloom (decisions/0002), so a
BlockedBloom and a Bloom sized for the same target share `m` and `k`.

### Hot-path address math (add / mightContain, zero-alloc)

From the a/b double-hash pair (unchanged from decisions/0001):

    base = (a % _nb) << 4               first word of the chosen block
    p0   = b & 511                      start position within the block
    st   = ((b >>> 9) | 1) & 511        stride, forced ODD via | 1
    pos  = (p0 + i*st) & 511            i-th within-block position (i in 0..k-1)
    word = _words[base + (pos >>> 5)];  bit = 1 << (pos & 31)

The block index comes from the FIRST hash `a`; the within-block positions come from
the SECOND hash `b` (start + odd stride) so the two are independent. An odd stride is
coprime with 512, so the `k <= 512` positions a key visits inside its block are
distinct. There is NO new branch inside the existing `Bloom` class -- BlockedBloom is
its own class in `Filter.js` (mirroring how CountingBloom was added).

### Sizing doors (fail closed, null is not zero)

Inherit Bloom's doors (capacity integer >= 1; fpp in the open (0,1); overflowing `m`)
PLUS: `_nb >= 1` (a zero-block filter is never valid) and a store word-count overflow
guard (`_nb * 16 <= 0xffffffff`) so the allocation never throws opaquely.

## Consequences

- A query is ONE cache miss instead of up to `k`, the reason BlockedBloom exists.
- 512 being pinned keeps the hot path branch-free of a configurable block size and the
  snapshot records `bb: 512` + `nb` so a future block-size change is a clean break.
- Routing to a single block loses cross-block independence -- the FPR penalty -- which
  is its own ruling (decisions/0013), EXPOSED and MEASURED, never hidden.
