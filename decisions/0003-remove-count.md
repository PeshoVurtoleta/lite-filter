# 0003 -- remove() scope, has() alias, and the presence counter

Status: accepted (v0.1.0)

## Context

The uniform surface offers `remove`, a `has`/`contains` alias, and a `size`/`count`
readout. Bloom cannot support all of them the way a deletable member can, and the
honest thing is to fail closed rather than pretend.

## Decision

### `remove()` -- fail closed on Bloom

A plain Bloom is ADD-ONLY. Clearing the `k` bits of a key would also clear bits
shared with OTHER keys, causing later FALSE NEGATIVES for keys that were never
removed -- silently breaking the one-sided guarantee. So `remove()` on Bloom throws
a `[lite-filter]` Error (ROADMAP section 11.3). It does NOT silently no-op. Deletable
members (Counting Bloom, Cuckoo, Quotient) will implement `remove` when the roster
ships them, with the documented "removing a never-added key can corrupt state" caveat.

### `has()` -- the SOLE alias

`mightContain` is the canonical name (it names the exact one-sided semantics).
`has` is the ONE readability alias, with identical semantics. We deliberately do
NOT also ship `contains` -- one canonical name plus at most one alias, never three
(ROADMAP section 2).

### `size` / `count` -- a plain add-call counter

`count` (and its alias `size`) is a plain integer incremented on every `add` -- the
number of adds recorded, NOT an estimate and NOT a distinct-key count. Bloom cannot
detect a duplicate `add`, so a caller adding the same key twice sees `count == 2`.
This is documented, never overclaimed as "distinct items". `fpp()` (decisions/0004)
uses this counter as its `n`.

## Consequences

- The surface stays uniform: every member exposes `has` / `size` / `count`, and
  `remove` is present-but-throwing on non-deletable members rather than absent.
- No hidden state corruption: a caller who needs deletes gets a loud error
  pointing at the deletable members, not a filter that quietly returns wrong
  answers later.
