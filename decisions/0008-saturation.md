# 0008 -- CountingBloom saturation: clamp at 15, never wrap, never decrement

Status: accepted (v0.2.0)

## Context

A 4-bit counter (decisions/0007) holds 0..15. When a position is hit by more than 15
live keys, or the same key is added more than 15 times, the counter reaches its
ceiling. What happens at the ceiling determines whether the one-sided guarantee
survives: a naive `+1` would WRAP 15 -> 0, instantly turning a present key into a
false negative for every key sharing that position -- silent corruption.

## Decision

**Saturate (clamp), do not wrap.** On `add`, a counter already at 15 stays 15 (the
increment is skipped): `if (nib < 15) write(nib + 1)`. On `remove`, a counter at 15 is
NEVER decremented (only counters in 1..14 are decremented): `if (nib >= 1 && nib <= 14)
write(nib - 1)`. A saturated counter is therefore a one-way latch -- once at 15 it
stays 15 for the life of the filter (until `clear`).

This is the honest tradeoff: clamping keeps `mightContain` correct for present keys
(no wrap-induced false negative), at the cost that a saturated counter can no longer
track removals of its keys -- those keys STICK present (decisions/0009).

## Consequences

- No wrap: an added key never becomes a false negative because a shared counter
  overflowed. The one-sided guarantee holds for present keys under normal load.
- A saturated counter over-estimates: it can report a key present after it was
  removed. At a 1% fpp saturation is negligibly rare (decisions/0007), but it is a
  real, documented effect, not hidden.
- The conservation invariant `sum(nibbles) <= k * size` holds for workloads that do
  not drive a counter to 15 and then over-remove it; the torture churn keeps each key
  at multiplicity 1, so no counter saturates and the bound holds with margin.
