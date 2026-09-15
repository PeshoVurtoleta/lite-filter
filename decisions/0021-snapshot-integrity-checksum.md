# 0021 -- Family-wide snapshot integrity checksum (format litefilter/2)

Status: accepted (v0.6.0)

## Context

QA found a real fail-OPEN in `restore()`, systemic across the family. A snapshot's `keys`
mode and `seed` are FREE construction inputs: they select the hash path and the hash mixing,
and they CANNOT be re-derived from the stored bytes (unlike `m`/`k`/`nb`/`bl`, which are a
deterministic function of `(cap, fpp)` or `count` and are cross-checked). So a snapshot whose
`keys` field was flipped between its two legal values (`"int"` <-> `null`), or whose `seed`
was changed to another valid uint32, passed every structural door and reconstructed a filter
under the WRONG hash path -- reading back 1990/2000 keys as false negatives (the QA repro on a
2000-int-key XOR dump). The per-word range checks and the enum-legality checks cannot catch
this: both flipped values are individually legal. The only sound fix for a field that cannot
be re-derived is a stored INTEGRITY checksum computed at dump time over the whole snapshot.

## Decision

### A 32-bit checksum `chk`, family-wide, over provenance + sizing + store

`dump()` on EVERY member (Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter)
emits a new field `chk`: a 32-bit checksum computed in a FIXED deterministic order over

  1. the format tag (`"litefilter/2"`),
  2. the member name (`mem`),
  3. the keys-mode (folded as the token `"int"` or `"null"` -- so the two legal values
     check DISTINCT),
  4. the seed,
  5. the count/size,
  6. every sizing/width field the member emits (member-specific order: Bloom `m,k,cap,fpp`;
     CountingBloom `m,k,cap,fpp,w`; BlockedBloom `m,k,cap,fpp,bb,nb`; Cuckoo `fw,b,nb,cap,fpp`;
     Quotient `r,q,p,nslots,load,cap,fpp`; XorFilter `fw,bl,cap,fpp`),
  7. the store length and every store word in order (bits / cnts / fp / store).

It reuses the murmur3 `fmix32` substrate (no new deps, ASCII-only). Numbers fold by their
exact 64-bit bit pattern via one shared module-level scratch view, so ints, floats
(`fpp`/`load`), a seed above 2^31, and `-0` all fold canonically. This is a COLD-path
helper -- allocation is fine -- and it never touches `add`/`mightContain`/`remove`.

### Format tag bump `litefilter/1` -> `litefilter/2`

`restore()` REJECTS any snapshot whose tag is not exactly `"litefilter/2"`. A v1 snapshot
carries no `chk` and cannot be integrity-verified, so it is fail-closed. Nothing published
depends on cross-version restore; this is a deliberate breaking snapshot-format change on a
0.x line.

### restore() order: structural checks FIRST, then checksum, all before any write

Every member's `restore()` runs its existing structural doors first (tag, `mem`, enum
legality of `keys`, seed range, re-derived sizing, array length, per-word range, and for
Quotient the deep cluster-structure check), THEN recomputes the checksum from the snapshot's
OWN (possibly tampered) fields + store and REJECTS fail-closed if it does not equal `chk` --
ALL before any field is assigned or any array is built into the new instance. REJECT, never
truncate. A keys-mode flip, a seed flip, or any single-bit store/field corruption now throws
a `[lite-filter]` error instead of silently building a wrong filter.

### Honest scope: integrity, NOT authentication

`chk` catches ACCIDENTAL corruption and provenance drift (a flipped keys-mode/seed, a bit
rot, a truncated/garbled transfer). It is NOT a MAC: a determined forger who edits a field
AND recomputes `chk` is out of scope -- the same limitation every non-keyed checksum has. The
docstrings, decisions/0005, and decisions/0018 state this plainly rather than overclaiming
tamper-proofing.

## Consequences

- The keys-mode and seed fail-open (the QA repro) is closed for all six members; the torture
  GATE gains a `snapChk=ok` term proving a keys-flip and a store-bit flip are rejected for a
  representative mutable member (Bloom) and the static member (XorFilter).
- `Filter.d.ts` `FilterSnapshot` gains a REQUIRED `chk: number` (a `litefilter/2` snapshot
  always carries it, and `restore()` always demands it -- a missing/`NaN`/out-of-range `chk`
  is itself a fail-closed rejection). Existing "tamper a field ->
  expect throw" tests still pass (the structural door fires first where one applies; the
  checksum is a second net). A hand-built snapshot now needs a valid `chk` (route it through
  `dump()`), which the test-suite updates reflect.
- A previously-persisted `litefilter/1` snapshot will no longer restore. This is intended:
  such a snapshot cannot be integrity-verified, and silently trusting it is the very fail-open
  being closed. Re-`dump()` from a live filter to migrate.
- The number fold reads a JS number's two 32-bit halves in the HOST byte order, so `chk`
  assumes a little-endian host (every supported Node/V8 target -- x64, arm64 -- is
  little-endian). A snapshot moved between hosts of OPPOSITE endianness would fail to verify;
  this fails CLOSED (restore throws on the mismatch, never accepts corruption), consistent
  with the library's law. A future release may fold via a canonical byte order if a
  big-endian target is ever supported.

## Amendment (1.1.0, decisions/0023)

The format tag documented above as `litefilter/2` is now `litefilter/3` (decisions/0023): the
XOR / Binary Fuse string-key second hash changed from `fmix32(h ^ seed2)` to an INDEPENDENT
`hashStr(s, seed2)`, so a `litefilter/2` snapshot would read string keys FALSE and must be
rejected. The `chk` integrity door itself is UNCHANGED -- it still runs after the (now `/3`)
tag check and after each member's structural checks. One tag is one algorithm for the whole
family, so the bump re-tags even members whose bytes are unchanged (Bloom, int-mode filters);
their `chk` fold is identical, only the tag string advanced.
