# 0019 -- XOR filter: surface degradation (no add/remove/clear on a static member)

Status: accepted (v0.6.0)

## Context

`LiteFilter<K>` is the uniform surface every member implements, and it includes `add`,
`remove` (on deletable members), and `clear`. The XOR filter is STATIC (decisions/0018):
its membership is fixed at construction. What should the mutation methods do on a member
that has no incremental mutation? Three honest options: (a) silently no-op, (b) reset/empty,
(c) throw fail-closed.

## Decision

### `add` / `remove` -- THROW `[lite-filter]` fail-closed

An XOR filter cannot accept a new key without rebuilding the entire hypergraph, and it
cannot delete one without breaking the XOR invariant for every key that shares a slot. Both
throw `[lite-filter]` with a message directing the caller to rebuild via
`XorFilter.from(newKeys)`. This mirrors Bloom's / BlockedBloom's `remove` throw
(decisions/0003): a silent no-op or silent corruption is never acceptable when the caller
clearly expects a mutation. `add` and `remove` are declared `never` in the type surface.

### `clear` -- THROW `[lite-filter]` fail-closed (NOT a no-op, NOT a reset)

This is the one that needed a ruling. `clear()` on the mutable members resets to EMPTY and
reuses the store. But an XOR filter has nothing to clear TO: its identity IS the key set it
was built from, and an "empty XOR filter" is undefined (there is no valid all-zero build
over zero keys -- decisions/0018's empty-set door already forbids `from([])`). A cleared XOR
filter would be a structurally invalid instance whose queries are meaningless. So `clear()`
THROWS rather than silently producing an undefined filter. This is the fail-closed law
applied literally: an unverified (here, undefinable) state is an error, not a silent zero;
null is not zero.

### `new XorFilter()` -- THROW `[lite-filter]`

There is no public constructor. A static member is built via the factory
(`XorFilter.from` / `.build`); `new XorFilter()` throws `[lite-filter]` directing the caller
to the factory. Internally the factories construct a bare instance via a module-private
build brand (a `Symbol` never exported), so the public `new` path always fails closed.

### What the surface KEEPS

`mightContain` / `has` / `size` / `count` / `capacity` / `fpp` / `stats` / `resetStats` /
`dump` are all present and behave identically to the other members, so a caller can still
swap an XOR filter in for a READ-ONLY membership use case. `stats.adds` stays 0 (build is not
`add()`); the other counters work.

## Consequences

- The type surface declares `add` / `remove` / `clear` as `never` (like Bloom's `remove`),
  so a caller who tries to mutate a static filter gets a compile-time error AND a runtime
  throw -- fail closed at both layers.
- The uniform `LiteFilter<K>` interface is NOT claimed by `XorFilter` (its `add` returns
  `never`, and it has no public constructor); it is a standalone class with the same query
  surface. A future "read-only membership" interface could unify the query subset, but that
  is out of scope here.
- Binary Fuse (the next static member) MUST make the identical ruling, so the two static
  members feel the same.
