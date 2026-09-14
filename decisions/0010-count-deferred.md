# 0010 -- CountingBloom multiplicity readout: DEFERRED

Status: deferred (recorded in v0.2.0)

## Context

CountingBloom stores a small COUNTER per position, not just a bit. A tempting
public feature is an approximate MULTIPLICITY readout -- "how many times was this key
added?" -- as `min` of the `k` counters, in the spirit of a Count-Min Sketch. It
would reuse the exact same store with no extra space.

## Decision

DEFER it. v0.2.0 ships `remove` and the boolean `mightContain` only; it does NOT
expose a multiplicity/`estimateCount` method. Two reasons:

1. **Honesty.** `min` of the `k` counters is an OVER-estimate under collisions and is
   further distorted by saturation (decisions/0008) -- a saturated counter reports 15
   forever. Shipping it as "the count" would overclaim, exactly what the bench's
   `% over theoretical` discipline exists to prevent. A real multiplicity feature
   needs its own measured error characterization first.
2. **Surface uniformity.** `estimateCount` is NOT part of `LiteFilter<K>` (Bloom
   cannot answer it). Adding it only to CountingBloom would fork the surface; if it
   ships it should ship as a clearly member-specific method with a gated error bound.

`size` / `count` remain a plain net add-call counter (decisions/0003), NOT a
per-key multiplicity.

## Consequences

- No premature, un-characterized `estimateCount` on the hot surface.
- If multiplicity ships later, it arrives with a measured error table (bench) and an
  explicit "over-estimate under collisions + saturation" caveat, not before.
