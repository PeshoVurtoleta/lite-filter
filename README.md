# @zakkster/lite-filter

> A zero-GC approximate-membership filter FAMILY under one `LiteFilter<K>` surface: `Bloom` (the add-only reference), `CountingBloom` (deletable, ~4x space), and `BlockedBloom` (one cache miss per query, at a higher measured FPR) ship today, with the space-optimal and mergeable members (Cuckoo, Quotient, XOR, Binary Fuse) to come -- one-line swappable, tree-shakeable to a single filter, with a shipped bench that measures ACTUAL vs THEORETICAL false-positive rate on your own keys instead of trusting a formula.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-filter.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-filter)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-filter?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-filter)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-filter?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-filter)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-filter?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-filter)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The membership filter the ecosystem was missing

You want to answer "have I seen this key?" -- dedup, set membership, cache admission, "is this id probably in the set?" -- and a JS `Set` is the obvious tool. But a `Set` stores every key by value or reference, allocates per entry, resizes by copying, and costs tens of bytes per key plus GC pressure. A probabilistic filter answers the SAME membership question in a handful of **bits** per entry, at fixed preallocated memory with **no per-op allocation**, a small bounded tunable false-positive rate, and **zero false negatives**.

And choosing the right probabilistic structure is a real, hard-to-navigate decision with no universal winner -- Bloom is the baseline but cannot delete and is not the smallest; Cuckoo and Counting Bloom delete but cost more; XOR and Binary Fuse are near the space lower bound but are static. `lite-filter` puts that whole family behind ONE identical interface (a one-line constructor swap) plus **the bench that tells you which one to pick**: measured FPR vs theoretical, bits/item, add/query ns, on YOUR keys.

```bash
npm install @zakkster/lite-filter
```

```js
import { Bloom } from '@zakkster/lite-filter';

const seen = new Bloom(100000, { fpp: 0.01 });   // sized for 100k items at a 1% target

seen.add('user:42');
seen.add('user:99');

seen.mightContain('user:42');   // true  -- always (added keys never read false)
seen.mightContain('user:7');    // false -- (or, ~1% of the time, a false positive)
seen.has('user:99');            // true  -- has() is the alias of mightContain
seen.size;                      // 2     -- adds recorded
seen.fpp();                     // the fill-derived FPR estimate (a formula, not a measurement)
```

One `LiteFilter<K>` surface, `add`/`mightContain`/`has`/`size`/`capacity`/`fpp`/`clear`, zero allocation on every hot path after construction. Integer keys opt into a strict-zero-alloc backing. `Bloom`, `CountingBloom`, and `BlockedBloom` are shipped named exports today; the remaining members (Cuckoo, Quotient, XOR, Binary Fuse) ship as further named exports (`sideEffects: false` drops whichever you do not import).

Then measure, do not guess:

```bash
npm run bench     # measured vs theoretical FPR (% over), bits/item, add/query ns, per workload
```

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The Bloom filter, in brief](#the-bloom-filter-in-brief)
- [The members](#the-members)
  - [CountingBloom -- the deletable member](#the-members)
  - [BlockedBloom -- the cache-local member](#the-members)
- [API reference](#api-reference)
  - [Construction](#construction)
  - [The surface](#the-surface)
  - [Integer keys -- strict zero-alloc](#integer-keys----strict-zero-alloc)
  - [Stats -- opt-in runtime counters](#stats----opt-in-runtime-counters)
  - [Snapshot -- dump / restore](#snapshot----dump--restore)
  - [The bench tool](#the-bench-tool)
  - [Constants](#constants)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

Every membership question in JS defaults to `Set`, and `Set` is exact -- which is
exactly the problem when you do not need exactness. A dedup over a stream of a
billion ids, a "have I crawled this URL", a cache admission gate keeping one-hit
wonders out -- none of these need to store the keys, only to answer "probably yes /
definitely no". Storing the keys is the cost you are trying to avoid.

A Bloom filter answers that in `~1.44 * log2(1/fpp)` bits per item -- about 9.6 bits
(1.2 bytes) per item at a 1% false-positive rate, versus tens of bytes per key for a
`Set`, and with no per-op allocation and no GC churn. The tradeoff is a bounded,
tunable rate of false POSITIVES; there are never false negatives.

The reason this is a FAMILY and not one filter: the right structure depends on your
axes (target fpp, space, delete support, static-vs-incremental, query speed,
mergeability), and there is no universal winner. `lite-filter` grows one member per
release under one surface, and ships the bench so you measure the tradeoff on your
own keys rather than copying a number from a paper.

## What you get

- **One uniform surface.** `add` / `mightContain` / `has` / `size` / `count` /
  `capacity` / `fpp` / `clear`, identical across every present and future member.
- **Zero-GC hot path.** One preallocated `Uint32Array`, sized once, reused forever.
  `add` and `mightContain` allocate nothing on the `keys:'int'` and string paths.
- **Fail-closed everywhere.** Impossible sizing, a bad int key, a `remove` on an
  add-only member, or a corrupt snapshot all throw a `[lite-filter]`-tagged Error.
- **The honesty bench.** Measured vs theoretical FPR as `% over theoretical`,
  checked against a real `Set` oracle, over four seeded workloads.
- **Snapshot round-trip.** `dump()` / `restore()` -- the typed array IS the serial
  form; structurally-cloneable and JSON-safe; fail-closed on any mismatch.
- **Types + tree-shaking.** `Filter.d.ts` types `LiteFilter<K>`; `sideEffects: false`.

## The Bloom filter, in brief

<details>
<summary>How the reference member works (and its one-sided guarantee)</summary>

A Bloom filter is one bit array of `m` bits plus `k` hash functions. To `add` a key,
compute `k` positions and set those `k` bits. To query, compute the same `k`
positions and return `true` only if ALL `k` bits are set.

- If a key was added, its `k` bits are set, so `mightContain` returns `true` --
  **always**. There are **no false negatives**.
- If a key was never added, its `k` bits might still all happen to be set by OTHER
  keys -- a **false positive**, whose probability is bounded by the configured
  `fpp` and rises as the filter fills.

`lite-filter` derives `m` and `k` from your `(capacity, fpp)`:

    m = ceil(-n * ln(fpp) / ln(2)^2)      bits
    k = round((m / n) * ln(2))            hash positions (clamped >= 1)

All `k` positions come from just TWO base hashes via enhanced double hashing
(`pos_i = (h1 + i*h2) mod m`), so a probe needs zero scratch storage. Bloom cannot
delete -- clearing a key's bits would corrupt every other key sharing one of them --
so `remove()` throws (use `CountingBloom` when you need deletes).

</details>

## The members

| Member | Deletes? | Space | Status | Import |
| --- | --- | --- | --- | --- |
| `Bloom` | no (`remove` throws) | 1x (`~1.44 log2(1/fpp)` bits/item) | SHIPPED (v0.1.0) | `import { Bloom } from '@zakkster/lite-filter'` |
| `CountingBloom` | **yes** (`remove -> boolean`) | ~4x Bloom (4-bit counters) | SHIPPED (v0.2.0) | `import { CountingBloom } from '@zakkster/lite-filter'` |
| `BlockedBloom` | no (`remove` throws) | 1x Bloom (one 512-bit cache line per key) | SHIPPED (v0.3.0) | `import { BlockedBloom } from '@zakkster/lite-filter'` |

All three implement the same `LiteFilter<K>` surface, so a member is a one-line
constructor swap; the only surface difference is `remove` (member-specific).

<details>
<summary>CountingBloom -- the deletable member (and its two honest caveats)</summary>

`CountingBloom` replaces Bloom's single bit per position with a 4-bit SATURATING
counter (two packed per byte, one `Uint8Array`). `add` increments the `k` counters,
`remove` decrements them, and `mightContain` is `true` iff every probed counter is
nonzero. This buys a real `remove(key): boolean` at ~4x a plain Bloom's space. Its
false-positive rate tracks the SAME formula as Bloom (the bench confirms the measured
`% over theoretical` matches Bloom's across all four workloads).

```js
import { CountingBloom } from '@zakkster/lite-filter';

const f = new CountingBloom(100000, { fpp: 0.01, keys: 'int' });
f.add(42);
f.remove(42);            // true  -- a real delete; returns false if the key is absent
f.mightContain(42);      // false -- gone
```

`remove` runs **two passes** with no scratch storage: pass 1 verifies every probed
counter is nonzero (else it returns `false` and mutates NOTHING), pass 2 decrements
each counter in `1..14`. Two caveats are inherent to a Counting Bloom and stated, not
hidden:

- **Only remove keys you actually added.** If a never-added key is a false positive
  (all `k` counters nonzero via other keys), `remove` will decrement REAL keys and can
  cause a later **false negative** (decisions/0009).
- **A saturated counter (15) is clamped forever** -- never incremented past 15, never
  decremented (decisions/0008) -- so a key routed only through saturated counters can
  stick present after removal. At a 1% fpp this is negligibly rare. The multiplicity
  readout is deferred (decisions/0010) because saturation makes it an over-estimate.

</details>

<details>
<summary>BlockedBloom -- the cache-local member (one cache miss per query, at a higher FPR)</summary>

`BlockedBloom` partitions the bit array into fixed 512-bit BLOCKS -- 16 x 32-bit words
= 64 bytes, one cache line (decisions/0012). Every key is routed to ONE block (from its
first base hash), and all `k` bits live inside that block. So a `mightContain` touches
ONE cache line regardless of `k` -- the throughput win. It is add-only like Bloom:
`remove()` throws.

```js
import { BlockedBloom } from '@zakkster/lite-filter';

const f = new BlockedBloom(100000, { fpp: 0.01, keys: 'int' });
f.add(42);
f.mightContain(42);      // true -- one cache line touched, regardless of k
```

The caveat is inherent and MEASURED, never hidden (decisions/0013): confining a key to
one block loses the cross-block independence the textbook formula assumes, so the
MEASURED false-positive rate runs OVER a plain Bloom's for the SAME bits/item. `fpp()`
reports the plain closed-form as a labeled FLOOR, not a prediction. `npm run bench`
prints Bloom vs BlockedBloom side by side so the trade is the first thing you see: on
this repo's uniform int workload, BlockedBloom query ns is LOWER than Bloom's while its
measured FPR is HIGHER (e.g. ~0.014 vs ~0.010 at the same ~9.6 bits/item). To hit a
target measured FPR, raise the configured `fpp` slightly -- never trust the floor as the
delivered rate.

</details>

## API reference

### Construction

```ts
new Bloom(capacity: number, options?: {
  fpp?: number;      // target false-positive probability in (0, 1). Default 0.01.
  seed?: number;     // hash seed (32-bit-coercible). Default is a fixed constant.
  keys?: 'int';      // opt into the strict-zero-alloc 32-bit-integer backing.
  stats?: boolean;   // mint the per-instance stats holder. OFF by default.
})
```

Fail-closed doors (all throw a `[lite-filter]`-tagged Error): `capacity` non-integer
or `< 1`; `fpp` not in the open interval `(0, 1)` (so `<= 0` and `>= 1` both throw);
a bit count that would overflow a safe typed-array length; an unknown `keys` or
`stats` value (with a did-you-mean hint).

### The surface

| Method | Returns | Notes |
| --- | --- | --- |
| `add(key)` | `void` | Record a key. Zero-alloc on int + string keys. |
| `mightContain(key)` | `boolean` | The query. NO false negatives; false positives bounded by `fpp`. |
| `has(key)` | `boolean` | The sole alias of `mightContain`, same semantics. |
| `remove(key)` | `never` / `boolean` | **Bloom** + **BlockedBloom**: add-only, **throw** `[lite-filter]`. **CountingBloom**: a real delete, returns `boolean` (member-specific). |
| `size` / `count` | `number` | Adds recorded (a plain counter, not a distinct-key count). |
| `capacity` | `number` | The item count the filter was sized for. |
| `fpp()` | `number` | Configured target while empty, else the fill-derived estimate. |
| `clear()` | `void` | Reset to empty. Allocates nothing (zeroes the store in place). |
| `stats()` / `resetStats()` | -- | Require `{ stats: true }`; fail closed otherwise. |
| `dump()` | snapshot | Serialize. Cold; may allocate. |
| `Bloom.restore(snap, opts?)` | `Bloom` | Static. Rebuild; fail closed on any mismatch. |

### Integer keys -- strict zero-alloc

```js
const f = new Bloom(1_000_000, { fpp: 0.001, keys: 'int' });
f.add(42);                 // mixed directly -- no string encoding, no allocation
f.mightContain(42);        // true
f.add(2 ** 31);            // throws [lite-filter]: keys:'int' requires a 32-bit signed integer
```

`keys: 'int'` restricts keys to 32-bit signed integers (`-2147483648 .. 2147483647`)
and takes an integer-mix hash path that never encodes a string -- the mode the perf
gate proves is 0 B/op. String keys on the default backing are also alloc-free (they
hash over their code units); only a non-string, non-int key pays a `String()` encode.

### Stats -- opt-in runtime counters

```js
const f = new Bloom(1000, { stats: true });
f.add('a'); f.mightContain('a'); f.mightContain('z');
f.stats();       // { adds: 1, queries: 2, hits: 1, misses: 1 }  (BY REFERENCE)
f.resetStats();  // zeroes the same holder in place
```

OFF by default: with no `{ stats: true }`, `_stats === null` and the hot path writes
nothing. `stats()` / `resetStats()` on a non-stats instance throw (null is not zero).

### Snapshot -- dump / restore

```js
const snap = f.dump();                 // plain, structuredClone- and JSON-safe
const json = JSON.stringify(snap);     // persist to disk / IPC / a worker
const g = Bloom.restore(JSON.parse(json));   // bit-identical membership
```

The `Uint32Array` store IS the serial form. `restore()` re-derives `(m, k)` from the
recorded `(cap, fpp)` and REJECTS -- never truncates -- on any tag, member, capacity,
fpp, seed, bit-count, or count mismatch.

### The bench tool

```js
import { runBench } from '@zakkster/lite-filter/benchmark/Bench.mjs';
const rows = runBench({ cap: 100000, fpp: 0.01 });
// each row: { name, bitsPerItem, k, measuredFpr, theoretical, overPct, addNs, queryNs, falseNeg }
```

### Constants

| Export | Meaning |
| --- | --- |
| `VERSION` | the package version string (`"0.3.0"`) |
| `Bloom` | the reference member (also the default export) |
| `CountingBloom` | the deletable member (4-bit saturating counters; a real `remove`) |
| `BlockedBloom` | the cache-local member (one 512-bit block per key; one cache miss per query, at a higher measured FPR) |

## Composability

Approximate membership is machinery that lives INSIDE bigger systems. A cache
admission gate that keeps one-hit-wonders out of an LRU is a canonical pairing:

```js
import { Bloom } from '@zakkster/lite-filter';
import { LiteLru } from '@zakkster/lite-lru';

const cache = new LiteLru(10000);
const seen = new Bloom(1_000_000, { fpp: 0.01 });

function admit(key, load) {
  // Only cache a key we have seen at least once before -- one-hit wonders never
  // pollute the cache, and the filter costs ~1.2 bytes/key instead of a second Set.
  if (seen.mightContain(key)) {
    let v = cache.get(key);
    if (v === undefined) { v = load(key); cache.put(key, v); }
    return v;
  }
  seen.add(key);           // first sighting: record it, but skip the cache this time
  return load(key);
}
```

Pairs equally with `@zakkster/lite-binary-reader` -- build a filter over record ids
parsed straight out of a foreign binary buffer, with no intermediate `Set`.

## Zero-GC design notes

<details>
<summary>Allocation table + the two-hash trick</summary>

| Operation | Allocation (keys:'int') | Allocation (string) | Allocation (arbitrary) |
| --- | --- | --- | --- |
| `add` | 0 B | 0 B | 1 `String()` (amortized) |
| `mightContain` / `has` | 0 B | 0 B | 1 `String()` (amortized) |
| `clear` | 0 B (same ArrayBuffer) | 0 B | 0 B |
| `fpp` / `size` / `stats` | 0 B | 0 B | 0 B |
| `dump` | O(words) -- cold, allowed | -- | -- |

- **One preallocated `Uint32Array`** of `ceil(m/32)` words, sized once from
  `(n, fpp)`, never grown, never reallocated. `clear()` zeroes it in place -- the
  ArrayBuffer identity is preserved (proven by the torture gate).
- **Enhanced double hashing** (Kirsch & Mitzenmacher, 2006): all `k` probe positions
  come from two base hashes, `pos_i = (h1 + i*h2) mod m`, so a probe needs no
  `k`-length array -- zero scratch storage, two real hashes per op.
- **`Math.imul` throughout** the murmur3 `fmix32` mixer -- exact 32-bit multiplies,
  never a boxed heap double.
- **Opt-in stats guard** (`_stats === null`) is the ONLY extra hot-path branch, and
  it is free when stats are off.

Gated numbers (this repo, `npm run test:perf` + `npm run torture`): add + mightContain
on `keys:'int'` = **0 B/op**, **maxMajor 0**; 1e6 adds then requery = **0 false
negatives**; n=1e5, fpp=0.01, 1e6 disjoint probes = measured FPR **<= 0.0125**
(<= 25% over the formula). CountingBloom `add` / `mightContain` / `remove` on
`keys:'int'` are also **0 scavenges** at N and 8N (nibble read/modify/write, no scratch
array), and 1e5 mixed add/remove ops = **0 false negatives** for present keys.
BlockedBloom `add` / `mightContain` on `keys:'int'` are **0 scavenges** at N and 8N too
(one block, odd-stride within-block walk, no scratch), with a measured FPR within its
honest ceiling (**<= 0.0175**) that is PROVEN to run OVER the plain-Bloom theory
(decisions/0013). ns/op figures are machine-local -- run `npm run bench`.

</details>

## Design decisions worth knowing

- **The hash is load-bearing, and validated by the bench, not reputation**
  (decisions/0001). murmur3 `fmix32` + a direct integer mix + an alloc-free string
  hash; hash quality is what keeps measured FPR near theory, so it is a gated number.
- **`(n, fpp)` is the sizing surface** (decisions/0002); explicit `(bits, k)` is not
  offered in v0.1.0. Every impossible request fails closed at the door.
- **Bloom is add-only, loudly** (decisions/0003). `remove()` throws rather than
  silently corrupting other keys. `count` is an add-call counter, not distinct keys.
- **`fpp()` is an estimate, labeled as one** (decisions/0004). Measure your own keys.
- **The snapshot rejects, never truncates** (decisions/0005). A corrupt or foreign
  snapshot is an error, not a silently-wrong filter.
- **The static-build API is deferred** (decisions/0006) to the first static member.
- **CountingBloom counters are 4-bit nibbles, two per byte** (decisions/0007) -- ~4x
  Bloom's space for a real `remove`, chosen over 8-bit for space at a 1% fpp.
- **Counters saturate at 15, never wrap** (decisions/0008). A wrap would turn a present
  key into a false negative; clamping keeps reads correct, at the cost that a saturated
  counter never decrements.
- **`remove` is two-pass and fail-closed** (decisions/0009): verify-then-decrement,
  no mutation on a partial match. Removing a never-added key can corrupt other keys --
  only remove keys you added.
- **The multiplicity readout is deferred** (decisions/0010): saturation + collisions
  make "how many times added?" an over-estimate, so it is not shipped un-characterized.
- **CountingBloom's snapshot is the same envelope with per-byte validation**
  (decisions/0011): `mem:"CountingBloom"`, `w:4`, `cnts` bytes each validated `0..255`
  (so every nibble is `0..15`) before any instance is built.
- **BlockedBloom pins a 512-bit block, not configurable** (decisions/0012): one 64-byte
  cache line per key, store `nb*16` words, block from the first hash + within-block bits
  via an odd stride; snapshot records `bb:512` + `nb`.
- **BlockedBloom's FPR penalty is exposed, not compensated** (decisions/0013): `m` is
  NOT upsized to hide it. `fpp()` reports the plain-Bloom form as a FLOOR the measured
  rate runs OVER, and the bench prints Bloom vs BlockedBloom side by side. No "same fpp
  for free" claim.

## Testing

`node:test` only, zero runtime deps. The gates (`npm run verify` runs all of them):

- `npm test` -- the boundary suite: every method, every one-sided law, every
  fail-closed door, plus an ASCII-source guard.
- `npm run test:types` -- `tsc --noEmit` proves `Bloom`, `CountingBloom`, and
  `BlockedBloom` satisfy `LiteFilter<K>`, that `CountingBloom.remove` is a real
  `boolean`, and that `Bloom`/`BlockedBloom` `remove` is `never`.
- `npm run torture` -- `node --expose-gc`: the leak tracker (retention returns to 0)
  + the GC profiler (maxMajor 0) + the Set-differential oracle (no false negatives,
  bounded FPR) + a CountingBloom add/remove churn oracle + a BlockedBloom oracle (0
  false negatives; measured FPR within its honest ceiling AND proven OVER plain-Bloom
  theory) + the `clear()` ArrayBuffer-identity check for all three members.
- `npm run torture:controls` -- the must-fail proof: a broken build MUST fail.
- `npm run test:perf` -- the `@zakkster/lite-perf-gate` zero-alloc scenarios on
  `keys:'int'` (Bloom add-churn + query-hit; CountingBloom add-churn + query-hit +
  remove-churn; BlockedBloom add-churn + query-hit), with an allocating mustFail for teeth.
- `npm run bench` -- the measurement tool.

## What this is not

- **Not cryptographic.** Fingerprints are not MACs; do not use it for security.
- **Not an exact set.** It answers "probably yes / definitely no". Use `Set` when you
  need certainty on the positive side.
- **Not a key-value store.** It stores membership, never values.

## Ecosystem

Part of the `@zakkster/*` suite of zero-GC, single-file micro-libraries. Pairs with
[`@zakkster/lite-lru`](https://www.npmjs.com/package/@zakkster/lite-lru) (a filter is
a natural cache-admission gate) and
[`@zakkster/lite-binary-reader`](https://www.npmjs.com/package/@zakkster/lite-binary-reader)
(build a filter over ids parsed from a binary buffer). Same laws, same voice.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
