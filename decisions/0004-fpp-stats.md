# 0004 -- fpp() reporting and opt-in zero-GC stats

Status: accepted (v0.1.0)

## Context

Two cold readouts share a discipline: they must be HONEST about being estimates /
opt-in, and they must never cost the hot path anything when unused.

## Decision

### `fpp()` -- configured target, then fill-derived estimate

- On an EMPTY filter (`count == 0`), `fpp()` returns the CONFIGURED target passed
  at construction -- the design intent.
- Once keys are added it returns the closed-form ESTIMATE from the current fill:
  `(1 - e^(-k*n/m))^k`, with `n = count`.

This is a FORMULA, explicitly NOT a measurement of your keys. It assumes uniform,
independent hashing; under a real key distribution at high load factor the true FPR
runs OVER it (ROADMAP section 5). The docs point the caller at the bench to MEASURE.

### Opt-in stats -- `{ stats: true }`, `_stats === null` when off

`{ stats: true }` mints a per-instance holder `{ adds, queries, hits, misses }`
(a query returning `true` is a "hit" -- possibly a false positive; `false` is a
"miss"). OFF by default: `_stats === null`, so the hot path takes ONE predicted-
not-taken branch and writes NOTHING. `stats()` / `resetStats()` fail closed on a
non-stats instance (null is not zero -- there is no holder, that is a caller bug,
not zeros). Mirrors lite-lru D19 exactly, including the borrowed-holder-by-reference
contract.

## Consequences

- The zero-GC claim holds: the stats guard is the ONLY extra hot-path branch, and
  it is free when stats are off. The perf gate runs with stats OFF and proves 0 B/op.
- No overclaim ships: `fpp()` is labeled an estimate in the types, the README, and
  the source, so a caller never mistakes it for a measured rate.
