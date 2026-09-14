# 0007 -- CountingBloom counter width: 4-bit nibbles, two per byte

Status: accepted (v0.2.0)

## Context

A Counting Bloom filter replaces Bloom's single bit per position with a small COUNTER
per position, so it can decrement on `remove`. The counter width is the central space
tradeoff: too narrow and it saturates (overflows) often, corrupting deletes; too wide
and it throws away the whole point of a probabilistic filter (a handful of BITS per
item). It must also pack into a preallocated typed array with ZERO per-op allocation,
exactly like Bloom's `Uint32Array` bit store.

## Decision

Use **4-bit counters (nibbles), two packed per byte**, in ONE preallocated
`Uint8Array` of `ceil(m/2)` bytes. A counter at position `pos` lives in byte
`pos >> 1`; the low nibble (`sh = 0`) for even `pos`, the high nibble (`sh = 4`) for
odd `pos`. Read is `(byte >> sh) & 0x0f`; write is
`(byte & ~(0x0f << sh)) | (value << sh)` -- pure 32-bit integer ops, no allocation.

4 bits is the standard Counting Bloom width (Fan, Cao, Almeida & Broder, 2000): at a
1% target fpp the per-position load is Poisson with a small mean (`k*n/m ~ 0.7`), so
the probability a counter reaches its ceiling of 15 is negligible. It costs ~4x a
plain Bloom's space (4 bits vs 1) -- the honest price of `remove()`.

Rejected: 8-bit counters (2x the space of nibbles for a ceiling nobody reaches at a
1% fpp); a parallel second bit array (does not carry a count, cannot decrement
correctly under collisions).

## Consequences

- The store is a `Uint8Array`, sized ONCE from the same `(n, fpp)` sizing as Bloom
  (decisions/0002), reused forever; `clear()` zeroes it in place (same ArrayBuffer).
- A counter CAN saturate at 15; that ceiling is handled as its own ruling
  (decisions/0008) rather than by widening the counter.
- The snapshot records `w: 4` so a future width change is a clean, detectable break
  (decisions/0011).
