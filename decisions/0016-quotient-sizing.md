# 0016 -- Quotient geometry: sizing/split, storage word, the fail-closed load ceiling, and resize/merge from stored pairs

Status: accepted (v0.5.0)

## Context

A Quotient filter (Bender, Farach-Colton, Johnson, Kraner, Kuszmaul, Medjedovic, Montes,
Shetty, Spillane & Zadok, "Don't Thrash: How to Cache Your Hash on Flash", VLDB 2012) is
ONE open-addressed slot array. A key's hash splits into a QUOTIENT (the home slot index) and
a REMAINDER (stored). Same-home keys form a RUN; adjacent runs form a CLUSTER under linear
probing; 3 metadata bits per slot (is_occupied, is_continuation, is_shifted) encode the
structure. Unlike Cuckoo it deletes without eviction chains, and -- the reason it earns its
place in the roster -- it can MERGE and RESIZE from its stored fingerprints alone. The open
questions are the remainder width, the storage word, the quotient/remainder split, what
happens when an insert cannot place, and how resize/merge preserve membership without the
original keys.

## Decision

### Remainder width `r` and the byte-aligned slot word

    r = ceil(log2(1 / fpp))

The slot WORD packs the remainder in the HIGH bits and 3 metadata bits in the LOW bits:

    word = (remainder << 3) | (is_shifted << 2) | (is_continuation << 1) | is_occupied

so a slot word is `r + 3` bits, BYTE-ALIGNED UP: `r + 3 <= 8` (r <= 5) -> a `Uint8Array`;
`r + 3 <= 16` (r 6..13) -> a `Uint16Array`. `r + 3 > 16` (fpp below ~1/2^13 ~ 0.000122)
exceeds the 16-bit slot word and THROWS a `[lite-filter]` RangeError at construction -- the
byte-aligned floor, parallel to Cuckoo's 16-bit fingerprint floor (decisions/0014).

A slot is EMPTY iff all three metadata bits are 0. **Remainder 0 is a LEGAL remainder** --
emptiness is carried by the metadata, never by the remainder value. (`restore()` enforces
the converse: a slot with metadata 0 must have a 0 remainder, or it is unreachable garbage.)

Because r is rounded UP, the delivered FPR runs BELOW the configured target. At `fpp = 0.01`,
`r = 7` (2^-7 = 0.0078). `fpp()` reports the honest remainder-quantized characteristic rate
`load * 2^-r` once non-empty (`load = size / nslots`): the expected fraction of occupied home
slots times the per-comparison remainder-collision probability. This is the family's measure-
vs-configured honesty hook for the Quotient; the bench prints measured vs this theoretical.

### Slot count, the quotient/remainder split, and the 32-bit budget

    nslots = smallest 2^q with 2^q >= ceil(capacity / 0.90)     (LOAD = 0.90)

The base hash is one 32-bit `fmix32`. It splits with the QUOTIENT taken from the HIGH bits
and the REMAINDER from the LOW bits (PINNED, kept consistent with `resize`/`restore`):

    hv        = fmix32(key) & pMask            (p = q + r low bits of the hash)
    remainder = hv & ((1 << r) - 1)            (low r bits)
    quotient  = (hv >>> r) & (nslots - 1)      (next q bits)

`q + r` must fit one 32-bit hash; `q + r > 32` (very large capacity) THROWS a `[lite-filter]`
RangeError. A fail-closed too-large door caps the slot count before the doubling loop
(mirrors `cuckooSizeFor`'s `MAX_NB`), so the derivation stays in the Number domain and can
never 32-bit-overflow into a spin.

### Linear array + GUARD spillover (not circular)

The filter is LINEAR, not circular. The quotient range is `[0, nslots)`, but the PHYSICAL
array carries GUARD spillover slots beyond it (`max(1024, nslots >> 3)`) so a cluster whose
home is near the top can shift right without immediately running off the end. A linear array
makes the fail-closed unwind trivial (no wrap-around bookkeeping) and matches the family's
"observe headroom, then fail closed" posture.

### Overload -- add() THROWS (fail closed), a byte-identical no-op

An insert THROWS a `[lite-filter]` Error when EITHER the occupancy would exceed the 0.90 load
ceiling (`count >= floor(0.90 * nslots)`, checked before any mutation) OR the linear cluster
shift would run off the end of the physical array (the empty-slot scan reaches the end). Both
checks happen BEFORE any write, so **a thrown `add` mutates NOTHING** -- the store is byte-
identical to its pre-add state and no previously-added key is dropped (the no-false-negative
guarantee holds even on overload). This parallels Cuckoo's fail-closed overload
(decisions/0014); a Quotient stores MULTIPLICITY (it does not dedup, like Cuckoo), so a
duplicate-heavy key stream can reach the ceiling and fail closed, never a silent drop. The
uniform `add(key) -> void` surface is preserved; headroom is observable via `size` vs
`capacity` before it bites.

### Delete -- rebuild the affected cluster (provably-correct metadata repair)

The one place a subtle bug passes the false-negative tests but breaks structure is the shift-
back metadata repair. Rather than a bespoke bit fixup, `remove` REBUILDS the affected cluster:
it identifies the maximal non-empty run `[cs, ce)` around the deleted slot (clusters are
separated by empty slots, so this touches no other cluster), collects the surviving
`(home, remainder)` pairs, clears `[cs, ce)`, and re-inserts the survivors through the SAME
verified insert path. The repair is therefore correct BY CONSTRUCTION. The cluster scratch is
preallocated (sized to the physical length), so `remove` stays zero-allocation. `validate.mjs`'s
`validateQuotient` (metadata-set-slot count == size; per-cluster #homes == #runs; sorted runs;
cluster-start not shifted/continuation) is the structural backstop the torture suite runs after
churn.

### resize() and merge() from stored pairs -- the fixed bit budget `p`

`resize(newCapacity)` and `merge(other)` ship now as COLD paths (they MAY allocate; the hot
`add`/`mightContain`/`remove` stay zero-allocation). Both reconstruct each element's full
fingerprint as `(quotient << r) | remainder` -- **without the original keys** -- and re-insert
it. For membership to survive this without the keys, the fingerprint bit budget `p = q0 + r`
is FIXED for the filter's lifetime (`resize` changes the slot count but never `p` or `r`):

- because `p` is fixed, a stored pair fully recovers its `p`-bit fingerprint, and BOTH a re-
  inserted survivor AND a fresh key query split it identically (`quotient = (fp >>> r) &
  (nslots - 1)`), so resize preserves membership (0 false negatives) for BOTH grow and shrink,
  and preserves exact size;
- the honest limit: the discarded high hash bits cannot be recovered without the keys, so a
  quotient never carries more than `q0` bits of entropy. Resizing LARGER than the original
  quotient width adds empty headroom (lower load -> fewer collisions on the shared bits) but
  not new quotient entropy; resizing SMALLER truncates the quotient consistently for stored
  elements and fresh queries (membership still holds, at a higher FPR).

`resize` sizes for `max(newCapacity, current count)` so it can never be asked to lose data.
`merge(other)` REJECTS fail-closed unless `other` is an identically-configured `Quotient`
(same `seed`, `r`, fixed budget `p`, and keys mode) -- otherwise the split would misalign and
corrupt membership. It grows this filter to hold both, then re-inserts every pair from
`other`. Both preserve membership (0 false negatives) and exact additive size.

### Snapshot

`dump()` emits `mem: "Quotient"` with `{ r, q, p, nslots, load, store, tag/seed/keys/cap/
fpp/count }` (q and nslots track a resize; p is the fixed budget). `Quotient.restore()`
REVALIDATES every field and every slot word BEFORE any mutation: the store length must equal
`nslots + guard` (guard is deterministic from nslots), each word must fit `r + 3` bits, an
empty slot (metadata 0) must have a 0 remainder, and the metadata-set-slot count must equal
the recorded size. REJECT, never truncate (decisions/0005); null is not zero.

## Consequences

- Space at `fpp = 0.01`: a Quotient runs ~23 bits/item (16-bit slot words at ~76% load, plus
  the guard) -- wider than a plain Bloom (~9.6) and comparable to Cuckoo (~21), the metadata +
  shift + guard overhead being the price of in-place delete AND merge/resize. The static
  members (XOR / Binary Fuse) will win on raw space at very low fpp.
- It is the first family member that MERGES and RESIZES without the original keys -- the reason
  to reach for it over Cuckoo when a filter must grow or combine over its lifetime.
- The load ceiling, the linear-end overload, the width-quantization, and the fixed-`p` resize
  limit are all EXPOSED (fpp(), the bench, the throw, this record), never papered over.
