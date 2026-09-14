# 0006 -- Static-member build API (DEFERRED)

Status: deferred (recorded in v0.1.0, resolved with the first static member)

## Context

The STATIC members on the roadmap -- XOR (Graf & Lemire, JEA 2020) and Binary Fuse
(Graf & Lemire, JEA 2022) -- are built ONCE from a KNOWN set of keys and support no
inserts afterward. They approach the ~1.23x information-theoretic space lower bound
by peeling a k-uniform hypergraph, which requires the whole key set up front. Their
construction API is therefore fundamentally different from the mutable members'
incremental `add`, and it is the single biggest surface change the family will make.

## Decision

DEFER the ruling to the first static member (ROADMAP section 11.2). v0.1.0 ships
only mutable Bloom, whose `add` is incremental, so nothing here is load-bearing yet.
Recording the two candidates so the choice is made deliberately, not by accident:

1. **add-then-`freeze()`** -- populate via the SAME `add` surface, then a one-time
   `freeze()` that peels the graph and switches `mightContain` on. Keeps the surface
   uniform (every member has `add`), at the cost of a stateful "frozen" flag and an
   `add`-after-freeze fail-closed door.
2. **static `Member.from(iterable, opts)`** -- a factory that consumes a known set
   directly, and `add` throws `[lite-filter]` on the instance from the start. More
   honest about the static nature; less uniform with the mutable members.

Whichever is chosen MUST be uniform across XOR and Binary Fuse, and MUST keep the
peel's RETRY count observable (a real cost that separates XOR from Binary Fuse, per
the bench).

## Consequences

- The v0.1.0 snapshot shape (decisions/0005) is unaffected; a static member adds its
  own fields under the same `mem`-tagged, fail-closed envelope.
- Bloom's `add` stays incremental and un-gated; there is no premature "frozen"
  machinery on the hot path today.
