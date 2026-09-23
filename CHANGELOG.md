# Changelog

All notable changes to `@zakkster/lite-filter` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `VERSION` constant, `package.json` `version`, and `llms.txt` are bumped
together (three-place version sync) at release.

## [1.2.0] - 2026-09-23

H1 hardening -- the close-out of the 2026-09-23 zero-GC audit (RESEARCH.md, ROADMAP section 12).
The audit found NO defects; these are additive introspection getters, louder fail-closed text, and
gated proofs for the lite-hud M5 integration constraints. No wire or snapshot change (stays
`litefilter/3`); no hot-body byte change beyond the error-text constants.

### Added

- **`keysMode` and `seed` read-only getters on every member** (decisions/0025). `keysMode` returns
  the module string constant `'int' | 'arbitrary'` (never built per call); `seed` returns the 32-bit
  unsigned hash seed -- the validated constructor seed on the five dynamic members, the WINNING build
  seed on `XorFilter` / `BinaryFuse` (a static instance is only reachable built). O(1), 0-alloc, off the hot path.
  A consumer can now detect a `keys:'int'` filter without catching a `TypeError` or a full `dump()`.
- **`maxLoad` and `saturation` read-only getters on every member** (decisions/0026). `maxLoad` is the
  hard item ceiling documented as an UPPER BOUND: `Infinity` on Bloom / CountingBloom / BlockedBloom
  (adds never fail; the FPR degrades), `nb*b` on Cuckoo, `floor(0.90*nslots)` on Quotient (tracks
  `resize()`), `size` on a built static member (always built). `saturation = size / maxLoad` in
  `[0, 1]`, 0 when `maxLoad` is `Infinity` or 0, never NaN. `capacity` keeps its meaning (the SIZING
  input, not a cap): Cuckoo(64) takes 127 adds and Quotient(64) 115 before the fail-closed door.
- **`test/Introspection.test.js`**: 7 members x 2 key modes x the 4 getters, pinned against MEASURED
  ceilings (Cuckoo(64).maxLoad === 128 with exactly 127 adds before the 128th throws; Quotient(64) ===
  115 and its post-`resize()` value measured, not assumed), the default seed read from the live code
  path, an explicit-seed round-trip, the static build seed matching `dump().seed`, `restore()`
  preserving all four getters, and the signed-fold door both ways. Test count 497 -> 516 (the
  boundary matrix widened after QA: overload-message text asserts on both members, saturation
  is swept in [0, 1] at every add to the throw point on Cuckoo and Quotient, and Quotient's
  `maxLoad`/`saturation` are pinned live through `merge()`, not just `resize()`).
- **A NEGATIVE int32 torture oracle lane** (audit N4): INT_MIN..-1 plus the INT_MIN / INT_MAX edges
  on every int-capable member, 0 false negatives (`negFn=` on the GATE line). The steady-state hot
  loop is unchanged and stays 0-alloc.
- **PerfGate negative-int32 lanes** (audit N4): one `maxScavenges 0` lane per int-capable member on
  the negative half of the `keys:'int'` domain, plus ONE amortized default-backing lane (fractional /
  large numbers that `String()`-encode) under an explicit MEASURED byte budget of 104 B/op (measured
  p95 ~51.6 B/op on `node --max-semi-space-size=4`, budget = p95 x2) and a floor of 8 B/op, so a
  collapse to 0 fails the lane instead of passing it vacuously (median ~41 B/op at release).
- **`test:demo` npm script** (audit N6): `demo/Demo.test.mjs` (previously not run by `npm test`).

### Changed

- **The `keys:'int'` fail-closed text names the fix** (decisions/0024): fold a composite signature
  with `| 0`, never `>>> 0` (which yields `[2^31, 2^32)` and throws for half its domain). The domain
  stays a SIGNED int32 `[-2^31, 2^31-1]`; a `>>> 0` fold still fails closed, but the message now says
  how to fix it. README, `llms.txt`, and the `keys` option doc in `Filter.d.ts` carry the signed-fold
  example `((a << 20) | (b << 12) | c) | 0`.
- **The Cuckoo / Quotient overload messages** advise `saturation (size / maxLoad)` instead of the
  wrong "size vs capacity" headroom check, and note that `maxLoad` is an upper bound (decisions/0026).
- `Filter.d.ts`, `README.md`, `llms.txt`: the four getters documented (`maxLoad` as an UPPER BOUND,
  the static `seed` semantics); the surface table and the API reference gain the getter entries.

### Removed

- **The dead `XorFilter._hashKey` / `BinaryFuse._hashKey`** (audit N6): the static members
  never call an arbitrary-key hash helper (their build/query hash inline), so the two methods were
  unreachable code. No behavior change.

## [1.1.0] - 2026-09-15

### Added

- **A second INDEPENDENT string-key hash for `XorFilter` / `BinaryFuse`** (decisions/0023).
  The string edge hash `g` moves from `fmix32(h ^ seed2)` (a pure function of `h`, ~32-bit edge
  entropy) to an independent `hashStr(s, seed2)` (~64-bit edge entropy). A set of DISTINCT
  strings now peels at ANY size: `XorFilter.from` / `BinaryFuse.from` build 300k distinct
  strings with 0 false negatives on full readback in well under 5s. The single-hash birthday
  CEILING (~250k, past which a non-degenerate set was wrongly rejected) is gone; exhaustion
  again means only a genuinely degenerate set (identical `String()` encodings). The key is
  `String()`-encoded ONCE per call into a local; the `keys:'int'` path is byte-identical.
- **Fail-closed option doors on every constructor, static factory, and `restore()`** (ported
  from `@zakkster/lite-lru`): `validateOptions` rejects a non-object bag and any unknown key
  with a did-you-mean hint (`KNOWN_OPTS = fpp/seed/keys/stats`; `KNOWN_RESTORE_OPTS = stats`).
- **Torture hardening**: a phase-1 liveness count (`tracked` asserted against the exact loop
  total), a string-key hot lane under the same zero-major-GC window (proving string keys are
  zero-alloc), a CBF churn law (`removes > 20000`, `validateCounting` on the churned instance),
  and `cbf removes=` on the GATE line. `main()` now `.catch`es and fails closed.
- **Controls hardening**: a `LEAK` (retained-tracked-object) arm and a `SABOTAGE` (wiped-store
  false-negative) arm, each matched on its SPECIFIC stderr violation text; the `BREAK` arm now
  also requires the `violation gc.major` text, not merely a nonzero exit.
- **Bench**: `falseNeg` is enforced everywhere (importable fns THROW, the CLI exits 1);
  `distinct`/`added` and `fn` columns on all 7 tables; a seed + one-process/JIT-order honesty
  header; zipfian honesty (Bloom-family filters sized to the DISTINCT count; the Quotient zipf
  theoretical derived from distinct fingerprints, not `size` multiplicity; the Cuckoo zipf row
  annotated as a duplicate-saturation demonstration).
- **`Cuckoo.restore` structural cross-check**: the nonzero-slot count MUST equal `count`
  (parity with `Quotient.restore`), rejected BEFORE the `chk` gate.
- **`test/Doors.test.js`**: a family-wide option-door matrix (every constructor, static
  `from`/`build` factory, and `restore()` swept against the same unknown-key/non-object/
  did-you-mean matrix), a `litefilter/2` rejection proof for `Bloom`, `XorFilter`, and
  `BinaryFuse`, and a 300k-distinct-string scale proof (`XorFilter.from`/`BinaryFuse.from`,
  0 false negatives, well under 5s) confirming the decisions/0023 birthday ceiling is gone.
  Test count 479 -> 497.

### Changed

- **Snapshot format tag `litefilter/2` -> `litefilter/3`** (decisions/0023). One tag is ONE
  algorithm for the whole family, so EVERY member is re-tagged -- including members whose bytes
  did not change (Bloom, int-mode filters). `restore()` REJECTS a `litefilter/2` (or earlier)
  snapshot fail-closed with a migration message: re-`dump()` under 1.1.0. The `chk` integrity
  door (decisions/0021) is unchanged and still runs after the tag check.
- The `XOR_CONSTRUCT_MSG` / `BF_CONSTRUCT_MSG` exhaustion messages now truthfully diagnose a
  degenerate set for the new two-independent-hash behavior.
- `Filter.d.ts`: `BinaryFuse` is branded the family's SMALLEST member (~1.13x); `XorFilter`
  keeps the "space-optimal" (~1.23x reference) branding.

### Fixed

- Unsigned right shift in every xorshift step: the Cuckoo kick RNG (`r ^= r >>> 17`) and the
  `_qfGuard` slot-shift (`nslots >>> 3`) in `Filter.js`, plus the PRNGs in `benchmark/Bench.mjs`
  and the torture / oracle / Quotient test files. A signed `>>` on a high-bit-set word skewed
  the stream; the gates re-verified clean under the corrected streams.
- The `Filter.js` Binary Fuse geometry comment no longer claims a divergence from the FastFilter
  reference -- the code MATCHES it (slot 0 is the raw multiply-shift base in the reference too).

[1.1.0]: https://github.com/PeshoVurtoleta/lite-filter/releases/tag/v1.1.0

## [1.0.0] - 2026-09-15

The 7th and FINAL member -- `BinaryFuse`, the SMALLEST filter (static, ~9.0 bits/item). The
family is COMPLETE (7 members under one `LiteFilter<K>` surface) and the API is FROZEN: this
release moves the package from status building -> **stable**.

### Added

- **`BinaryFuse` -- the space-optimal static member** (Graf & Lemire, "Binary Fuse Filters:
  Fast and Smaller Than Xor Filters", ACM JEA 2022; decisions/0022). A construction-algorithm
  SWAP over `XorFilter`, NOT a new surface: a new class ALONGSIDE `XorFilter` in `Filter.js`
  that REUSES the immutable surface, the static `from()`/`build()`, the 3-uniform peel +
  reverse-assign, the deterministic reseed (`seed ^ (attempt * 0x9e3779b1)`, x100 then throw),
  the `sp !== n` peel-completeness fail-OPEN guard, the byte-aligned width door
  (decisions/0020), and the snapshot v2 + `chk` integrity checksum (decisions/0021).
  - **Overlapping fuse geometry** (decisions/0022): XOR's 3 equal DISJOINT segments become 3
    OVERLAPPING segments selected by a multiply-shift. A key's first slot is
    `mulhiU32(h, scl)` in `[0, scl)` (`scl = segCount * segLen`); the next two are one and two
    segments further, each perturbed within-segment by `^ (g & segMask)` / `^ (t & segMask)`.
    Since `segLen` is a power of two, the three slots always land in three DISTINCT consecutive
    segments -- the peeling XOR trick is never self-corrupted.
  - **Sizing, cited to the reference** (decisions/0022; Graf & Lemire 2022 / FastFilter
    `binaryfusefilter.h`, arity 3): `segLen = clamp(2^floor(log(n)/log(3.33) + 2.25), 4,
    262144)`; `segCount = max(1, ceil(round(n * sizeFactor) / segLen) - 2)` with `sizeFactor =
    max(1.125, 0.875 + 0.25*log(1e6)/log(n))`; array length `(segCount + 2) * segLen`. `n = 1`
    and `n = 2` land on the small-n clamp (segLen 4, segCount 1, 12 slots); an empty key set
    throws `[lite-filter]` (null is not zero).
  - **Smaller than XOR**: measured slots/item **1.1305** (vs XOR's ~1.23) and **9.04
    bits/item** at n=1e6 (vs XOR's ~9.85) -- the family's space headline -- while building
    FASTER. Width-quantized `2^-fw` FPR (MEASURED ~0.0038 at fw=8, UNDER the configured 0.01).
  - **0 false negatives, proven at scale**: a filter built from 1e6 distinct ints reads back
    with EXACTLY 0 false negatives (which can hold ONLY if the peel was complete -- the
    fail-OPEN regression gate), asserted in the torture GATE.
  - **`restore()` re-derives the geometry** (decisions/0022, the CHARTER-SIGNATURE fail-open
    hunt): `sl`/`sc` are NOT trusted from the snapshot -- the whole geometry is RE-DERIVED from
    the count via `_bfDims(count)` and cross-checked, so an internally-inconsistent-but-legal
    `sl`/`sc`/`fp.length` triple is REJECTED (not merely range-checked); the `chk` integrity
    checksum then catches a keys-mode/seed flip.
  - **Snapshot**: `dump()` emits `{ mem: "BinaryFuse", fw, sl, sc, fp, chk }` under the shared
    `litefilter/2` envelope; `FilterSnapshot` gains optional `sl`/`sc`.
  - **Immutable + strict**: `add`/`remove`/`clear` and `new BinaryFuse()` all throw
    `[lite-filter]`; `keys: 'int'` validates on build and query; a degenerate set exhausts 100
    reseeds and throws.

### Changed

- **Status: building -> stable.** The 7-member family is complete and the `LiteFilter<K>`
  surface is API-frozen. Version bumped to `1.0.0` across `package.json`, the `VERSION`
  constant, and `llms.txt` (three-place sync).
- **Bench + GUIDE**: `benchmark/Bench.mjs` adds `measureBinaryFuse` / `runBenchBinaryFuse` and
  an XOR-vs-BinaryFuse side-by-side table; `GUIDE.md` is rewritten with all 7 members as rows
  and BOTH decision axes (mutable-vs-static AND, within static, XOR-vs-Binary-Fuse on
  space/simplicity).

[1.0.0]: https://github.com/PeshoVurtoleta/lite-filter/releases/tag/v1.0.0

## [0.6.0] - 2026-09-15

The 6th member -- `XorFilter`, the space-optimal STATIC one (built once, immutable, ~9.84 bits/item).

### Added

- **`XorFilter` -- the space-optimal static member** (Graf & Lemire, "Xor Filters", ACM JEA
  2020; decisions/0018, 0019, 0020). The family's FIRST immutable member: a new class IN
  `Filter.js`, built ONCE from a known key set and frozen. It resolves the static-build API
  deferred in decisions/0006.
  - **Static factory `XorFilter.from(iterable, options)`** (with a `.build` alias): there is
    no public constructor (`new XorFilter()` throws `[lite-filter]`), and `add` / `remove` /
    `clear` all throw `[lite-filter]` fail-closed (decisions/0019) -- a static filter has no
    mutation surface. `from()` DEDUPES its input (keys are a SET, not multiplicity -- contrast
    Cuckoo / Quotient); `size == capacity == |Set(keys)|`.
  - **3-uniform hypergraph peeling** (decisions/0018): the array is 3 equal segments of length
    `bl = ceil(1.23 * n / 3) + 32` (total `3*bl ~= 1.23*n + 96` slots). Each key touches one
    slot per segment; slots are assigned in REVERSE peel order so a key's three slots XOR to
    its fingerprint. On a peel failure the build RESEEDS deterministically
    (`seed ^ (attempt * 0x9e3779b1)`) up to 100 times, then THROWS `[lite-filter]` -- never a
    partial build. The **fail-OPEN guard** (the charter's signature catch) asserts the peel
    stack reached `n` BEFORE any fingerprint is assigned; a short stack is a peel failure
    (reseed / throw), never assigned from.
  - **Byte-aligned fingerprint width** (decisions/0020): `fw = 8` when `fpp >= 2^-8` (~0.0039),
    else `fw = 16`; `fpp < 2^-16` throws (the 16-bit floor, inclusive at `2^-16`). The
    delivered FPR is the width-quantized `2^-fw`, typically UNDER the configured target;
    `fpp()` reports it. At the default `fpp = 0.01`: `fw = 8`, MEASURED FPR ~0.0039 (torture
    differential, n=1e5 over 1e6 disjoint probes), bits/item ~9.84 at n=1e6 -- LEANER than
    Cuckoo (~21) / Quotient (~23) and competitive with Bloom (~9.6) at a lower FPR. Position
    reduction is `hash % bl` (exact for a 32-bit hash; multiply-shift would lose precision).
  - **0 false negatives, proven at scale**: differentialStaticInt(XorFilter, n=1e6) reads back
    with exactly 0 false negatives (which can hold ONLY if the peel was complete -- it doubles
    as the fail-open regression gate).
  - Hot path `mightContain` / `has` is strictly zero-alloc on `keys:'int'` (3 hashes, 3 modulo
    reductions, an XOR-compare, no scratch): 0 scavenges at N=200000 and 8N=1600000 under the
    pinned 4MB semi-space (perf-gate `xfQueryHit`). Build is a cold path (allocation there is
    fine); ~168ms to build n=1e6.
  - `dump()` / static `XorFilter.restore(snap, opts?)` with a `{ f, mem:"Xor", fw, bl, cap,
    fpp, seed, keys, count, fp }` tag. `restore()` re-derives every consistency tie BEFORE
    populating (fw from fpp, `bl == ceil(1.23*count/3)+32` from count, `fp.length == 3*bl`,
    every word in `0..(1<<fw)-1`) and REJECTS any corruption -- never truncates.
- **`Filter.d.ts`** -- `XorFilter<K>` with static `from` / `build` / `restore`, `add` /
  `remove` / `clear` typed `never`, and a private constructor; `FilterSnapshot` extended with
  the optional `bl` field (the `fp` field is shared with Cuckoo).
- **Gates extended** -- the conservation + structure invariant `validateXor` (fw in {8,16};
  `fp.length == 3*bl`; `bl == ceil(1.23*count/3)+32`; count == capacity >= 1; every word in
  range); a `differentialStaticInt` Set-oracle differential; a `test/Xor.test.js` boundary
  suite and a `test/QaAuditXor.test.js` stub; an `xfQueryHit` perf-gate scenario; a
  `measureXor` / `printXorTable` / `runBenchXor` bench column (Bloom vs XOR, measured-vs-theory
  FPR, amortized build ns/key); the torture GATE line grows `xf` terms (`fn=0`, `fpr`,
  `buildThrew=true`, `mutThrew=true`).

### Changed

- **Snapshot format v2 with a family-wide integrity checksum** (decisions/0021) -- BREAKING
  snapshot-format change (0.x line; nothing published depends on cross-version restore). The
  format tag is bumped `litefilter/1` -> `litefilter/2`, and every member's `dump()` (Bloom,
  CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter) now emits a 32-bit integrity
  checksum `chk` computed over -- in a fixed order -- the tag, member name, keys-mode, seed,
  every sizing/width field, the count, and every store word (reuses the murmur3 `fmix32`
  substrate; no new deps; cold path only, hot paths untouched).
  - **`restore()` now rejects provenance + store corruption, including a keys-mode or seed
    flip.** This closes a real FAIL-OPEN (QA-reported): the keys-mode and seed are free
    construction inputs that CANNOT be re-derived from the stored bytes, so a snapshot whose
    `keys` was flipped `"int"` <-> `null` (or whose `seed` was changed to another valid
    uint32) previously reconstructed under the wrong hash path and read back with silent false
    negatives (1990/2000 on a 2000-key XOR dump). Every member's `restore()` runs its
    structural checks FIRST, THEN recomputes the checksum and REJECTS a mismatch fail-closed,
    all before any field assignment or array build (REJECT, never truncate).
  - `chk` is an INTEGRITY check against accidental corruption, NOT a MAC: a determined forger
    who recomputes `chk` is out of scope (the same limitation as any non-keyed checksum). A v1
    snapshot carries no `chk` and is rejected -- re-`dump()` from a live filter to migrate.
  - `Filter.d.ts` `FilterSnapshot` gains an optional `chk: number`; the torture GATE line
    grows a `snapChk=ok` term (a keys-mode flip and a store-bit flip rejected for Bloom + XOR);
    positive per-member checksum tests added (pristine round-trip 0 FN; keys-flip / seed-flip /
    one-store-word-flip each throw).

[0.6.0]: https://github.com/PeshoVurtoleta/lite-filter/releases/tag/v0.6.0

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

[0.5.0]: https://github.com/PeshoVurtoleta/lite-filter/releases/tag/v0.5.0

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
