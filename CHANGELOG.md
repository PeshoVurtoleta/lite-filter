# Changelog

All notable changes to `@zakkster/lite-filter` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `VERSION` constant, `package.json` `version`, and `llms.txt` are bumped
together (three-place version sync) at release.

## [0.3.0] - 2026-09-14

The 3rd member -- `BlockedBloom`, the cache-local one.

### Added

- **`BlockedBloom` -- the cache-local member** (decisions/0012, 0013). A new class IN
  `Filter.js` implementing the same uniform `LiteFilter<K>` surface as `Bloom`, so it is
  a one-line constructor swap. Add-only like `Bloom`: `remove()` throws `[lite-filter]`.
  - The bit array is partitioned into fixed 512-bit BLOCKS (16 x 32-bit words = 64
    bytes, one cache line on x86-64 and Apple Silicon; decisions/0012). Every key is
    routed to ONE block from its first base hash (`base = (a % nb) << 4`), and all `k`
    bits live inside that block via an odd-stride within-block walk
    (`p0 = b & 511; st = ((b >>> 9) | 1) & 511; pos = (p0 + i*st) & 511`). A query
    therefore touches ONE cache line regardless of `k`. Store is `ceil(m/512)*16` words
    (same 1x size as Bloom); `k` is clamped to <= 512. Same `(n, fpp)` sizing as Bloom.
  - Hot path `add` / `mightContain` / `has` are strictly zero-alloc on `keys:'int'`
    (block-index + within-block position math is pure int ops, no scratch): 0 scavenges
    at N=200000 and 8N on add-churn / query-hit under the pinned 4MB semi-space
    (perf-gate). `clear()` zeroes the store in place (same ArrayBuffer identity).
  - **The FPR penalty is EXPOSED and MEASURED, not compensated** (decisions/0013).
    Blocking loses cross-block independence, so the MEASURED false-positive rate runs
    OVER the plain-Bloom form for the same bits/item. `m` is NOT upsized to hide it;
    `fpp()` returns the plain closed-form LABELED as a FLOOR (not a prediction). Torture
    pins an honest looser ceiling (n=1e5, fpp=0.01, 1e6 probes -> measured FPR <= 0.0175,
    measured 0.01378) AND asserts the measured FPR runs OVER the plain-Bloom theory
    (> 0.00949) so the penalty is proven present. No "same fpp for free" claim anywhere.
  - `dump()` / static `BlockedBloom.restore(snap, opts?)` with a
    `{ f, mem:"BlockedBloom", bb:512, nb, m, k, cap, fpp, seed, keys, count, bits }` tag
    that validates the store length (`nb*16`) and every word (`0..0xffffffff`) BEFORE
    building any instance, and REJECTS any tag / member / block-size / block-count /
    length / word corruption -- never truncates (decisions/0005, 0012).
- **`Filter.d.ts`** -- `BlockedBloom<K> implements LiteFilter<K>` with `remove(key): never`
  (add-only); `FilterSnapshot` extended with optional `bb` / `nb` fields.
- **Gates extended** -- boundary suite (`test/BlockedBloom.test.js`, incl. the `_nb >= 1`
  door and the single-key locality property) + BlockedBloom round-trip / corruption cases
  in `test/Snapshot.test.js`; the conservation invariant `validateBlocked` (every set bit
  in `[blk<<4, blk<<4+16)`, popcount <= `k*count`, `words.length === nb*16`) plus
  `validateBlockedLocality`; torture BlockedBloom leak/GC + differential phases; two new
  perf-gate scenarios (add-churn / query-hit on `keys:'int'`).
- **The bench** (`benchmark/Bench.mjs`) -- `measureBlocked` / `runBenchBlocked` and a
  `printBlockedTable` that prints Bloom vs BlockedBloom SIDE BY SIDE across the four
  workloads: measured FPR (BlockedBloom higher) and query ns (BlockedBloom lower on the
  uniform int workload) at the same bits/item -- the mandatory honesty output.

[0.3.0]: https://github.com/PeshoVurtoleta/lite-filter/releases/tag/v0.3.0

## [0.2.0] - 2026-09-14

The 2nd member -- `CountingBloom`, the deletable one.

### Added

- **`CountingBloom` -- the deletable member** (Fan, Cao, Almeida & Broder, 2000;
  decisions/0007..0011). A new class IN `Filter.js` implementing the same uniform
  `LiteFilter<K>` surface as `Bloom`, so it is a one-line constructor swap.
  - Each Bloom bit becomes a 4-bit SATURATING counter, two packed per byte, in ONE
    preallocated `Uint8Array` of `ceil(m/2)` bytes -- ~4x a plain Bloom's space
    (decisions/0007). Same `(n, fpp)` sizing as Bloom (m, k shared).
  - Hot path `add` (saturating increment; a counter at 15 stays 15, never wraps),
    `mightContain` / `has` (true iff every probed counter is nonzero), and a REAL
    `remove(key) -> boolean`. All strictly zero-alloc on `keys:'int'` (nibble
    read/modify/write, no scratch array): 0 scavenges at N=200000 and 8N on
    add-churn / query-hit / remove-churn under the pinned 4MB semi-space (perf-gate).
  - `remove` is two-pass and fail-closed (decisions/0009): pass 1 verifies every
    probed counter is nonzero (else returns `false`, mutates nothing); pass 2
    decrements each counter in 1..14 (a saturated 15 is never decremented,
    decisions/0008). Two honest caveats: removing a never-added key can corrupt other
    keys (a later false negative), and a saturated counter sticks its keys present.
  - `clear()` zeroes the counter store in place (same ArrayBuffer identity);
    opt-in zero-GC stats; `dump()` / static `CountingBloom.restore(snap, opts?)` with a
    `{ f, mem:"CountingBloom", w:4, m, k, cap, fpp, seed, keys, count, cnts }` tag that
    validates every byte 0..255 (so every nibble 0..15) BEFORE building any instance,
    and REJECTS any mismatch or corruption -- never truncates (decisions/0011).
  - Approximate-multiplicity readout DEFERRED (decisions/0010): saturation + collisions
    make it an over-estimate, so it does not ship un-characterized.
- **`Filter.d.ts`** -- `CountingBloom<K> implements LiteFilter<K>` with a real
  `remove(key): boolean`; `FilterSnapshot` extended with optional `w` / `cnts` fields.
- **Gates extended** -- boundary suite (`test/CountingBloom.test.js` + CountingBloom
  round-trip / corruption cases in `test/Snapshot.test.js`); the conservation invariant
  `validateCounting` (every nibble 0..15, `sum(nibbles) <= k*size`); a
  `differentialChurnInt` Set-oracle mirroring add AND remove (0 false negatives for
  present keys); torture CountingBloom leak/GC + churn phases; three new perf-gate
  scenarios (add-churn / query-hit / remove-churn on `keys:'int'`).
- **The bench** (`benchmark/Bench.mjs`) -- a `CountingBloom` FPR-vs-theory table across
  the four workloads (bits/item is 4x Bloom's), plus a `remove-churn` workload (add N,
  remove half, requery): measured 0 false negatives for still-present keys.

[0.2.0]: https://github.com/PeshoVurtoleta/lite-filter/releases/tag/v0.2.0

## [0.1.0] - 2026-09-14

The SUBSTRATE + the reference member -- everything the family stands on.

### Added

- **The uniform `LiteFilter<K>` surface + `Bloom` reference member** (Bloom, CACM
  1970; decisions/0001..0005): a zero-GC, single-file ESM approximate-membership
  filter under one surface, so a future member is a one-line constructor swap.
  - Hot path `add` / `mightContain` (alias `has`): zero allocation on the
    `keys:'int'` and string paths. `k` probe positions from two base hashes via
    Kirsch-Mitzenmacher enhanced double hashing over ONE preallocated `Uint32Array`.
  - murmur3 `fmix32` mixer; a direct integer mix for `keys:'int'` (strict zero-alloc,
    32-bit-signed door) and an alloc-free code-unit hash for strings; arbitrary keys
    are honestly amortized where they `String()`-encode (decisions/0001).
  - `(n, fpp)` sizing (`m = ceil(-n ln(fpp)/ln2^2)`, `k = round(m/n ln2)`, clamp
    `k >= 1`) with fail-closed `[lite-filter]` doors on `fpp <= 0`, `fpp >= 1`,
    `capacity < 1`, and an overflowing bit count (decisions/0002).
  - `remove()` throws (Bloom is add-only -- fail closed, decisions/0003); `size` /
    `count` are a plain add-call counter; `fpp()` reports the configured target when
    empty, else the fill-derived closed-form ESTIMATE (decisions/0004).
  - `clear()` zeroes the store in place (same ArrayBuffer identity, no realloc).
  - Opt-in zero-GC stats (`{ stats: true }`, `_stats === null` when off,
    decisions/0004); `dump()` / static `restore(snap, opts?)` with a fail-closed
    `{ f, mem, m, k, cap, fpp, seed, keys, count, bits }` tag that REJECTS any
    mismatch or corruption, never truncates (decisions/0005).
- **`Filter.d.ts`** -- the `LiteFilter<K>` interface + `Bloom<K> implements LiteFilter<K>`.
- **The bench** (`benchmark/Bench.mjs`) -- runnable + importable, imports only
  `./Filter.js`. Reports measured vs theoretical FPR as `% over theoretical`,
  bits/item, add/query ns, checked against a real `Set` oracle, over four seeded
  workloads (uniform / zipfian / sequential / adversarial near-full).
- **The gates** -- `node:test` boundary suite; the torture gate
  (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`) with a Set-differential
  oracle (no false negatives + bounded FPR); the `@zakkster/lite-perf-gate`
  zero-alloc scenarios (add-churn + query-hit on `keys:'int'`); the out-of-process
  controls driver.
- **A `GUIDE.md` skeleton** -- the decision table + flowchart scaffold + the honesty
  golden rule ("measure your own keys").
- Deferred: the static-member build API (add-then-freeze vs `Member.from`,
  decisions/0006), resolved with the first static member.

[0.1.0]: https://github.com/PeshoVurtoleta/lite-filter/releases/tag/v0.1.0
