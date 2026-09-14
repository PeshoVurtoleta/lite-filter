# 0011 -- CountingBloom snapshot: same envelope, per-byte validation

Status: accepted (v0.2.0)

## Context

CountingBloom needs the same "persist a warm filter, bring it back warm" capability
as Bloom (decisions/0005), but its store is a packed `Uint8Array` of 4-bit counters,
not a `Uint32Array` bit array. The snapshot must round-trip through `structuredClone`
AND JSON, stay COLD (no new hot branch), and fail closed on ANY corruption.

## Decision

### `dump()` -- the counter store IS the serial form

`dump()` returns the shared fail-closed envelope with a member-specific store:

    { f: "litefilter/1", mem: "CountingBloom", w: 4, m, k, cap, fpp, seed,
      keys: "int" | null, count, cnts: number[] }

`w: 4` records the counter width (decisions/0007) so a future width change is a clean,
detectable break. `cnts` is the packed nibble store emitted as a plain array of bytes.

### `restore(snap, opts?)` -- STATIC, fail-closed, REJECT never truncate

`restore` is STATIC, builds a FRESH instance, re-derives `(m, k)` from `(cap, fpp)`,
and REJECTS on ANY of: a bad `f` tag; `mem` not `"CountingBloom"` (so a Bloom snapshot
is refused, and vice versa); `w` not 4; a non-uint32 `seed`; a bad `keys` mode; a
re-derived `m`/`k` mismatch; a `cnts` that is not an array of exactly `ceil(m/2)`
bytes; a negative/non-integer `count`.

Crucially, EVERY element of `cnts` is validated to be an exact byte `0..255` BEFORE
any instance field is mutated. A byte in `0..255` guarantees BOTH packed nibbles are
`0..15` by construction, so the per-nibble bound is enforced implicitly. A `>>> 0`
coercion is deliberately NOT used -- it would silently turn a garbled value into a
wrong counter and cause a false negative on a previously-added key. On any bad input,
zero instances are built (null is not zero).

## Consequences

- A restored CountingBloom is byte-identical to the original -- same membership, same
  remove behavior. The Snapshot suite asserts round-trip + corruption rejection.
- The `mem` + `w` tags make the family's snapshots mutually exclusive: no member can
  silently load another member's (or another width's) store.
