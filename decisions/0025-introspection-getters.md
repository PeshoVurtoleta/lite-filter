# 0025 -- keysMode and seed: O(1) read-only config introspection on every member

Status: accepted (1.2.0)

## Context

Audit N2 (RESEARCH.md 1.5): a consumer (lite-hud M5) must detect whether a filter it was handed
is in `keys:'int'` mode. Today the only public routes are catching the int-key TypeError or
calling `dump()` (a full serialize) and reading `.keys`; the alternative is sniffing the private
`_int` field.

## Decision

Every member gains two read-only getters, O(1), zero allocation, off the hot path:

- `keysMode -> 'int' | 'arbitrary'` -- the two strings are module constants, never built per call.
- `seed -> number` -- the 32-bit unsigned hash seed.
  - Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient: the validated constructor seed.
  - XorFilter, BinaryFuse: the WINNING build seed (the build reseeds until peeling succeeds,
    decisions/0018, 0022); an unbuilt
    instance is not publicly constructible, so its internal 0 sentinel is never observable.

Both are typed on `LiteFilter<K>` so the one-line member swap still type-checks.

## Consequences

- Additive: no snapshot tag bump, no wire change. `dump().keys` stays as it is.
- The derived `seed2` is NOT exposed; `seed` alone determines behavior (decisions/0023).
