# 0013 -- BlockedBloom FPR penalty: exposed and measured, not compensated

Status: accepted (v0.3.0)

## Context

A plain Bloom filter's textbook `fpp = (1 - e^(-k*n/m))^k` assumes all `k` probe
positions are independent and uniform over the whole `m`-bit array. BlockedBloom
breaks that assumption on purpose (decisions/0012): every key is confined to ONE
512-bit block. Keys are NOT distributed perfectly evenly across blocks -- some blocks
receive more keys than the average -- and a fuller block has a higher local fill and
thus a higher local FPR. Because FPR is convex in fill, the AVERAGE over an uneven set
of blocks runs OVER the FPR of a perfectly even fill. So for the SAME bits/item, the
measured FPR of a BlockedBloom is HIGHER than a plain Bloom's. The question is whether
to hide this (by silently upsizing `m`) or expose it.

## Decision

**EXPOSE and MEASURE the penalty; do NOT compensate for it by upsizing `m`.**

- `m` and `k` are the SAME `(n, fpp)` derivation as Bloom (decisions/0002). We do NOT
  quietly inflate `m` to buy back the lost independence -- that would smuggle a "same
  fpp for free" claim onto a hot path and hide the real tradeoff.
- `fpp()` returns the plain-Bloom closed-form `(1 - e^(-k*n/m))^k` LABELED as a FLOOR
  (a lower bound), NOT a prediction. The docstring and `Filter.d.ts` state that the
  measured rate runs OVER it. It is honest to report the floor; it is dishonest to
  present it as the expected rate.
- The bench (`benchmark/Bench.mjs`) prints Bloom vs BlockedBloom SIDE BY SIDE at the
  same bits/item across all four workloads: query ns (BlockedBloom LOWER -- the win)
  and measured FPR (BlockedBloom HIGHER -- the price). This side-by-side is the
  mandatory honesty output; there is no "same fpp for free" claim anywhere.
- The torture gate pins an HONEST looser ceiling for BlockedBloom (n=1e5, fpp=0.01,
  1e6 probes -> measured FPR <= 0.0175) AND asserts the measured FPR is > 0.00949 (the
  plain-Bloom theory) on at least one workload, so the penalty is PROVEN present, not
  assumed away.

`k` is clamped to <= 512 (a block only has 512 distinct positions); the within-block
walk uses an odd stride (coprime with 512) so those positions are distinct. A key
route that correlated the block index with the within-block positions would skew the
FPR further; the block index derives from the FIRST hash `a` and the positions from
the SECOND hash `b`, keeping them independent (the uniform-workload bench row is the
check).

## Consequences

- The user trades a modestly higher FPR for one cache miss per query -- a clear,
  measured tradeoff, chosen with eyes open.
- To hit a target measured FPR, a caller raises the configured `fpp` slightly or
  measures with the bench -- never trusting the floor as the delivered rate.
- The GUIDE.md row for "maximum query throughput -> BlockedBloom" carries the
  FPR-penalty caveat inline.
