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

## See also

- `../CLAUDE.md` -- the suite law this scaffold obeys.
- `../LiteLru/GUIDE.md` -- the "which member do I pick" field-guide format this
  library's `GUIDE.md` will emulate.
- `../LiteLru/llms.txt` -- the honest, measured, no-overclaim voice to match.
