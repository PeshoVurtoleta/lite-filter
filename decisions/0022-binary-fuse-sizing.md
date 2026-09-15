# 0022 -- Binary Fuse filter: sizing, segment geometry, and the small-n clamp

Status: accepted (v1.0.0)

## Context

The Binary Fuse filter (Graf & Lemire, "Binary Fuse Filters: Fast and Smaller Than Xor
Filters", ACM Journal of Experimental Algorithmics, 2022) is the family's 7th and FINAL
member. It is a construction-algorithm SWAP over the XOR filter (decisions/0018), not a new
surface: same static build API, same immutable surface (decisions/0019), same byte-aligned
width door (decisions/0020), same snapshot v2 + integrity checksum (decisions/0021), same
deterministic reseed and the same `sp !== n` peel-completeness guard. The ONLY change is the
geometry: XOR's 3 equal DISJOINT segments become 3 OVERLAPPING fuse segments selected by a
multiply-shift, which pack to ~1.13x (vs XOR's ~1.23x) and peel faster.

The charter flagged the exact sizing constants as a DO-NOT-GUESS risk: a wrong segment
formula silently mis-locates slots and produces false negatives (the fail-open class). This
document pins the constants to the paper and its canonical reference implementation.

## Decision

### Source of the constants (cited, not guessed)

The formulas below are taken verbatim from the FastFilter reference implementation
`binaryfusefilter.h` (the canonical single-header C reference accompanying Graf & Lemire
2022), functions `binary_fuse_calculate_segment_length`,
`binary_fuse_calculate_size_factor`, and `binary_fuse8_allocate`, for **arity 3**. The
reference comments the segment-length constants "very sensitive" -- replacing `floor` by
`round` substantially changes construction time -- so they are reproduced exactly.

### Arity 3 (PINNED)

Every key touches exactly 3 fingerprint slots, one in each of 3 CONSECUTIVE segments. Arity
3 fixes the ~1.125 load factor and the segment-length formula; it is not a tunable.

### Segment length `sl` (a power of two)

```
sl = 1 << floor( log(n) / log(3.33) + 2.25 )
sl = clamp(sl, 4, 262144)
```

`3.33` is the log base, `+2.25` the offset; both are the paper's tuned arity-3 constants. The
lower clamp is 4 (the reference's `size == 0 ? 4` floor, which also covers the tiny-n regime);
the upper clamp is `2^18 = 262144` so a segment index stays small and the multiply-shift
stays exact. `sl` is always a power of two -- this is load-bearing: the within-segment offset
is `^ (h & (sl-1))`, and stepping to the next segment is `+ sl`, which never disturbs the low
`log2(sl)` bits, so the three slots always land in three DISTINCT consecutive segments (the
XOR peeling trick is never self-corrupted).

### Size factor and segment count `sc`

```
sizeFactor = max( 1.125, 0.875 + 0.25 * log(1e6) / log(n) )        (n > 1)
capacity   = round( n * sizeFactor )                                (n > 1)
initSeg    = ceil( capacity / sl ) - (arity - 1)   = ceil(capacity/sl) - 2
sc         = max( 1, initSeg )                                      (n > 1)
```

The asymptotic 1.125 load (12.5% overhead, vs XOR's 23%) is the headline; the `log`
correction adds slack at small `n`, where a 3-uniform hypergraph is harder to peel.

### Array length and the multiply-shift domain

```
arrayLen = (sc + 2) * sl          (arity 3 -> +2 trailing overlap segments)
scl      = sc * sl                (SegmentCountLength -- the multiply-shift domain)
```

A key's first slot is `mulhiU32(h, scl) in [0, scl)` (Lemire multiply-shift:
`floor(h * scl / 2^32)`), its second and third are one and two segments further, each
perturbed within-segment. Since the first slot's segment is in `[0, sc)` and the array spans
`sc + 2` segments, every slot stays in `[0, arrayLen)`.

### The small-n clamp -- reconciling the reference's uint32 wraparound

The reference computes `sc` in two steps (`initSegmentCount`, then a re-derivation from
`ArrayLength`) that, for `n <= 1`, UNDERFLOWS through unsigned 32-bit wraparound and lands at
`sc = 1`. JavaScript has no such wrap, so we clamp explicitly: `sc = max(1, initSeg)` for
`n > 1`, and `sc = 1` for `n <= 1` (with `sizeFactor`/`capacity` taken as 0 there, matching
the reference's `size <= 1 ? 0` guard). This reproduces the reference's final geometry
without relying on wraparound. Verified edge cases:

| n | sl | sc | arrayLen | slots/item |
|---|----|----|----------|------------|
| 1 | 4 | 1 | 12 | 12.00 |
| 2 | 4 | 1 | 12 | 6.00 |
| 3 | 8 | 1 | 24 | 8.00 |
| 100 | 64 | 1 | 192 | 1.92 |
| 1e5 | 2048 | 56 | 118784 | 1.19 |
| 1e6 | 8192 | 136 | 1130496 | 1.1305 |

`n = 1` and `n = 2` share `sl = 4, sc = 1` (12 slots) -- both dominated by the minimum
segment length. `n = 0` (an empty set, including a duplicate-only input that collapses to
nothing distinct) THROWS `[lite-filter]` fail-closed: a filter over zero keys is undefined
(null is not zero).

### Everything else reused from XOR unchanged

Static build API + `.build` alias (decisions/0018); keys are a SET (dedupe); the immutable
surface -- `add`/`remove`/`clear`/`new BinaryFuse()` all throw (decisions/0019); the
byte-aligned width door -- fw 8 for `fpp >= 2^-8`, 16 for `2^-16 <= fpp < 2^-8`, throw below
(decisions/0020); the deterministic reseed `seed ^ (attempt * 0x9e3779b1)` up to 100 attempts
then throw; the `if (sp !== n) return null` peel-completeness guard BEFORE any fingerprint
assignment (the signature fail-open catch); and the snapshot v2 envelope with the family-wide
`chk` integrity checksum (decisions/0021).

## Consequences

- Space at `fpp = 0.01` (fw=8): ~9.04 bits/item measured at n=1e6 (slots/item 1.1305) --
  LEANER than XOR (~9.84) and much leaner than Cuckoo/Quotient, at a LOWER FPR than Bloom for
  the same budget. This is the member's reason to exist and the headline of the family.
- `restore()` closes the CHARTER-SIGNATURE fail-open: `sl` and `sc` are NOT trusted from the
  snapshot -- the whole geometry is RE-DERIVED from the count via `_bfDims(count)` and
  cross-checked, so an internally-inconsistent-but-individually-legal `sl`/`sc`/`fp.length`
  triple is REJECTED (not merely range-checked), then `chk` catches any provenance/store
  corruption a keys-mode/seed flip would otherwise reconstruct wrong.
- 0 false negatives is proven at scale (n=1e6) by the torture differential -- which can ONLY
  hold if the peel completed, so it doubles as the fail-open regression gate.
- v1.0.0: the family is complete (7 members) and the surface is API-frozen (status
  building -> stable).
