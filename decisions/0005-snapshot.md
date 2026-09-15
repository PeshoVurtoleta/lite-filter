# 0005 -- Snapshot: dump() + static restore(), fail-closed

Status: accepted (v0.1.0); AMENDED v0.6.0 (format litefilter/2 + integrity checksum,
decisions/0021)

> AMENDMENT (v0.6.0). The format tag is now `"litefilter/2"` and every snapshot carries a
> 32-bit integrity checksum `chk` (decisions/0021). The `keys` mode and `seed` cannot be
> re-derived from the stored bytes, so a flipped `keys`/`seed` used to reconstruct a wrong
> filter silently (the QA fail-open); `restore()` now recomputes `chk` and rejects any
> provenance or store corruption fail-closed. The `chk` is an INTEGRITY check against
> accidental corruption, NOT a MAC -- a determined forger who recomputes `chk` is out of
> scope. The v1 tag/shape below is retained for history; the live shape adds `chk` and uses
> tag `litefilter/2`, and a v1 snapshot is now REJECTED (it cannot be integrity-verified).

## Context

"Persist a warm filter and bring it back warm" -- write the bit store to disk / IPC
/ a worker and reconstruct it so it answers membership IDENTICALLY, instead of
re-adding every key. The constraints are the suite's: zero allocation on every
EXISTING hot path (dump/restore are COLD, no substrate field, no new hot branch),
fail closed on unverified state, and an EXACT round-trip.

## Decision

### `dump()` -- the typed array IS the serial form

`dump()` returns a plain, structurally-cloneable object graph (plain arrays + plain
numbers, NO typed-array views), so it round-trips through `structuredClone` AND JSON.
Because the store is already a flat `Uint32Array`, the snapshot is close to a raw
byte copy -- much cheaper than lite-lru's per-slot graph. The tag:

    { f: "litefilter/1", mem: "Bloom", m, k, cap, fpp, seed,
      keys: "int" | null, count, bits: number[] }

### `restore(snap, opts?)` -- STATIC, fail-closed, REJECT never truncate

`restore` is STATIC and builds a FRESH instance. It re-derives `(m, k)` from the
recorded `(cap, fpp)` (deterministic, decisions/0002) and REJECTS the snapshot on
ANY of:

- `f` not `"litefilter/1"` (bad / foreign / future format);
- `mem` not `"Bloom"` (member mismatch);
- re-derived `m` != `snap.m`, or re-derived `k` != `snap.k` (hand-edited / foreign);
- `seed` not a valid uint32, or `keys` not exactly `"int"` / `null`;
- `bits` not an array of exactly `ceil(m/32)` words (corrupt / short store) -- it is
  REJECTED, never truncated to fit;
- `count` not a non-negative integer;
- the recomputed `chk` != `snap.chk` (v0.6.0, decisions/0021) -- this catches the flipped
  `keys`/`seed` that the structural checks above cannot (both flipped values are individually
  legal). The checksum is recomputed AFTER the structural checks and BEFORE any write.

`opts` re-derives runtime-only state (`stats`); everything structural comes FROM the
snapshot. A rejected snapshot throws a `[lite-filter]` Error -- never a silently
empty or wrong filter (null is not zero).

## Consequences

- A restored filter is bit-identical to the original, so it makes the SAME
  membership decisions -- the torture and boundary suites assert it.
- The `mem` field makes the snapshot forward-compatible: a future member's
  `restore` rejects a `Bloom` snapshot and vice versa.
