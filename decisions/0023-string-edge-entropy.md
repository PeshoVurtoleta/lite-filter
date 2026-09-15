# 0023 -- XOR / Binary Fuse string keys: a second INDEPENDENT edge hash

Status: accepted (1.1.0)

## Context

The static members `XorFilter` and `BinaryFuse` build a 3-uniform hypergraph: every key
contributes ONE edge whose three vertices (slot positions) come from two 32-bit hashes
`(h, g)` plus their mix `t = fmix32(h ^ g)`. Peeling succeeds only when the edge set has no
2-core; two DISTINCT keys that collapse to the SAME `(h, g)` pair produce a PARALLEL (duplicate)
edge that no reseed can separate, so peeling exhausts all 100 attempts and the build throws
fail-closed (decisions/0018, 0022).

For the `keys:'int'` path the two hashes were already independent:

```
h = fmix32(key ^ seed)
g = fmix32(imul(key, 0x9e3779b1) ^ seed2)
```

For the STRING (arbitrary-key) path, however, `g` was DERIVED from `h`:

```
h = hashStr(s, seed)
g = fmix32(h ^ seed2)          // <-- g is a pure function of h
```

Because `g` was a deterministic function of `h`, the pair `(h, g)` carried only the ~32 bits
of entropy in `h`. Two distinct strings that happened to collide in `h` (a single 32-bit
hash) ALSO collided in `g` and `t` -- a full parallel edge. This is a birthday problem in a
32-bit space: the probability of at least one `h`-collision in a set of `N` distinct strings
crosses ~50% near `N ~ 2^16 * sqrt(pi/2) ~ 77000`, and becomes overwhelming well before
`2^18`. Empirically the single-hash string build hit a CEILING around ~250k distinct strings
-- past that a random distinct-string set almost always contained an `h`-collision and the
build threw, MISreported (decisions/0018/0020/0022 message text) as a "degenerate set".

### The H4 reproduction

`XorFilter.from(300000 distinct strings)` (and the Binary Fuse equivalent) THREW under the
single-hash derivation -- not because the set was degenerate (every `String()` encoding was
distinct) but because two of the 300k strings shared a 32-bit `h`, collapsing to one edge.
The one-sided guarantee was never violated (a thrown build ships nothing), but a legitimate,
non-degenerate key set was rejected: a fail-CLOSED-but-WRONG outcome.

## Decision

### A second INDEPENDENT string hash

The string path now draws `g` from a SECOND independent `hashStr` over the same encoded
string, seeded by `seed2`, exactly mirroring the int path's two-independent-hash structure:

```
s = (typeof key === "string") ? key : String(key)   // encode ONCE per call, into a local
h = hashStr(s, seed)
g = hashStr(s, seed2)
```

`t`, the fingerprint, and the three slot positions are derived from `(h, g)` EXACTLY as
before. Now the pair `(h, g)` carries ~64 bits of entropy: two distinct strings collide as
an edge only if they collide in BOTH `h` and `g`, a ~2^-64 event. A set of distinct strings
peels regardless of size -- there is no single-hash birthday ceiling. Exhaustion again means
ONLY a genuinely degenerate set: keys with identical `String()` encodings (e.g. three
distinct plain objects, all `"[object Object]"`), which collapse to the same `(h, g)` by
construction. The `XOR_CONSTRUCT_MSG` / `BF_CONSTRUCT_MSG` text was reworded to this truthful
diagnosis.

Build and query stay BYTE-IDENTICALLY symmetric (the correctness invariant): the build helper
`_xorTryBuild` / `_bfTryBuild` and `mightContain` compute `(h, g)` the same way, so a filter
built from 300k distinct strings reads back 0 false negatives. The `keys:'int'` path is
UNCHANGED (byte-identical). `seed2` is still the derived word `fmix32(seed ^ 0x9e3779b9)`, so
one `{ seed }` still fully determines behavior and `restore()` re-derives `seed2` from `seed`.

### Cost

The string build and the string query now compute TWO `hashStr` passes instead of one hash +
one `fmix32`. `hashStr` is O(length); the second pass roughly doubles the per-key string
hashing cost on the build (a COLD path -- allocation and time there are already amortized,
decisions/0018) and on the string query hot path. Both remain zero-ALLOCATION: `hashStr`
loops over `charCodeAt` (a number, no scratch), and the key is `String()`-encoded ONCE per
call into a local, never twice. The int path -- the strict zero-alloc mode -- pays nothing.

### The snapshot tag: `litefilter/2` -> `litefilter/3`

The string derivation is part of a filter's identity: a `litefilter/2` XOR/BF snapshot was
built with `g = fmix32(h ^ seed2)`; restoring it under the new query (`g = hashStr(s, seed2)`)
would read FALSE for every string key -- a total false-negative corruption with no thrown
error. So `SNAP_TAG` is bumped to `litefilter/3` and `restore()` REJECTS `litefilter/2` (and
earlier) fail-closed with a migration message: re-`dump()` the source filter under 1.1.0.

Crucially, the bump applies to the WHOLE family, INCLUDING members whose bytes did not change
(Bloom, and every `keys:'int'` filter, whose hashing is untouched). One tag is ONE algorithm
for the entire format: a reader must not have to guess which member's snapshot is still valid.
Invalidating the "immune" int snapshots is the price of that single-tag guarantee -- and the
honest one: a stale snapshot is a clean, detectable break, never a silent per-member misread.

## Consequences

- `XorFilter.from` / `BinaryFuse.from` build any set of DISTINCT keys (int or string) at any
  size; the ~250k single-hash string ceiling is GONE. A genuinely degenerate set (duplicate
  `String()` encodings) still throws after 100 reseeds -- now truthfully diagnosed.
- 0 false negatives on a 300k distinct-string readback for both members (proven in the torture
  and boundary suites; the string hot lane runs under the zero-major-GC gate).
- `litefilter/2` and earlier snapshots no longer restore for ANY member (re-`dump()` to migrate).
  The `chk` integrity door (decisions/0021) is unchanged and still runs after the tag check.
- The string query hot path costs a second `hashStr`; the `keys:'int'` path is byte-identical.
- decisions/0018, 0020, 0022 carried a "single-hash string ceiling" caveat; it is RESOLVED here.
- decisions/0021 documented the tag at `litefilter/2`; it is now `litefilter/3` (this decision).
