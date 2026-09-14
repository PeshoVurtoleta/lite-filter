# 0014 -- Cuckoo geometry: fingerprint width, bucket/kick pins, and the fail-closed overload

Status: accepted (v0.4.0)

## Context

A Cuckoo filter (Fan, Andersen, Kaminsky & Mitzenmacher, CoNEXT 2014) stores a small
NONZERO fingerprint per key in one of TWO candidate buckets of `b` slots each, using
partial-key cuckoo hashing. It DELETES (unlike Bloom / BlockedBloom) and is more space-
efficient than a Counting Bloom for the same deletable membership. The open questions are
the fingerprint width, the bucket size `b`, the eviction (kick) ceiling, the bucket-count
derivation, and what happens when an insert cannot find room.

## Decision

### Fingerprint width `f` -- derived, then byte-aligned UP

    f = ceil(log2(2b / fpp)) = ceil(log2(8 / fpp))   at b=4

then BYTE-ALIGN the store element UP: `f <= 8` -> an 8-bit `Uint8Array`; `9..16` -> a
16-bit `Uint16Array`. If the derived `f` exceeds 16 (very low fpp), construction THROWS a
`[lite-filter]` RangeError naming the smallest supported fpp at b=4 / 16-bit
(`fpp >= 8/65536 ~ 0.000122`). The uniform `{ fpp }` construction is preserved.

The byte-alignment means the ACTUAL fingerprint width is usually WIDER than the target
needs, so the delivered FPR (~`2b/2^f`) runs BELOW the configured `fpp`. At the default
`fpp = 0.01`: `f = ceil(log2(800)) = 10` -> a 16-bit store, delivered FPR `8/1024 =
0.0078` < 0.01. This is surfaced, NOT hidden: `fpp()` reports `2b/2^f` (the actual
width-quantized rate) once non-empty, and the bench prints measured vs this theoretical.
This is the family's measure-vs-configured honesty hook for Cuckoo.

### Bucket size `b = 4` and max kicks `500` -- PINNED

`b = 4` is the classic Cuckoo-filter sweet spot: it reaches ~95% load before insert
failures while keeping `f` (and the FPR) small. `500` kicks is the reference eviction
ceiling from Fan et al. Both are PINNED (not constructor options) so the hot path carries
no configurable geometry and the snapshot records `b` for a clean future break.

### Bucket count -- power of two from a load target

    nb = ceil(capacity / (b * 0.95))  rounded UP to a power of two

Power-of-two `nb` makes the bucket index a mask (`i1 = hash(key) & (nb-1)`) and keeps the
alt-bucket XOR an INVOLUTION:

    i1 = hash(key) & (nb-1)
    fp = nonzero fingerprint(key)          (fingerprint hash never emits 0; map 0 -> 1)
    i2 = (i1 XOR hash(fp)) & (nb-1)
    i1 = (i2 XOR hash(fp)) & (nb-1)        (the involution: re-masking recovers i1)

so an evicted fingerprint finds its alternate bucket from the fingerprint ALONE -- no key
needed. The REAL slot capacity is `nb*b >= capacity/0.95` (headroom); the `capacity`
getter returns the configured value and headroom is observable via `size` vs `capacity`.

### Overload -- add() THROWS (fail closed)

When both candidate buckets are full, `add` kicks a random victim to its alternate bucket
up to 500 times using a SINGLE scalar victim register. Each kick is a SWAP of the target
slot with the carried victim, and the touched slot indices are trailed in a preallocated
per-instance `Uint32Array(500)` (written only while kicking -- zero allocation). If 500
kicks are exhausted the table is at capacity and `add` UNWINDS the eviction chain back to
the EXACT pre-add state before it THROWS: it replays the recorded swaps in REVERSE order,
which restores every touched slot (correct even when a slot was touched more than once) and
leaves the new fingerprint in hand, unplaced. So **a thrown `add` mutates NOTHING** -- no
previously-inserted fingerprint is dropped, the table is byte-identical to its pre-add
state, and the no-false-negative guarantee holds even on overflow. `add` does NOT return a
boolean and does NOT silently drop a fingerprint (a drop would be a false negative). The
uniform `add(key) -> void` surface is preserved; overload is a fail-closed exception,
headroom is observable via `size` vs `capacity` before it bites.

(The unwind matters because the in-hand victim at exhaustion is NOT the new fingerprint --
it is whichever fingerprint was evicted last, typically a previously-inserted one. Dropping
it, or throwing from the half-mutated table, would leave the new `fp` resident and an
existing key unfindable: a false negative. Unwinding to pristine is the only correct
fail-closed behavior.)

## Consequences

- Space at `fpp = 0.01`: a Cuckoo runs ~2x a plain Bloom's bytes/item (byte-aligned
  16-bit slots at ~76% load ~ 21 bits/item vs Bloom's ~9.6), and buys DELETES plus an
  FPR that lands under the configured target. The static members (XOR / Binary Fuse) will
  win on raw space at very low fpp; Cuckoo wins on incremental add + delete.
- A duplicate-heavy key stream can overflow a bucket pair (Cuckoo stores a fingerprint per
  add and does not dedup); the bench's zipfian row shows this fail-closed overflow.
- The width-quantization and the overload door are both EXPOSED (fpp(), the bench, the
  throw), never papered over.
