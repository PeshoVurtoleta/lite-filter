# 0018 -- XOR filter: the static build API, peeling, and the fail-closed reseed

Status: accepted (v0.6.0)

## Context

The XOR filter (Graf & Lemire, "Xor Filters: Faster and Smaller Than Bloom and Cuckoo
Filters", ACM JEA 2020) is the family's FIRST static member. It is built ONCE from a KNOWN
key set and supports no inserts afterward, approaching the ~1.23x information-theoretic
space lower bound by peeling a 3-uniform hypergraph. decisions/0006 deferred the static
build API to this, the first static member; the ruling is made here.

## Decision

### Build API -- static `XorFilter.from(iterable, options)` (option 2 of decisions/0006)

The static factory, NOT add-then-freeze. `add` on the instance throws `[lite-filter]` from
the start (decisions/0019). This is the more honest surface for a member whose construction
is fundamentally batch, and it keeps the mutable members' `add` un-gated. A `.build` alias
is provided (the family's static-build verb; same contract). The build MUST be uniform
across XOR and the future Binary Fuse, and it keeps the peel's RETRY count observable (the
bench reports the amortized build ns/key).

### Keys are a SET

`from()` DEDUPES its input to a `Set` before building (contrast Cuckoo / Quotient, which
store multiplicity). An XOR filter's identity IS its key set; a duplicate is not a second
element. `size` is the deduped key count, and `capacity === size` (it is built from exactly
its set).

### Geometry -- 3 segments, `bl = ceil(1.23 * n / 3) + 32`

Arity 3 is PINNED (the peeling threshold and the ~1.23x factor are both tied to it). Each
key touches exactly 3 fingerprint slots, one in each of 3 equal SEGMENTS of length `bl`;
the total array is `3*bl ~= 1.23*n + 96` slots. The 1.23 factor sits just above the
3-uniform peeling threshold (~1.222 slots/key); the +32 per segment gives small-n slack.
Both are PINNED. The three positions land in three DISTINCT segments (`h0 < bl <= h1 <
2*bl <= h2`), so an edge never touches the same vertex twice -- the XOR peeling trick is
never corrupted by a self-collision.

### Peeling and reverse assignment

Build the hypergraph (per-vertex edge COUNT and XOR-of-edge-indices), repeatedly peel a
degree-1 vertex onto a stack, and remove its edge from all three of its vertices. Then
assign the fingerprint array in REVERSE peel order: when an edge is assigned at its owning
slot, that slot is still 0 (each slot owned by exactly one edge) and the other two slots
are already final, so `fp[v] = fingerprint ^ fp[a] ^ fp[b] ^ fp[c]` makes a key's three
slots XOR to its fingerprint. The query is then `fingerprint(key) == fp[h0] ^ fp[h1] ^
fp[h2]` -- zero allocation, no branch on build state.

### The fail-closed reseed -- and the SIGNATURE fail-OPEN catch

A random key set peels on the first attempt with overwhelming probability. On a peel
FAILURE (a 2-core survives -> the stack is SHORT), the build RESEEDS deterministically
(`seed ^ (attempt * 0x9e3779b1)`) up to 100 times, then THROWS `[lite-filter]`
fail-closed. It NEVER ships a partial build.

The charter's flagged risk (the signature catch): a peeling loop that exits WITHOUT a full
peel and STILL assigns fingerprints ships a partial build that fails OPEN -- silent false
negatives on real keys. The guard `if (stack length !== n) return null` BEFORE assignment
is the only thing between a short stack and a fail-open filter. It treats a short stack as a
peel FAILURE (reseed, or throw on exhaustion) -- assignment runs ONLY on a complete peel.
Exhaustion is expected only for a DEGENERATE key set (e.g. many distinct keys that
`String()`-encode identically -> duplicate edges no reseed can separate), which is exactly
the case the exhaustion throw is for.

> **Amendment (1.1.0, decisions/0023).** Until 1.1.0 the STRING path derived the
> second edge hash as `g = fmix32(h ^ seed2)`, a pure function of `h`. That capped the pair
> `(h, g)` at ~32 bits of entropy, so a set of DISTINCT strings hit a single-hash birthday
> CEILING (~250k) past which a non-degenerate set was wrongly rejected as "degenerate".
> decisions/0023 replaces it with a second INDEPENDENT `g = hashStr(s, seed2)` (~64-bit edge
> entropy); distinct strings now peel at any size and exhaustion again means only a genuinely
> degenerate set. The `keys:'int'` path here is unchanged.

## Consequences

- Space at `fpp = 0.01` (fw=8): ~9.84 bits/item measured -- LEANER than Cuckoo (~21) and
  Quotient, competitive with Bloom (~9.6), while delivering a LOWER FPR (~2^-8 vs Bloom's
  ~0.01). This is the member's reason to exist.
- The snapshot (decisions/0005, format `litefilter/2`) gains `bl` + `fp` + the family-wide
  integrity checksum `chk` (decisions/0021) under the same `mem`-tagged, fail-closed envelope;
  `restore()` re-derives every consistency tie (fw from fpp, bl from count, length from bl,
  decisions/0020), then recomputes `chk` and rejects any provenance/store corruption -- so a
  flipped `keys`/`seed` (which cannot be re-derived from the fingerprint array) fails closed
  instead of reconstructing under the wrong hash path.
- 0 false negatives is proven at scale (n=1e6) by the torture differential -- which can ONLY
  hold if the peel was complete, so it doubles as the fail-open regression gate.
