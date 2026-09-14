# 0001 -- Hashing: murmur3 fmix32 + enhanced double hashing

Status: accepted (v0.1.0)

## Context

A probabilistic filter needs `k` hash positions per key, and the QUALITY of the
hash directly drives whether the MEASURED false-positive rate tracks the textbook
formula (ROADMAP section 5). A weak or biased hash makes the observed FPR run over
theory. Three key shapes matter: 32-bit integers (the strict-zero-alloc path),
strings, and arbitrary values. And computing `k` independent hashes must NOT
allocate a `k`-length array on the hot path.

## Decision

### Mixer -- murmur3 `fmix32`

The default finalizer is murmur3's 32-bit avalanche `fmix32` (xor-shift + two
`Math.imul` odd-constant multiplies + xor-shift). `Math.imul` is an EXACT 32-bit
multiply, so it is zero-alloc and never promotes to a heap double. A single input
bit spreads across the whole word -- the property the FPR-vs-theory bench validates,
NOT reputation.

### `keys:'int'` fast path -- no encoding

A 32-bit signed integer key is mixed DIRECTLY: `a = fmix32(key ^ seed)`,
`b = fmix32(imul(key, PHI) ^ seed2)`. No string encoding, no allocation at all.
Out-of-range / non-integer keys throw a `[lite-filter]` TypeError at the door
(INT_MIN..INT_MAX = 32-bit signed). Mirrors lite-lru's `keys:'int'` door exactly.

### String path -- code-unit hash, alloc-free

A string hashes over its UTF-16 code units with a murmur3-style body
(`charCodeAt` returns a number -- no allocation). So STRING keys on the default
backing are also zero-alloc. Only a non-string, non-int key pays a single
`String()` encode -- the honest AMORTIZED caveat, stated not hidden.

### `k` positions -- Kirsch-Mitzenmacher enhanced double hashing

All `k` probe positions come from TWO base hashes: `pos_i = (a + i*b) mod m`,
`i = 0..k-1`, with `b` forced ODD so successive positions do not collapse. `a + i*b`
is reduced mod 2^32 (`>>> 0`) before `mod m`. This gives `k` independent-enough
probes with ZERO scratch storage and only two real hash computations per op
(Kirsch & Mitzenmacher, "Less Hashing, Same Performance", 2006).

### Seed

A fixed default seed makes behavior deterministic across runs; `{ seed }`
overrides it, and the second base seed is derived from the first so one `{ seed }`
fully determines behavior.

## Consequences

- `add` / `mightContain` allocate zero bytes on the int and string paths; the
  perf gate proves 0 B/op on `keys:'int'`.
- The bench's `% over theoretical` column is the acceptance test for hash quality:
  a mixer that makes measured FPR blow past theory would be REJECTED here.
