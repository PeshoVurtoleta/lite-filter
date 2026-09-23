# 0026 -- maxLoad and saturation: the real ceiling, stated as an UPPER BOUND

Status: accepted (1.2.0)

## Context

Audit N3 (RESEARCH.md 1.5): `size` can exceed `capacity`. Cuckoo(capacity 64) accepted 127 adds
before throwing, and Quotient(capacity 64) accepted 115, because `capacity` is the sizing input, not
the ceiling. The overload messages (`CUCKOO_FULL_MSG`, `QF_FULL_MSG`) told the user to "observe
headroom via size vs capacity", which is the wrong comparison.

The ceilings are not guarantees:

- Cuckoo: `nb * b` slots exist, but an insert can exhaust the 500-kick budget (decisions/0014)
  BEFORE every slot is full.
- Quotient: `floor(0.90 * nslots)` is the load ceiling (decisions/0016), but an insert whose
  cluster shift would run off the end of the slot array throws earlier.

A getter named `remaining` would read as a promise ("N more adds will succeed"), and that promise
cannot be kept.

## Decision

Every member gains two read-only getters, O(1), zero allocation:

- `maxLoad -> number` -- the hard item ceiling, documented as an UPPER BOUND: an add past it
  certainly throws; an add below it may still throw on Cuckoo and Quotient.
  - Cuckoo: `nb * b`.
  - Quotient: `floor(0.90 * nslots)` (the existing live `_maxLoad`, so it tracks `resize()`).
  - Bloom, BlockedBloom, CountingBloom: `Infinity` -- adds never fail; the FPR degrades instead
    (CountingBloom counters clamp, decisions/0008). Watch `fpp()`.
  - XorFilter, BinaryFuse: `size` once built (the set is frozen; `add` throws, decisions/0018).
    An unbuilt static instance is not publicly constructible (from() / restore() are the only
    doors), so the internal 0 sentinel is never observable.
- `saturation -> number` -- `size / maxLoad`, in [0, 1]. It is 0 when `maxLoad` is `Infinity`, and
  on a built static filter it is 1 (full by construction). It never reports NaN.

The overload messages change from "size vs capacity" to "saturation (size / maxLoad)", and note that
`maxLoad` is an upper bound.

## Consequences

- Additive; no snapshot or wire change.
- `capacity` keeps its meaning: the item count the filter was SIZED for. It is not a hard cap.
- Units pin `maxLoad` against the audit ceilings: Cuckoo(64) ceiling 128 with 127 accepted, and
  Quotient(64) ceiling 115.
