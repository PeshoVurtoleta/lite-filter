# Changelog

All notable changes to `@zakkster/lite-filter` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `VERSION` constant, `package.json` `version`, and `llms.txt` are bumped
together (three-place version sync) at release.

## [0.5.0] - 2026-09-14

The 5th member -- `Quotient`, the mergeable + resizable one (deletable, fail-closed at the load ceiling).

### Added

- **`Quotient` -- the quotient-filter member** (Bender, Farach-Colton, Johnson, Kraner,
  Kuszmaul, Medjedovic, Montes, Shetty, Spillane & Zadok, VLDB 2012; decisions/0016, 0017).
  A new class IN `Filter.js` implementing the same uniform `LiteFilter<K>` surface as `Bloom`,
  so it is a one-line constructor swap. It DELETES via a real `remove(key) -> boolean`
  (returns false, mutates nothing, on a run-scan miss) and ADDS `merge()` + `resize()`.
  - ONE open-addressed LINEAR slot array. A key's 32-bit hash splits into a QUOTIENT (home
    slot index, high bits) and a REMAINDER (stored, low `r` bits); same-home keys form a RUN,
    adjacent runs a CLUSTER under linear probing. Three METADATA bits per slot -- `is_occupied`
    (bit0), `is_continuation` (bit1), `is_shifted` (bit2) -- packed in the low 3 bits of each
    byte-aligned word, remainder in the high bits (`word = (remainder << 3) | metadata`). A
    slot is EMPTY iff all three metadata bits are 0 (remainder 0 is a legal remainder).
  - **Remainder width `r = ceil(log2(1/fpp))`, byte-aligned slot word** (decisions/0016): the
    word is `r + 3` bits -> `Uint8Array` (r <= 5) or `Uint16Array` (r 6..13); `r + 3 > 16`
    (`fpp < 1/2^13 ~ 0.000122`) throws a `[lite-filter]` RangeError at construction. Slot
    count is a power of two `2^q >= ceil(capacity / 0.90)` (LOAD = 0.90); `q + r` must fit one
    32-bit hash or construction throws; a too-large door caps the count before the doubling
    loop. At `fpp = 0.01`: `r = 7`, delivered FPR `load * 2^-r` -- BELOW the configured target
    (measured ~0.0059 at ~0.55 load in the bench). `fpp()` reports that remainder-quantized
    rate once non-empty; bits/item ~23 at ~0.76 load (16-bit words + guard) vs Bloom's ~9.6.
  - **Fail-closed at the load ceiling** (decisions/0016): `add` THROWS a `[lite-filter]` Error
    when occupancy would exceed `floor(0.90 * nslots)` OR the linear cluster shift would run
    off the end of the physical array; both are checked BEFORE any write, so a thrown `add` is
    a BYTE-IDENTICAL no-op (no already-added key is dropped). A Quotient stores MULTIPLICITY
    (it does not dedup, like Cuckoo). The array carries GUARD spillover slots
    (`max(1024, nslots >> 3)`) so ordinary-load clusters near the top shift without throwing.
  - **`remove` repairs metadata by REBUILDING the affected cluster** through the verified
    insert path (identify the maximal non-empty run around the deleted slot, collect surviving
    `(home, remainder)` pairs, clear, re-insert) -- so the shift-back repair is correct by
    construction. The cluster scratch is preallocated, so `remove` is zero-allocation.
  - **`merge()` + `resize()` -- cold paths that preserve membership without the original
    keys** (decisions/0016). Each element's identity is reconstructed as
    `(quotient << r) | remainder` and re-split under the new slot count; the fingerprint bit
    budget `p = q0 + r` is FIXED for the filter's lifetime so both grow and shrink preserve
    membership (0 false negatives) and exact size. `resize(newCapacity)` sizes for
    `max(newCapacity, count)` (never loses data). `merge(other)` REJECTS fail-closed unless
    `other` is an identically-configured `Quotient` (same `seed`, `r`, `p`, keys mode), then
    grows to hold both and re-inserts every pair (exact additive size on disjoint inputs).
  - **Delete caveat** (decisions/0017): removing a NEVER-INSERTED key whose `(quotient,
    remainder)` collides with a real key clears that other key's slot -> a later false negative
    for it (a constructed non-vacuous example is recorded in decisions/0017). Only remove keys
    you inserted (documented in the docstring, `Filter.d.ts`, README, llms.txt).
  - Hot path `add` / `mightContain` / `has` / `remove` are strictly zero-alloc on `keys:'int'`
    (linear-probe split + shift, preallocated cluster scratch on remove): 0 scavenges at
    N=200000 and 8N on add-churn / query-hit / remove-churn under the pinned 4MB semi-space
    (perf-gate). `clear()` zeroes the store in place (same ArrayBuffer identity).
  - `dump()` / static `Quotient.restore(snap, opts?)` with a `{ f, mem:"Quotient", r, q, p,
    nslots, load, cap, fpp, seed, keys, count, store }` tag (`q`/`nslots` track a resize, `p`
    is the fixed budget) that revalidates every field and every slot word BEFORE building any
    instance (store length `nslots + guard`, each word fits `r + 3` bits, an empty slot carries
    a 0 remainder, metadata-set-slot count == size), and REJECTS any corruption -- never truncates.
- **`Filter.d.ts`** -- `Quotient<K> implements LiteFilter<K>` with a real `remove(key): boolean`,
  `resize(n): Quotient<K>`, and `merge(other): Quotient<K>`; `FilterSnapshot` extended with
  optional `r` / `q` / `p` / `nslots` / `load` / `store` fields.
- **Gates extended** -- the conservation + structure invariant `validateQuotient` (store length
  `nslots + guard`; every remainder in range; empty slot == 0; metadata-set-slot count == size;
  slot 0 never shifted; per-cluster #occupied-homes == #runs; sorted runs); `differentialResizeInt`
  and `differentialMergeInt` Set-oracle differentials; a `test/Quotient.test.js` boundary suite;
  `qfAdd` / `qfQueryHit` / `qfRemoveChurn` perf-gate scenarios; a `measureQuotient` bench column
  (Bloom vs Quotient, measured-vs-theory FPR, add ns rising toward the ceiling); the torture GATE
  line grows `qf` terms (`fn=0`, `fpr`, `churnFn`/`present`/`size`, `resizeFn=0`, `mergeFn=0`,
  `mergeSize`, `ceilingThrew=true`, `ceilingNoop=true`).

## [0.4.0] - 2026-09-14

The 4th member -- `Cuckoo`, the fingerprint one (deletable, fail-closed at capacity).

### Added

- **`Cuckoo` -- the fingerprint member** (Fan, Andersen, Kaminsky & Mitzenmacher, CoNEXT
  2014; decisions/0014, 0015). A new class IN `Filter.js` implementing the same uniform
  `LiteFilter<K>` surface as `Bloom`, so it is a one-line constructor swap. It DELETES via
  a real `remove(key) -> boolean` (returns false, mutates nothing, when the key is absent).
  - Stores a small NONZERO fingerprint per key in one of TWO candidate buckets of `b = 4`
    slots (partial-key cuckoo hashing): `i1 = hash(key) & (nb-1)`,
    `i2 = (i1 XOR hash(fp)) & (nb-1)` -- an INVOLUTION, so an evicted fingerprint recovers
    its alternate bucket from the fingerprint alone. `add` scans both buckets and, on a
    full pair, KICKS a random victim to its alternate bucket up to 500 times using a SINGLE
    scalar victim register (no scratch array). Fingerprint 0 is the empty-slot sentinel;
    the fingerprint hash never emits 0 (0 -> 1). `b = 4` and 500 kicks are PINNED.
  - **Fingerprint width `f = ceil(log2(8/fpp))` byte-aligned UP** (decisions/0014):
    `f <= 8` -> a `Uint8Array` store, `9..16` -> a `Uint16Array`; `f > 16`
    (`fpp < 8/65536 ~ 0.000122`) throws a `[lite-filter]` RangeError at construction. Bucket
    count is a power of two `>= ceil(capacity/(4*0.95))`; store is `nb*4` slots, sized once.
    `fpp()` reports the width-quantized `2b/2^f` once non-empty (independent of fill) --
    at `fpp = 0.01`, `f = 10 -> 16-bit`, delivered FPR `8/1024 ~ 0.0078`, BELOW the
    configured target and at ~2x a plain Bloom's bytes/item (~21 vs ~9.6 at ~76% load).
    This measure-vs-configured quantization is surfaced by `fpp()` and the bench, not hidden.
  - **Fail-closed at capacity** (decisions/0014): `add` on a table where 500 kicks are
    exhausted THROWS a `[lite-filter]` Error -- it does NOT return a boolean and does NOT
    silently drop the fingerprint (which would be a false negative). The uniform
    `add(key) -> void` surface is preserved; headroom is observable via `size` vs `capacity`.
  - **Delete caveat** (decisions/0015): removing a NEVER-INSERTED key whose fingerprint
    collides with a real key clears that other key's slot -> a later false negative for it.
    Only remove keys you inserted (documented in the docstring, `Filter.d.ts`, README, llms.txt).
  - Hot path `add` / `mightContain` / `has` / `remove` are strictly zero-alloc on
    `keys:'int'` (two-bucket b=4 scan, a single scalar victim register on kicks, no scratch):
    0 scavenges at N=200000 and 8N on add-churn / query-hit / remove-churn under the pinned
    4MB semi-space (perf-gate). `clear()` zeroes the store in place (same ArrayBuffer identity).
  - `dump()` / static `Cuckoo.restore(snap, opts?)` with a
    `{ f, mem:"Cuckoo", fw, b:4, nb, cap, fpp, seed, keys, count, fp }` tag (`fw` = the
    fingerprint width; `f` remains the shared format tag) that validates the store length
    (`nb*4`) and every slot (`0..fpMask`) BEFORE building any instance, and REJECTS any tag /
    member / width / bucket-size / bucket-count / length / range corruption -- never truncates.
- **`Filter.d.ts`** -- `Cuckoo<K> implements LiteFilter<K>` with a real `remove(key): boolean`;
  `FilterSnapshot` extended with optional `fw` / `b` / `fp` fields (`nb` already present).
- **Gates extended** -- the conservation invariant `validateCuckoo` (every slot `0..fpMask`,
  nonzero-slot count == size, power-of-two `nb`, store length `nb*4`); a bounded-keyspace
  extension to the `differentialChurnInt` Set oracle (so a capacity-bounded member churns
  under its load target); torture Cuckoo leak/GC + differential (0 false negatives) +
  delete-churn + a PROVEN fail-closed overload-throw phase; three new perf-gate scenarios
  (add-churn / query-hit / remove-churn on `keys:'int'`) at 0 scavenges N and 8N.
- **The bench** (`benchmark/Bench.mjs`) -- `measureCuckoo` / `runBenchCuckoo` and a
  `printCuckooTable` that prints Bloom vs Cuckoo SIDE BY SIDE across the four workloads:
  bits/item (Cuckoo ~2x, byte-aligned), measured FPR vs the width-quantized theoretical
  `2b/2^f`, and the fail-closed capacity overflow (marked `*`) on oversized / duplicate-heavy
  workloads.

[0.4.0]: https://github.com/PeshoVurtoleta/lite-filter/releases/tag/v0.4.0

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
