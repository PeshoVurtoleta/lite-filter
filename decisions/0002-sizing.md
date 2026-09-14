# 0002 -- Sizing: (n, fpp) -> m, k, and fail-closed doors

Status: accepted (v0.1.0)

## Context

A Bloom filter is defined by its bit count `m` and hash count `k`. The caller
should express intent in the terms they actually know -- how many items (`n`) and
what false-positive rate they can tolerate (`fpp`) -- not raw `(bits, k)`.

## Decision

Construct as `new Bloom(capacity, { fpp })` and DERIVE the dimensions (ROADMAP
section 11.5, precedence: `(n, fpp)` is the surface; explicit `(bits, k)` is NOT
offered in v0.1.0):

    m = ceil(-n * ln(fpp) / ln(2)^2)      bits
    k = round((m / n) * ln(2))            hash positions, clamped to >= 1

`fpp` defaults to the textbook `0.01` when omitted -- an explicit, documented
default, never a hidden hot-path constant. The bit store is `ceil(m/32)` 32-bit
words in ONE `Uint32Array`, allocated once and reused forever.

### Fail-closed doors (null is not zero)

Every impossible request throws a `[lite-filter]` Error at the constructor door:

- `capacity` not an integer, or `< 1` -> RangeError.
- `fpp` not a number, or not in the OPEN interval `(0, 1)` (so `<= 0` and `>= 1`
  both throw) -> RangeError.
- a bit count that would overflow a safe typed-array word count (`m > 0x7fffffe0`)
  or is non-finite -> RangeError, BEFORE the allocation throws an opaque error.

An unsized filter is never silently treated as a zero-capacity one.

## Consequences

- Memory is O(m) up front, flat forever -- no growth path exists.
- `k` clamped to `>= 1` means even a pathological `(n, fpp)` yields a usable
  filter rather than a zero-hash no-op.
- The derivation is deterministic, which is what lets `restore()` (decisions/0005)
  re-derive `m`/`k` from `(cap, fpp)` and reject a snapshot whose recorded `m`/`k`
  disagree.
