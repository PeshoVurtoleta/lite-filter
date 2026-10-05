# LiteFilter -- roadmap and charter

> COMPLETE (v1.0.0, status stable). All SEVEN members ship under one
> `LiteFilter<K>` surface -- Bloom, CountingBloom, BlockedBloom, Cuckoo,
> Quotient, XorFilter, BinaryFuse -- with `Filter.js`, `Filter.d.ts`, the full
> boundary suite, the torture + controls + perf gates, the shipped bench,
> `README.md`, `llms.txt`, and `CHANGELOG.md`. This file remains the CHARTER the
> planner -> coder -> reviewer -> qa pipeline built against; the design rulings it
> proposed are now recorded in `decisions/0001..0023`. Every number below was
> either proven by the shipped seeded bench in this repo or is a paper citation --
> read `decisions/` and the bench for the shipped values, not this charter's targets.
>
> H1 COMPLETE (2026-09-23): post-audit hardening shipped and published as 1.2.0 --
> section 12, audit record `RESEARCH.md`, rulings `decisions/0024..0026`.
>
> H2 OPEN (2026-10-05): Smi-width-proof int hot path for lite-hud M5, 1.2.1 -- section 13,
> evidence `RESEARCH.md` section 2, prototype `research/h2-proto/`.

ASCII-only (`->`, `<=`, `>=`, `x`, "1.23x", never Unicode arrows or the
multiplication sign). Suite law from `../CLAUDE.md` applies verbatim: npm scope
`@zakkster/*`; zero runtime deps; `node:test` only; a single PascalCase main
file (`Filter.js`); `sideEffects: false`; `llms.txt` + `CHANGELOG.md` per
package; MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- never "Karadjov";
zero allocation on any hot path; fail closed on every unverified state (null is
not zero).

---

## 1. Vision

A zero-GC, single-file, tree-shakeable ESM library of the famous
**approximate-membership** filters -- Bloom and its descendants -- under ONE
uniform `LiteFilter<K>` surface, exactly as `@zakkster/lite-lru` puts its many
eviction policies under one `LiteCache<K,V>` surface. The filter is a one-line
constructor swap; the surface, the tests, and the bench stay identical.

The real problem it solves: **"have I seen this key?"** -- dedup, set membership,
cache admission, "is this URL/hash/id probably in the set?" -- at a fraction of
the memory a `Set` costs. A JS `Set` stores every key by value (or reference),
allocates per entry, resizes by copying, and is heavy: tens of bytes per entry
plus GC pressure. A probabilistic filter answers the same membership question in
a handful of BITS per entry, with a small, bounded, tunable false-positive rate
and **zero false negatives** -- at fixed, preallocated memory with no per-op
allocation.

And -- the reason this is a FAMILY, not one filter -- choosing the right
probabilistic structure is a genuine, hard-to-navigate decision with **no
universal winner**. Bloom is the textbook baseline but not the most space-
efficient and cannot delete. Cuckoo and Counting Bloom can delete but cost more.
XOR and Binary Fuse are near the space lower bound but are STATIC (build once
from a known set, no inserts after). Blocked Bloom trades a little accuracy for
one cache miss per query. That tension IS the product, and it is captured in a
repo-only `GUIDE.md` plus a shipped bench that measures the tradeoff on the
caller's own keys.

Non-goals stated up front: this is not a cryptographic structure (fingerprints
are not MACs), not an exact set (that is what `Set` is for), and not a
key-value store (it stores membership, never values).

---

## 2. The uniform surface (`LiteFilter<K>`)

Every member implements the same surface. The two hot-path primitives are
`add` and `mightContain`; everything else is cold or opt-in.

Hot path (zero allocation, all members):

- `add(key) -> void` -- record a key. On a STATIC member (XOR, Binary Fuse) after
  the set is frozen, `add` throws a `[lite-filter]` Error (fail closed); those
  members are populated by a batch build (see the static build API, section 11).
- `mightContain(key) -> boolean` -- the query. **No false negatives**: if a key
  was added (and, for a deletable member, not since removed) this returns `true`
  always. A `true` on a never-added key is a false POSITIVE, bounded by the
  configured `fpp`. The honest caveats:
  - On add-only and static members `mightContain` is one-sided: false positives
    only, never false negatives, unconditionally.
  - On a DELETABLE member (Counting Bloom, Cuckoo, Quotient), removing a key
    that was NEVER added can corrupt state and cause a later false NEGATIVE for a
    key that WAS added -- the classic Counting-Bloom / Cuckoo caveat. Documented
    honestly, not hidden: `remove` is only sound for keys known to have been
    added.

Decision aliases and inspection (cold or O(1), never allocate on the hot path):

- `has(key)` -- the SOLE alias of `mightContain` (decisions/0003), same one-sided
  semantics. The deferred naming ruling shipped `has` as the one canonical alias;
  `contains` was NOT added (one canonical name plus at most one alias, not three).
- `remove(key) -> boolean` -- ONLY on deletable members (Counting Bloom, Cuckoo,
  Quotient). Static and plain-Bloom members throw a `[lite-filter]` Error
  (fail closed) rather than silently no-op'ing.
- `size` / `count -> number` -- number of keys added (a plain counter, not an
  estimate). For deletable members this tracks add/remove.
- `capacity -> number` -- the item count the filter was sized for at construction.
- `fpp() -> number` -- the false-positive probability: the CONFIGURED target for a
  freshly sized filter, or an ESTIMATE derived from the current fill (bits set /
  load factor) as it fills. The estimate is a closed-form number, explicitly NOT
  a measurement -- section 5 is the whole warning about trusting it.
- `clear() -> void` -- reset to empty; allocates nothing (zeroes the existing
  typed-array store in place).

Family cross-cutting surfaces, mirrored one-for-one from lite-lru so the two
libraries feel identical:

- **`keys: 'int'` strict zero-alloc mode** -- opt into a keys-are-32-bit-signed-
  integers fast path where even the hashing allocates nothing (an integer mix,
  no string encoding). Out-of-range / non-integer keys throw a `[lite-filter]`
  TypeError. The default backing hashes arbitrary keys and is honestly AMORTIZED
  where it must encode strings (stated, not hidden). Mirrors lite-lru D11.
- **Opt-in stats** -- `{ stats: true }` mints a per-instance holder
  `{ adds, queries, hits, misses }` (a query that returns true is a "hit"). OFF
  by default; when off the hot path writes nothing (`_stats === null`). Mirrors
  lite-lru D19. `stats()` / `resetStats()` fail closed on a non-stats instance.
- **`dump()` / `restore()` snapshot** -- the typed-array bit/fingerprint store IS
  the serial form. `dump()` emits a plain, structurally-cloneable snapshot with a
  fail-closed tag `{ f:'litefilter/3', m, cap, bits, k, keys, ... }`;
  `Member.restore(snap, opts?)` rebuilds a fresh instance, rejecting any
  member / capacity / bit-count / seed mismatch (REJECT, never truncate). Because
  the store is already a flat typed array, the snapshot is close to a raw byte
  copy -- much cheaper than lite-lru's per-slot graph. Mirrors lite-lru D21.
- **A bench tool** (`benchmark/Bench.mjs`) -- runnable and importable, imports
  only `./Filter.js`, measures actual vs theoretical FPR (section 7).

`Filter.d.ts` types `LiteFilter<K>` so every member is one-line-swappable under a
tsc check, exactly like lite-lru's `LiteCache<K,V>` swap test.

---

## 3. The members (the lineage / the story)

Grouped by the one axis that changes the surface's shape -- whether keys can be
inserted incrementally, and whether they can be removed.

### MUTABLE (incremental `add`; some deletable)

- **Bloom** (Bloom, "Space/Time Trade-offs in Hash Coding with Allowable
  Errors", CACM 1970). The baseline and the reference member. One bit array,
  `k` hash positions per key; `add` sets `k` bits, `mightContain` checks `k`
  bits. Add-only (no `remove`). The differential oracle every other member is
  measured against, and the honest floor. *Tradeoff it addresses:* none -- it IS
  the tradeoff everything else improves on.
- **Counting Bloom** (Fan, Cao, Almeida & Broder, "Summary Cache", ToN 2000).
  Replaces each Bloom bit with a small saturating counter (typically 4 bits) so
  keys can be REMOVED (decrement the `k` counters). *Tradeoff:* delete support at
  roughly 4x the space of plain Bloom, plus the counter-overflow and
  remove-never-added caveats.
- **Blocked Bloom** (Putze, Sanders & Singler, "Cache-, Hash- and Space-Efficient
  Bloom Filters", 2007/2009). All `k` bits of a key live in ONE cache-line-sized
  block, so a query costs ONE cache miss instead of `k`. *Tradeoff:* slightly
  worse FPR for the same bits (blocking loses some independence) in exchange for
  the throughput win -- the query-speed pick.
- **Cuckoo filter** (Fan, Andersen, Kaminsky & Mitzenmacher, "Cuckoo Filter:
  Practically Better Than Bloom", CoNEXT 2014). Stores short FINGERPRINTS in a
  cuckoo hash table with two candidate buckets and partial-key cuckoo
  displacement. *Tradeoff:* deletable AND more space-efficient than Bloom at low
  target FPR, at the cost of a bounded insert-failure mode when the table nears
  full (fail closed on insert failure -- null is not zero).
- **Quotient filter** (Bender et al., "Don't Thrash: How to Cache Your Hash on
  Flash", VLDB 2012). Stores quotiented fingerprints in a single array with
  three metadata bits per slot; cache-friendly, MERGEABLE, RESIZABLE, and
  deletable. *Tradeoff:* the metadata bits and cluster shifting cost some space
  and insert work in exchange for merge/resize that no other member offers.

### STATIC / BATCH-BUILT (build once from a known set; no inserts after)

- **XOR filter** (Graf & Lemire, "Xor Filters: Faster and Smaller Than Bloom and
  Cuckoo Filters", ACM JEA 2020). Space-optimal static filter built by peeling a
  3-uniform hypergraph from a KNOWN set of keys; a query XORs 3 table entries.
  Approaches the ~1.23x information-theoretic lower bound on bits per key at a
  given FPR. *Tradeoff:* smallest and fast to query, but the set must be known at
  build time -- NO inserts after build.
- **Binary Fuse filter** (Graf & Lemire, "Binary Fuse Filters: Fast and Smaller
  Than Xor Filters", ACM JEA 2022). The current state of the art static filter:
  better space AND faster construction than XOR (a segmented, fuse-graph peel
  that fails to build far less often). *Tradeoff:* same static, build-from-a-
  known-set constraint as XOR, but strictly better on both space and build time.

So: **five MUTABLE** (Bloom, Counting Bloom, Blocked Bloom, Cuckoo, Quotient)
and **two STATIC / BATCH-BUILT** (XOR, Binary Fuse) -- seven members at the full
roster.

---

## 4. The GUIDE.md axes (the "which do I pick" tension)

There is no universal winner; the decision is a point in a several-dimensional
space, and naming the axes is what makes the `GUIDE.md` decision table and its
mermaid flowchart honest. The independent axes:

1. **Target false-positive rate** -- 1%? 0.1%? 0.001%? The lower the target, the
   more the space-optimal static filters (XOR / Binary Fuse) pull ahead of Bloom.
2. **Bits per item (space)** -- the primary cost. Bloom ~ `1.44 * log2(1/fpp)`;
   XOR / Binary Fuse approach the ~1.23x-of-lower-bound region; Counting Bloom
   pays ~4x Bloom for deletes.
3. **Delete support** -- static (no delete, XOR / Binary Fuse) vs add-only
   (plain / Blocked Bloom) vs deletable (Counting Bloom, Cuckoo, Quotient).
4. **Construction model** -- incremental `add` as keys arrive (all mutable
   members) vs known-set BATCH build (XOR, Binary Fuse). If you cannot enumerate
   the set up front, the static members are simply off the table.
5. **Lookup speed + cache locality** -- cache misses per query: plain Bloom up to
   `k` misses; Blocked Bloom one; Cuckoo two buckets; XOR three table reads (one
   region); Binary Fuse a tight segment.
6. **Mergeability / resizability** -- Quotient merges and resizes; the others do
   not (a Bloom union works only for identical parameters).
7. **Approximate COUNT vs plain presence** -- Counting Bloom can estimate a key's
   multiplicity; the presence-only members answer yes/no. If you need "how many
   times", that narrows the field hard.

Sketch of the decision-table rows the `GUIDE.md` will build (each a starting
hypothesis to TEST with the bench, never a verdict):

| Your need | Start with | Why |
| --- | --- | --- |
| Known static set, minimize space | Binary Fuse (alt: XOR) | near the ~1.23x lower bound, no inserts needed |
| Need deletes | Cuckoo (alt: Counting Bloom) | deletable; Cuckoo better space at low fpp |
| Maximum query throughput | Blocked Bloom | one cache miss per query |
| Simple, well-understood baseline | Bloom | the textbook default; the floor |
| Mergeable / resizable | Quotient | the only member that merges + resizes |
| Approximate multiplicity, not just presence | Counting Bloom | counters carry a count |

The `GUIDE.md` is REPO-ONLY -- NOT in `package.json` `files[]`, exactly like
lite-lru's `GUIDE.md`. The shipped `README.md` carries the concise table;
`llms.txt` carries the per-member "good for / not for"; `GUIDE.md` is the long
form with the flowchart and the measured numbers.

---

## 5. The honesty hook (the guide's whole point)

lite-lru's `GUIDE.md` earns its keep with a measured surprise: `ClockPro`, the
CLOCK approximation of LIRS, scores **0% of Belady optimal on a pure loop** where
`Lirs` hits 99.2% -- theory is not measurement. lite-filter has the exact
counterpart, and it is the reason to ship a bench at all:

**The MEASURED false-positive rate diverges from the THEORETICAL closed-form.**
The textbook `fpp = (1 - e^(-kn/m))^k` assumes independent, uniformly random hash
positions. Under real key distributions, at high load factor / near-full fill,
and with a WEAK or biased hash, the observed FPR runs OVER the formula --
sometimes far over. A Cuckoo or Quotient filter near its load-factor ceiling
degrades differently again (insert pressure, longer probe chains). A number
copied from a paper or a formula is a starting hypothesis, not your filter's
behavior on your keys.

**The GUIDE's GOLDEN RULE:** MEASURE your own keys with the shipped bench --
actual FPR vs bits/item vs build-ns vs query-ns, checked against a real `Set`
ground-truth oracle -- rather than trusting the closed form. Every strong claim
in `GUIDE.md` must trace to a seeded bench number produced by THIS repo, or else
say "measure your own keys". No un-numbered assertions ship. This mirrors
lite-lru's reviewer-enforced honesty discipline: an overclaimed FPR or space
bound is a REJECT, sent back to coder, not forward.

---

## 6. Zero-GC design notes

- **Preallocated typed-array stores.** The bit array (Bloom / Blocked), the
  counter array (Counting Bloom), and the fingerprint tables (Cuckoo / Quotient /
  XOR / Binary Fuse) are typed arrays chosen to fit the datum: `Uint8Array` for
  byte-addressed counters/fingerprints, `Uint32Array` for bit words,
  `BigUint64Array` where 64-bit words pay off. Sized ONCE at construction from
  `(n, target fpp)`; never grown, never reallocated on the hot path.
- **No per-op allocation.** `add` and `mightContain` compute positions and read/
  write words in place. No arrays, no objects, no boxed numbers, no iterator
  results per call.
- **Fail-closed sizing.** An impossible request (fpp <= 0, fpp >= 1, capacity < 1,
  a bit count that would overflow a safe typed-array length) throws a
  `[lite-filter]` RangeError at the door. null is not zero: an unsized filter is
  never treated as a zero-capacity one.
- **Kirsch-Mitzenmacher enhanced double hashing** (Kirsch & Mitzenmacher, "Less
  Hashing, Same Performance", 2006). Derive all `k` probe positions from just TWO
  base hashes: `h_i = h1 + i*h2` (mod m), `i = 0..k-1`. This gives `k` independent-
  enough probes with ZERO allocation and only two real hash computations per
  operation -- the standard zero-GC way to get `k` positions without a `k`-length
  array.
- **OPEN DECISION -- the zero-dep hash function.** A `decisions/00xx` ruling to
  make in planning. Candidates: a strong finalizer / mixer over the key bytes
  (murmur3 `fmix`, or an xxhash-style mix) for the default arbitrary-key path; a
  fast integer mix for `keys:'int'`; and a string-hash path for arbitrary string
  keys. The hash quality directly drives whether the MEASURED FPR tracks the
  formula (section 5), so this ruling is load-bearing and must be validated by the
  bench, not chosen by reputation.

---

## 7. Bench design

`benchmark/Bench.mjs` -- seeded and deterministic, runnable (`npm run bench`) and
importable (`import { runBench } from '@zakkster/lite-filter/benchmark/Bench.mjs'`),
importing only `./Filter.js` (zero runtime deps). It exists to make the section-5
divergence VISIBLE.

Per member it measures:

- **Actual FPR** -- build/fill the filter, then query a large disjoint set of
  never-added keys and count `mightContain` trues, checked against a real `Set`
  oracle so a false positive is unambiguous.
- **Bits per item** -- store bytes * 8 / items.
- **`add` ns/op** and **`mightContain` ns/op** -- wall-clock, machine-local,
  never a cross-library headline.
- **Build cost** for the static members (XOR / Binary Fuse peel time, and peel
  RETRY count -- a real cost that separates XOR from Binary Fuse).

Workloads (seeded generators, reusable on the caller's own captured keys):

- uniform-random keys,
- zipfian keys (skewed popularity),
- sequential integers,
- an adversarial / high-load case (near-full fill, and a deliberately clustered
  key distribution that stresses a weak hash).

The headline output is **`% over theoretical FPR`** -- `(measured - formula) /
formula` -- so the divergence the whole library is honest about is the first
thing the table shows. A member whose measured FPR sits far over its formula on
the adversarial workload is doing its job of TEACHING, not failing a gate.

---

## 8. Synergy

Approximate membership is not a neighbor of lite-lru -- it is the machinery
already INSIDE it:

- `WTinyLfu`'s Count-Min sketch is an approximate-frequency structure; the
  `S3Fifo` / `Arc` / `Lirs` / `ClockPro` / `LruK` / `Mq` GHOST queues are all
  keys-only approximate-membership structures ("have I evicted this key
  before?"). lite-filter and lite-lru should cite each other, and a Bloom or
  Cuckoo ADMISSION filter is a natural feedback INTO lite-lru: gate cache
  admission on "have I seen this key at least once" to keep one-hit-wonders out.
- Pairs with `@zakkster/lite-binary-reader`: build a filter over keys / record
  ids parsed straight out of a foreign binary buffer, no intermediate `Set`.
- The dev-only `@zakkster/lite-perf-gate` zero-alloc `node:test` gate
  (`npm run test:perf` inside `verify`) is the per-member CI discipline:
  add-churn + query-hit scenarios on the `keys:'int'` backing, proving 0
  scavenges per member, exactly as lite-lru gates its members' 24
  scenarios.

---

## 9. Discipline / process

Pipeline (suite law): **planner -> coder -> reviewer (adversarial, honesty-
enforced) -> qa**. Reviewer REJECTED goes back to coder, not forward. Every
member is proven by the mandatory torture gate --
`node --expose-gc test/torture.mjs` with `@zakkster/lite-leak` +
`@zakkster/lite-gc-profiler`; no gate output is a FAIL.

**The "adding a member touches everything" rule** -- stated up front so it never
drifts (this is lite-lru's hard-won memory: a new cache member that skips the
bench is a shipped tool that silently omits it). Each new filter MUST, in the
same change, add its:

1. bench row (add + query + FPR-vs-theory, all workloads),
2. `GUIDE.md` row + one-paragraph mental model + a flowchart branch,
3. torture oracle (the differential `Set` ground truth for its semantics),
4. `validate()` term (its conservation invariant -- e.g. bits-set consistency,
   Cuckoo bucket occupancy, Quotient run structure),
5. `lite-perf-gate` scenarios (add-churn + query-hit, `keys:'int'`),
6. `README.md` + `llms.txt` roster entry,
7. `decisions/00xx` ruling for any honest deviation from the paper.

A member that lands without all seven is incomplete by definition.

---

## 10. Milestones

`v0.1.0` = the SUBSTRATE + the reference member, everything the family stands on:

- the shared zero-GC typed-array store + the Kirsch-Mitzenmacher probe machinery,
- the uniform `LiteFilter<K>` surface (`add` / `mightContain` / `has` / `size` /
  `capacity` / `fpp` / `clear`),
- **Bloom** as the reference member and differential oracle,
- `keys:'int'` strict-zero-alloc mode + opt-in stats,
- `dump()` / `restore()` snapshot,
- the bench (actual-vs-theoretical FPR) + the torture + perf gates,
- a `GUIDE.md` skeleton.

Then ONE member per release, the `GUIDE.md` growing each time -- exactly how
lite-lru grew from `LiteLru` to its many members. Build order, mutable/simple
first, static/space-optimal last, each with its one-line rationale:

1. **Counting Bloom** -- smallest step past Bloom (bits -> counters); introduces
   `remove` and the deletable-member caveats to the surface.
2. **Blocked Bloom** -- same bit-array family, adds cache-line blocking; proves
   the query-throughput axis and the FPR-vs-locality tradeoff on the bench.
3. **Cuckoo** -- first fingerprint-table member; introduces displacement, the
   bounded insert-failure fail-closed path, and better-than-Bloom space at low
   fpp.
4. **Quotient** -- second fingerprint member; introduces merge / resize and the
   metadata-bit machinery (the most complex mutable member).
5. **XOR** -- first STATIC member; introduces the batch-build / freeze API and the
   hypergraph peel; establishes the space lower-bound baseline.
6. **Binary Fuse** -- the state-of-the-art static member; strictly better space +
   build time than XOR, so it lands last as the headline the roster builds toward.

Rationale for the ordering: each release adds at most one new CONCEPT to the
surface (delete, then blocking, then fingerprint displacement, then merge/resize,
then the static build model, then the refined static build), so the reviewer and
qa gates only ever have one new axis to break. The static members come last
because their build-from-known-set API is the biggest surface change and is best
designed once the mutable members have settled the rest of the surface.

---

## 11. Open design decisions (RESOLVED -- each carries its `decisions/` ruling)

All six charter questions are now settled; the pointer after each is the shipped ruling.

1. **Default hash function + arbitrary-key hashing** (section 6) -- RESOLVED
   (decisions/0001, 0023): murmur3 `fmix32` finalizer; a direct integer mix for
   `keys:'int'`; strings hashed over their UTF-16 code units (alloc-free). The XOR /
   Binary Fuse string path draws a SECOND independent `hashStr(s, seed2)` for its edge
   hash (decisions/0023). Validated by the bench's FPR-vs-theory number, not reputation.
2. **The static-filter build API** -- RESOLVED (decisions/0006, 0018, 0022): a static
   `Member.from(iterable, opts)` / `.build` factory (NOT add-then-freeze), uniform across
   XorFilter and BinaryFuse; `add`/`remove`/`clear` on a static instance throw fail-closed.
3. **`remove()` scope + caveat** -- RESOLVED (decisions/0003, 0009, 0015, 0017): `remove ->
   boolean` on the deletable members (CountingBloom, Cuckoo, Quotient) only; add-only and
   static members throw. The never-added-remove false-negative caveat is on the surface.
4. **The snapshot / serialize format** -- RESOLVED (decisions/0005, 0021, 0023): `dump()`
   emits the tagged plain-array snapshot (`f:'litefilter/3'`, member, sizing/width fields,
   seed, keys mode, count) plus a 32-bit integrity `chk`; `restore()` rejections are
   enumerated and REJECT-never-truncate. The tag advanced to `litefilter/3` (decisions/0023).
5. **How `fpp` / capacity are specified at construction** -- RESOLVED (decisions/0002):
   `(n, fpp)` derives `m` and `k` (Bloom) / the member's width + geometry; `fpp()` reports
   the CONFIGURED target (or the width-quantized closed form for the fingerprint members).
6. **Whether to offer an approximate `count()`** -- RESOLVED (decisions/0010): presence-only;
   `size`/`count` is the EXACT net count of adds/removes, not a multiplicity estimate. A
   estimated `count()` stays deferred (it would be opt-in and clearly an estimate if added).

---

## 12. Post-1.1 hardening -- H1 (1.2.0): the 2026-09-23 zero-GC audit close-out

> COMPLETE (1.2.0, commit 1ec797d, published). Rulings: decisions/0024 (int32 stays signed; the error
> names `| 0`), 0025 (keysMode / seed), 0026 (maxLoad as an UPPER BOUND + saturation). Exit gates:
> 516/0 unit tests, torture ok (alloc=0 B/op, gc major=0, negFn=0), controls ok (3 arms), perf 30/0
> (7 negative-int lanes at maxScavenges 0; amortized default-backing lane 8..104 B/op, median ~41),
> test:demo 54 pass / 2 skipped, pack 8 files / 101.3 kB. N5 stays documented, not fixed.

Source: the read-only adversarial audit of 2026-09-23 (RESEARCH.md). Verdict: the claim HOLDS for
all seven members. Zero runtime deps, 0 B/op on every int hot path, a TRUE `maxScavenges: 0` perf
floor, fail closed (no silent `>>> 0` / `| 0` truncation), and every measured FPR at or under its
documented bound. There are no defects. The findings are integration constraints and introspection
gaps, most surfaced by the planned consumer lite-hud M5 (`Bloom`, `keys:'int'`, first-seen error
signatures on its hot path).

Entry state: 1.1.0 (commit af08da4), git clean, 497/0 unit tests, torture ok, controls ok (3 break
arms), perf 22/0, pack 8 files / 96 kB. Minor release: getters are additive, with no wire or snapshot
format change. Pipeline: planner -> settle -> coder -> reviewer -> qa -> /release 1.2.0 ->
/sync-card lite-filter.

TASKS
1. N1 (S2) -- `keys:'int'` accepts SIGNED int32 only (decisions/0001), so `add(2147483648)` and
   `add(0xFFFFFFFF)` THROW. A consumer that folds a signature with `>>> 0` throws on the hot path
   for half the domain. SETTLE: (a) document loudly and ship a signed-fold example in README +
   llms.txt + d.ts (`((a << 20) | (b << 12) | c) | 0`), vs (b) also accept [2^31, 2^32) by
   normalising with `| 0` inside the door (the domain widens; it must stay injective on the 32-bit
   pattern). Lean: (a); the domain stays as decisions/0001 rules it. The error text names `| 0` as
   the fix.
2. N2 (S3) -- read-only getters `keysMode` ('int' | 'arbitrary') and `seed` on every member, so a
   consumer detects config without catching an error or reading `_int` (today only `dump().keys`,
   which is a full serialize). O(1), 0-alloc. d.ts + README.
3. N3 (S3) -- `size` can exceed `capacity`: Cuckoo(cap=64) took 127 adds before throwing, and
   Quotient(cap=64) took 115. The real ceiling is `nb*b` / `floor(0.9*nslots)`. Add getters
   `maxLoad` (the real ceiling) and `remaining` (or `saturation` in [0, 1]) to Cuckoo and Quotient,
   plus the same shape on every member where it is meaningful. Correct the overload error text,
   which currently advises "size vs capacity" as a headroom check.
4. N4 (S3) -- gate the M5 lane. Add a NEGATIVE-int32 lane (INT_MIN..-1, plus INT_MIN / INT_MAX edges)
   to the torture oracle (fn = 0) and to PerfGate (maxScavenges 0). Add a default-backing lane for
   fractional / large numbers under an explicit AMORTIZED byte budget (not 0; N5 is documented).
   Audit measurement: negative int32 is already 0 heap growth, so this gate proves an existing
   property.
5. N6 (nit) -- add a `test:demo` script for `demo/Demo.test.mjs` (999 lines, not run by `npm test`);
   drop the dead `XorFilter._hashKey` / `BinaryFuse._hashKey` (Filter.js:3471, 3844).

GATES
- `npm test` + new units: keysMode/seed values for every member x both modes; maxLoad/remaining
  match the measured ceilings; a "size may exceed capacity" assertion; the N1 behavior as settled.
- torture: alloc=0 B/op, gc major=0, plus the negative-int oracle lane (fn = 0).
- perf: maxScavenges=0 on every int lane INCLUDING negatives; the amortized default-backing lane has
  its own budget.
- controls: the three break arms unchanged and still failing for their matched reason.
- Version trinity (package.json / Filter.js VERSION / llms.txt), CHANGELOG head, README + llms.txt +
  d.ts for the getters; pack still 8 files with demo/test/decisions absent.

## 13. H2 (1.2.1): Smi-width-proof int hot path -- requested by lite-hud M5 (2026-10-05)

> OPEN (code + gates + docs DONE; awaiting `/release 1.2.1`). BLOCKING for lite-hud M5 (its
> `--max-inlined-bytecode-size=0` lane). Evidence: RESEARCH.md section 2 (2.1-2.5 Node, 2.6 d8,
> 2.7 outcome). Prototype + probes: `research/h2-proto/` (not shipped).
> Patch release: no API, wire, snapshot or hash-output change.
> SETTLED 2026-10-05 (maintainer): scope is SMI-WIDTH-PROOF, not Node-only. The 31-bit-Smi
> lane runs on d8 (V8 15.7.37, `~/.jsvu/engines/v8/d8`, or `$D8`).
>
> STATUS 2026-10-05: planner -> coder -> reviewer (APPROVED, 2 REJECT rounds on gate teeth) ->
> docs DONE. Ruling: decisions/0027. The two PERF gates are green on the rewrite and revert-checked
> RED on 1.2.0 (Node SmiWidth 10/13 red, d8 SmiWidthD8 9/14 red); Parity is a WITNESS that passes on
> 1.2.0 by construction -- its teeth are the seed-perturb + re-entrancy must-fail controls. TASKS 1-5 shipped; per-class `_mixInt`
> + field-free `_ckAlt`/`mulhiU32`; Xor/BF query inlines as locals; Xor/BF build stays on fmix32;
> Quotient Smi-width-proof for nslots <= 2^30 (documented). TASK 6 (docs) DONE: README, llms.txt,
> Filter.d.ts, decisions/0027, CHANGELOG [Unreleased], RESEARCH 2.7. Exit gates: npm test 532/0,
> test:perf 43/0, test:perf:d8 14/0 (+ in verify), torture ok (FPR identical to 1.2.0), controls
> ok, parity 3,521,664 checks / 0 diffs (Node + d8 same digest). Stays OPEN until `/release 1.2.1`;
> revert-check the new gates before release.

Defect: the H1 audit measured with inlining ON only (RESEARCH 1.3). With inlining OFF, every
member allocates on the int hot path, and BinaryFuse allocates even inlined. Cause: a 32-bit hash
crosses a call boundary that V8 did not inline, and is not a Smi there, so it is boxed as a ~16 B
HeapNumber. Which values are not Smis depends on the engine:
- Node (no pointer compression, 32-bit Smis): unsigned values >= 2^31 -- half of all hashes.
- Chrome / d8 (pointer compression, 31-bit Smis): anything outside [-2^30, 2^30) -- half of all
  SIGNED hashes, three quarters of unsigned ones. Hash outputs are uniform over 32 bits regardless
  of key magnitude, so no key-range proxy (p30 lane) can model this; only a 31-bit engine can.
Boundaries on the int path today: `fmix32`'s argument and return, `hashStr`'s return, the members'
`_hash` / `_hashKey` returns, and BinaryFuse's `mulhiU32(h, scl)` argument. A consumer's hot path
is the non-inlined case: lite-hud's `write()` is large and polymorphic.

The prototype V3 (signed returns, `>>> 0` at the caller) reads 0 -> 0 on Node but only trims d8:
Bloom 2 -> 14 becomes 1 -> 11, BinaryFuse 3 -> 25 becomes 3 -> 23 (RESEARCH 2.6). V3 is therefore
NOT the fix; it is the parity reference and the Node evidence.

THE RULE (code-review law for this file, hot paths): no value that can leave [-2^30, 2^30) crosses
a call boundary, as an argument or a return. Only tagged references (the filter, the caller's own
key), Smis (16-bit halves, indices, counts) and `undefined` cross. A 32-bit word is produced and
consumed in ONE frame, or handed over through a module typed-array scratch slot.

SETTLED 2026-10-05 (maintainer, from the H2 planner): PER-CLASS mixer methods, not one shared
helper. A shared helper would see 7 maps (> V8 polymorphic limit 4); the megamorphic LoadIC re-boxes
the double-representation `_seed` / `_seed2` into a fresh HeapNumber per load -- the very box being
removed -- and the one-member-per-process lanes cannot see it. Rejected too: the caller stages seeds
into the scratch for a shared helper (a forgotten store hashes with another instance's seed =
false negatives, fail-OPEN). Field-free module helpers are allowed: `_ckAlt(fp)` (Cuckoo alt
bucket, `fp` < 2^16) and `_mixTail()` (Xor/BF `t` and `fp` words, reads/writes `_HG` only).
Xor/BF BUILD stays on plain `fmix32` (cold: every attempt allocates scaffold) -- new ADR.
The helpers are PERMITTED, not mandated. Mixing as LOCALS inside the hot method's own frame is THE
RULE's first form and is preferred where the `_HG` round-trips cost: the Xor/BF int query inlines
its four fmix bodies as locals (coder measurement: BinaryFuse int has 0.75x -> 0.90x vs 1.2.0).

Boundaries the first draft of this section MISSED (planner enumeration, confirmed in HEAD):
- XorFilter query `t = fmix32((h ^ g) | 0)` / `fp = fmix32((h + g) | 0)` (Filter.js:3501-3502) and
  BinaryFuse query (Filter.js:3873-3874): four mixer calls per query, not two -- why V3 still reads
  3 -> 20 / 3 -> 23 on d8.
- Cuckoo kick loop `vf = fmix32(Math.imul(victim, 0x5bd1e995))` (Filter.js:2357), once per kick.
- Quotient `_runStart` / `_place` index arguments: Smis unless nslots > 2^30 (>= 1 GiB store).
  Accepted with a code note.
- The snapshot API is static `restore(snap, opts)`, not `load`.
Re-entrancy invariant: no user code (`String()`, `toString`, `valueOf`) may run between a write
to `_HG` and its read.

TASKS
1. Int mixer: the int hot path of every member stops calling `fmix32`. It calls a mixer that takes
   only tagged refs -- `(this, key)` -- runs the fmix32 body in its OWN frame, reads `_seed` /
   `_seed2` there (double-representation fields; a load inside the frame never boxes, a load passed
   as an argument does), and writes the words into a module `Int32Array` scratch (`_HG`). The caller
   reads `_HG[i] >>> 0` locally. Spike (RESEARCH 2.6): Bloom only, 0 -> 0 on d8 AND Node no-inline,
   parity 0 differences. Planner decides: one shared helper (megamorphic `_seed` loads across 7
   maps -- measure it in the perf lane) vs a per-class method, and whether a member needs one word
   (Quotient), two (Bloom family, Xor/BF h + g) or a different input (Cuckoo's alt-bucket
   `fmix32(Math.imul(fp, 0x5bd1e995))`, Filter.js:2322). Each mixer copy must stay byte-identical
   to fmix32 -- a parity witness per member, not "looks the same".
2. BinaryFuse: `mulhiU32` takes 16-bit halves, `mulhiU32(h >>> 16, h & 0xffff, scl)` (query
   Filter.js:3876 and `_bfTryBuild` Filter.js:1079). Its body already reads its first argument only
   as `>>> 16` / `& 0xffff`. Its return is < `scl` <= `BF_MAX_SLOTS` (0x3fffffff), a Smi on both
   engines. `scl` is also passed; confirm it is a Smi on the build path (it is < 2^30 by cap).
3. Quotient: the int branch of `_hash` goes through the TASK 1 mixer; the `_hash` return is consumed
   only as `& this._pMask` (Filter.js:2814, 2907, 2946), so the caller can read the scratch slot
   directly and `_hash` need not return a word at all on the int path.
4. `fmix32` / `hashStr` themselves: keep them for cold and string paths. Return signed (`| 0`) with
   `>>> 0` at the caller (the V3 change) where that is byte-identical and cheap; it removes the Node
   boxing on the string path for free. There are 64 `fmix32(` call sites (68 occurrences = 1
   definition + 3 doc comments + 64) and 19 `hashStr(` call sites. The V3 patch was a blind sed that
   also rewrote a doc comment (Filter.js:151); the coder edits code only, and doc comments only
   where the text becomes false.
   - The cold checksum (Filter.js:850-859) passes `>>> 0` arguments; switch them to `| 0`
     (byte-identical: fmix32 opens with `h ^= h >>> 16`) or leave them with a one-line note -- cold
     is outside THE RULE, but say so.
   - `_hashKey` (Filter.js:1355, 1722, 2037, 2471): V2 failed because callers consume `a`
     non-bitwise. If `_hashKey` returns signed, its callers do `this._hashKey(key) >>> 0`.
5. STRING path is OUT of 1.2.1's zero-box claim. `hashStr(key, this._seed)` passes a double-field
   seed and returns a 32-bit word, so it boxes per op in a non-inlined consumer on either engine.
   Inline lanes stay 0 (unchanged). Docs say so; the Smi-width-proof string path is H3 with its own
   lane (same pattern: `(this, str)` in, scratch out).
6. Docs: README / llms.txt / d.ts zero-GC wording states the gated lanes exactly -- int keys, inline
   and no-inline, Node and d8 -- and that the CALLER must pass keys in [-2^30, 2^30) on 31-bit-Smi
   engines (a key outside it is boxed at the caller's own `has(k)` call, before the library runs).
   Fix the mightContain doc comment "Zero allocation on the int + string paths" to the gated truth.
   CHANGELOG 1.2.1. RESEARCH 1.6 already carries the correction note.

GATES (each must FAIL on 1.2.0 -- revert-check before /release)
- Perf, Node: `--max-inlined-bytecode-size=0` lane AND inline lane, every member, int keys over the
  full int32 range (`Math.imul(i + 1, 2654435761) | 0`; insert 2048, probe 4096 = half hits / half
  misses; plus the +-2^31 edges), maxScavenges 0. 1.2.0 reads 3..12 no-inline (Quotient 0 -> 3 is
  the low end) and BinaryFuse 0 -> 3 inline. The current "BinaryFuse query-hit" lane passes on
  1.2.0, so it lacks teeth.
- Perf, d8 (31-bit Smis): same members and op mix, keys in [-2^30, 2^30)
  (`Math.imul(i + 1, 2654435761) >> 1`, so the CALLER never boxes and every scavenge is the
  library's), inline and no-inline, maxScavenges 0, with a `nop` control lane that must read 0.
  Template: `research/h2-proto/probe-d8.mjs` + `run-d8.mjs` (`KS=smi31`). 1.2.0 reads 1..3 -> 8..25
  no-inline; V3 reads 1..3 -> 7..23, so this lane also rejects V3.
  - FAIL CLOSED when d8 is absent: the lane is a FAIL with the install hint, never a skip
    (suite law: no gate output is a FAIL). It lives in its own npm script (`test:perf:d8`) and
    `verify` runs it. d8 lanes run as child processes from a node:test file (no runtime dep).
- Parity vs `git show HEAD:Filter.js`: every member x {int, string} x seeds {default, 1,
  0xdeadbeef, 0x80000000}: identical `add` / `remove` outcomes (including throws), `has` over 50k
  probe keys, `size` / `seed` / `capacity`, and `dump()` bytes. Template:
  `research/h2-proto/parity.mjs` (160,308 checks; V3 reads 0 differences). Add a `load(dump())`
  round-trip, and run the parity file on d8 as well (the arithmetic must not depend on the engine).
- Unchanged: 516 unit tests, torture (same FPR figures -- FPR identical to 1.2.0 is itself a parity
  witness), controls, perf 30 + the new lanes. Wall-clock: report ops/s for the int `has` lane vs
  1.2.0 on Node inline; a regression over 10% needs a written justification in the CHANGELOG.

SESSION PLAN (2026-10-05)
0. Done this session: harness copied to `research/h2-proto/` (parity + Node probe reproduce exactly);
   d8 installed and verified 31-bit (`%IsSmi(2**30) === false`); d8 probe + Bloom spike (`mk-v4.mjs`).
1. planner (read-only): spec + atomic tasks + falsifiable assertions from this section; enumerate
   every int hot-path boundary per member; settle shared-vs-per-class mixer.
2. coder: GATES first (both perf lanes + parity file), proven red on 1.2.0 and on V3; then TASKS 1-4
   member by member, Node + d8 lanes after each; then `node --expose-gc test/torture.mjs`.
3. reviewer (read-only): THE RULE audit over the diff (every argument and return on the int path),
   gate teeth, doc truth. REJECTED goes back to coder.
4. coder: TASK 6 docs. qa: boundary suite + ASSERTIONS + `npm run verify` incl. `test:perf:d8`.
5. Revert-check every new gate against 1.2.0, then hand to the maintainer for `/release 1.2.1`.
   lite-hud M5 then pins `>= 1.2.1` and adopts the [-2^30, 2^30) key fold (RESEARCH 2.6).

### H2 rejection ledger (what was measured and NOT shipped)

- V2 -- signed `hashStr` with unwrapped callers: FAILED parity (BlockedBloom string `has` / `dump`
  changed; XorFilter string `from()` threw) -- some string-path consumers use the word non-bitwise.
- V3 -- signed returns + `>>> 0` at the caller: Node-clean (0 -> 0) but d8 still boxes (Bloom
  1 -> 11, BinaryFuse 3 -> 23 non-inlined). Node-only; superseded by the scratch / locals design.
- One shared mixer helper: 7 maps > the polymorphic limit 4; the megamorphic LoadIC re-boxes the
  double-representation `_seed` per load. Invisible to one-member-per-process lanes.
- Caller stages seeds into the scratch for a shared helper: 2 extra stores per hot body, and a
  forgotten store hashes with another instance's seed (false negatives = fail-OPEN).
- `_mixTail()` + `_HG` hand-off for the Xor/BF query: correct, but the round-trips cost; the
  query mixes as locals instead (helper deleted, no callers).
- Exact 2-product float mulhi inlined in the BinaryFuse query
  (`floor(((h>>>16)*scl + floor((h&0xffff)*scl/2^16))/2^16)`, 0 mismatches vs BigInt over 2M
  inputs): 0.71x ops/s vs 1.2.0 in the shared-process harness -- slower than the integer halves.
- XorFilter query with UNSIGNED hash locals (`>>> 0` at the mixer tail, raw `%`): parity-clean,
  d8 0 scavenges, 0.885 [0.842..0.924] -- inside the noise of the shipped form (0.856 / 0.886), so
  the approved code was not changed for it.
- Capping Quotient `MAX_NSLOTS` at 2^30 to make indices Smis: a behaviour change; the bound is
  documented instead (decisions/0027).
- Shared-process `opsps` (OLD then NEW through one `f.has` site): biased against the new code
  (BinaryFuse read 0.75 / 0.87 there vs ~1.03 isolated). Replaced by interleaved per-process pairs.

## See also

- `../CLAUDE.md` -- the suite law this scaffold obeys.
- `../LiteLru/GUIDE.md` -- the "which member do I pick" field-guide format this
  library's `GUIDE.md` will emulate.
- `../LiteLru/llms.txt` -- the honest, measured, no-overclaim voice to match.
