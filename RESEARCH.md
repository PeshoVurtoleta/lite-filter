# lite-filter -- research notes

ASCII-only. MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>. The design charter is ROADMAP.md
sections 1-11 and `decisions/0001..0023`; this file records post-ship evaluations.

## 1. The 2026-09-23 zero-GC audit (post-ship, v1.1.0)

Read-only adversarial audit (no repo files modified; probes in a scratchpad). Claim under test: "zero
runtime deps, zero-GC, no allocation on any hot path, fully developed, fail closed" for every exported
member. It carried the lessons from the lite-sketch and lite-hud M2 audits: measureAllocs cannot see
transient allocation (so a scaling scavenge lane is required), integer inputs hide boxing (so
fractional and large keys are driven too), and tolerated scavenge floors must be justified by
measurement. Plan: ROADMAP.md section 12 (H1, 1.2.0).

### 1.1 Inventory
- 1.1.0 (commit af08da4); `sideEffects:false`; zero runtime deps. devDeps: lite-gc-profiler ^1.16.0,
  lite-leak ^1.10.0, lite-perf-gate ^1.4.2, lite-signal ^1.5.1, typescript ^7.0.2.
- Exports (Filter.js): VERSION (104), Bloom (1220), CountingBloom (1528), BlockedBloom (1869),
  Cuckoo (2194), Quotient (2641), XorFilter (3311), BinaryFuse (3673), default = Bloom (4020).
- Version trinity in sync (Filter.js:104 == package.json == llms.txt:21).
- 20 test files, 497 tests (matches README:701); torture, controls, perf, types, oracle; 23 ADRs.
- Pack: 8 files, 96 kB (Filter.js, Filter.d.ts, benchmark/Bench.mjs, llms.txt, README.md,
  CHANGELOG.md, LICENSE, package.json); demo/test/decisions/ROADMAP absent. ASCII-clean, author and
  license correct, no stray tags.

### 1.2 Gate results at audit time
```
UNIT      497 pass / 0 fail
TORTURE   ok  GATE alloc=0 B/op | gc major=0 minor=1 maxMs=0.83 | strFn=0
          oracle fn=0 fpr=0.00976 target=0.01000 over=-2.4%
          cbf fn=0 churn fn=0 | bb fn=0 fpr=0.01413 ceiling=0.01750 floor=0.01150 (two-sided)
          cf fn=0 fpr=0.00584 ceiling=0.00900 overload+noop ok | qf fn=0 fpr=0.00587 ceiling=0.00900
          xf fn=0 fpr=0.00386 ceiling=0.00500 | bf fn=0 fpr=0.00396 ceiling=0.00500 bits/item=9.044
CONTROLS  ok -- BREAK (gc.major 2), LEAK (1 retained), SABOTAGE (1000 false negatives), each
          matched on its own stderr reason
PERF      22 pass / 0 fail; zgcSuite N=200000 k=8 maxScavenges=0 (a TRUE zero floor), maxOldGen=0,
          maxArrayBuffersKB=0; mustFail (Bloom object-key churn) caught
```

### 1.3 Allocation (scaling probe, --max-semi-space-size=4, heap delta per 500k ops)
| Lane | Delta | Note |
|---|---|---|
| baseline no-op | ~-1 KB | -- |
| Bloom int, positive smi | ~0 KB | none |
| Bloom int, negative int32 | ~6 KB (noise) | none -- the lite-hud M5 lane |
| Cuckoo int | ~249 KB | store growth, not per-op |
| Bloom default, number smi | ~602 KB | String() encode (documented amortized caveat) |
| Bloom default, number fractional | ~3068 KB | String() encode (documented) |
Int hot bodies use only int32 arithmetic (fmix32, Math.imul, mulhiU32), preallocated typed stores,
unrolled b=4 scans; the Cuckoo kick uses one scalar victim register + a preallocated `_kickPath`;
the Quotient delete rebuild uses preallocated scratch. merge/resize allocate (cold, documented).

### 1.4 Fail closed
In int mode, `add(NaN | +-Infinity | 1.5 | "5" | 5n | Symbol | null | undefined)` all throw, and
nothing is silently truncated. `-0` is accepted as 0; INT_MIN / INT_MAX are accepted; out of range
throws. An empty query returns false. `XorFilter.from([] | null)` and `new XorFilter()` throw.
Snapshot restore validates every word before mutating, cross-checks derived sizing, and uses a
family-wide `chk` checksum over provenance, so a flipped keys-mode or seed fails closed.

### 1.5 Findings
| ID | Sev | Finding | Evidence |
|---|---|---|---|
| N1 | S2 | `keys:'int'` = signed int32 only; values in [2^31, 2^32) THROW. A `>>> 0` signature fold throws on the hot path. | Signed fold `((sid<<20)|(op<<12)|code)|0` = 943747476 -> ok, zero growth; the same fold `>>> 0` -> THREW `[lite-filter] keys:'int' requires a 32-bit signed integer`. |
| N2 | S3 | No keys-mode / seed getter; detecting the mode means catching an error or reading `_int` (`dump().keys` needs a full serialize). | Filter.d.ts:141-201: size, count, capacity, fpp() only. |
| N3 | S3 | `size` can exceed `capacity`; there is no real-ceiling / saturation getter; the overload error text advises "size vs capacity". | Cuckoo(64) accepted 127, Quotient(64) accepted 115. |
| N4 | S3 | Gated lanes cover positive int + pre-interned strings only; negative int32 (the M5 lane) is ungated (measured 0). | torture.mjs:243 `i & MASK`; PerfGate.test.mjs:355-357. |
| N5 | S3 | The default backing allocates for number keys (String() encode) -- documented, logged for completeness. | Table 1.3. |
| N6 | nit | demo/Demo.test.mjs not run by `npm test`; dead `_hashKey` on XorFilter / BinaryFuse. | package.json:29; Filter.js:3471, 3844. |

### 1.6 Consumer view (lite-hud M5)
`Bloom({ keys: 'int' })` for first-seen error signatures is SAFE on the hot path: it does not allocate
or box on any int32, negatives included. [CORRECTED 2026-10-05: true with inlining ON only. With
inlining OFF every member boxes on the int path, and BinaryFuse boxes inlined too -- section 2.] The consumer MUST fold `(sid, op, code)` to a SIGNED int32
(`| 0`), never `>>> 0`. It would benefit from N2 (detect keys:'int' without sniffing) and N3 (a real
headroom getter) before the M5 rework.

## 2. The 2026-10-05 no-inline boxing finding (lite-hud M5 step-0 probe, v1.2.0)

Found by lite-hud's M5 peer probe, which gates every peer under `--max-inlined-bytecode-size=0`
(the M2 lesson, lite-hud RESEARCH 13: a consumer's hot path is the non-inlined case). The H1 audit
(section 1) measured with inlining on, so it missed this. Plan: ROADMAP.md section 13 (H2, 1.2.1). Section 2.6 shows the V3 fix below is Node-only.

### 2.1 Method
Scavenge count at N = 200k vs 8N under `--min-semi-space-size=4 --max-semi-space-size=4`, one
process per lane. Keys come from an Int32Array spread over the whole int32 range
(`Math.imul(i + 1, 2654435761) | 0`). Mutable members insert 2048 and probe 4096 (half hits, half
misses); Bloom-family lanes run `if (!has(k)) add(k)`. Controls: a no-op lane reads 0 -> 0, and one
object per op reads 1 -> 12.

### 2.2 Result (scavenges, N -> 8N)
| Member | 1.2.0 inline | 1.2.0 no-inline | prototype inline | prototype no-inline |
|---|---|---|---|---|
| Bloom | 0 -> 0 | 1 -> 6 | 0 -> 0 | 0 -> 0 |
| CountingBloom | 0 -> 0 | 1 -> 6 | 0 -> 0 | 0 -> 0 |
| BlockedBloom | 0 -> 0 | 1 -> 6 | 0 -> 0 | 0 -> 0 |
| Cuckoo | 0 -> 0 | 1 -> 9 | 0 -> 0 | 0 -> 0 |
| Quotient | 0 -> 0 | 0 -> 3 | 0 -> 0 | 0 -> 0 |
| XorFilter | 0 -> 0 | 2 -> 12 | 0 -> 0 | 0 -> 0 |
| BinaryFuse | **0 -> 3** | 1 -> 12 | 0 -> 0 | 0 -> 0 |

### 2.3 Cause
Half of all 32-bit hashes are >= 2^31. As `>>> 0` values they are not Smis, so they box when
returned from, or passed to, a function that is not inlined:
- `fmix32` returns `h >>> 0` (Filter.js:492). Bloom's `has` calls it twice per op.
- `hashStr` returns `fmix32(h)`.
- Quotient's `_hash` returns it.
- BinaryFuse passes the unsigned `h` into `mulhiU32(h, scl)`.
Same class as lite-hud's `hashKey` (fixed in 2.3.0 by returning `| 0`) and lite-sketch HLL F1.

### 2.4 Prototype and the variant that failed
- V1: make `fmix32` signed and wrap every call site `(fmix32(...) >>> 0)`. This fixed Bloom,
  CountingBloom, BlockedBloom, Cuckoo and XorFilter. Quotient and BinaryFuse still read 0 -> 3,
  because unsigned values were still crossing at `_hash` and `mulhiU32`.
- V2: V1 plus a signed Quotient `_hash`, `mulhiU32(h | 0, scl)` and a signed `hashStr` with
  unwrapped callers. It read 0 -> 0 everywhere but FAILED parity: BlockedBloom string `has` /
  `dump` differed, and XorFilter string `from()` threw. Some string-path sites consume the hash
  non-bitwise.
- V3: V2, but with `hashStr` callers wrapped `(hashStr(...) >>> 0)` (byte-identical by
  construction). Results:
  - 0 -> 0 on all members, inline and no-inline.
  - Parity: 160,308 checks / 0 differences vs 1.2.0 (members x {int, string} x 4 seeds; add,
    remove, has, getters and dump bytes).
  - The repo suite on V3: 516/516, torture ok with identical FPR figures, perf 30/30.
- The existing perf gate also passes on 1.2.0, so it cannot see this. The new no-inline lane is
  what has teeth.

### 2.5 Consumer view (lite-hud M5)
lite-hud M5 requires lite-filter >= 1.2.1 for its no-inline lane. Until then, Bloom costs about one
16 B box per lookup in a non-inlined consumer. The signed-fold requirement (1.5 N1) is unchanged.

### 2.6 The 31-bit-Smi lane (d8, 2026-10-05) -- V3 is Node-only
Node here is built without pointer compression (`process.config.variables.
v8_enable_pointer_compression === 0`), so it has 32-bit Smis. Chrome has pointer compression and
31-bit Smis: a signed int32 outside [-2^30, 2^30) still boxes at a non-inlined boundary. Hash outputs
are uniform over 32 bits whatever the key, so V3's signed returns leave half of them boxing there.

Engine: official V8 d8 15.7.37 (mac-arm64, chromium-v8 canary storage), unpacked to
`~/.jsvu/engines/v8/d8`. Verified 31-bit: `%IsSmi(2**30 - 1)` true, `%IsSmi(2**30)` false. Probe:
`research/h2-proto/probe-d8.mjs` + `run-d8.mjs`, the same lanes as 2.1. With full-int32 keys even the
`nop` control reads 0 -> 2 on d8 (the probe itself boxes keys >= 2^30), so the lane uses
`KS=smi31` keys (`>> 1`, all Smis): `nop` then reads 0 -> 0 and every scavenge is the library's.

| Member (d8, smi31 keys) | 1.2.0 inline | 1.2.0 no-inline | V3 inline | V3 no-inline |
|---|---|---|---|---|
| nop | 0 -> 0 | 0 -> 0 | 0 -> 0 | 0 -> 0 |
| Bloom | 0 -> 0 | 2 -> 14 | 0 -> 0 | 1 -> 11 |
| CountingBloom | 0 -> 0 | 2 -> 14 | 0 -> 0 | 1 -> 11 |
| BlockedBloom | 0 -> 0 | 2 -> 14 | 0 -> 0 | 1 -> 11 |
| Cuckoo | 0 -> 0 | 2 -> 19 | 0 -> 0 | 2 -> 16 |
| Quotient | 0 -> 0 | 1 -> 8 | 0 -> 0 | 1 -> 7 |
| XorFilter | 0 -> 0 | 3 -> 25 | 0 -> 0 | 3 -> 20 |
| BinaryFuse | 0 -> 0 | 3 -> 25 | 0 -> 0 | 3 -> 23 |

Spike (`research/h2-proto/mk-v4.mjs`, Bloom only): V3 plus `mixPair(this, key)`, which runs the
fmix32 body in its own frame, reads `_seed` / `_seed2` there and writes both words to a module
`Int32Array`; the caller reads them back locally. Bloom reads 0 -> 0 on d8 no-inline AND on Node
no-inline; int parity vs 1.2.0 is 0 differences across 4 seeds (add, 50k has, dump). This is the
design H2 adopts (ROADMAP 13, SETTLED: Smi-width-proof).

Consumer view (lite-hud M5), superseding 1.6 / 2.5 on this point: on 31-bit-Smi engines a key
outside [-2^30, 2^30) boxes at the consumer's own `has(k)` call, before lite-filter runs. A
Chrome-clean consumer folds to a 31-bit signed key, e.g. `(x << 1) >> 1`, not just `| 0` (a lossy
fold -- x and x ^ 0x80000000 collide -- so it only adds false positives, never a false negative). The same
applies to lite-hud's own `hashKey` (`| 0` return, 2.3.0): it is Node-clean only, unless inlined.

### 2.7 H2 outcome (what shipped, 2026-10-05)

Shipped design (decisions/0027), beyond V3/V4: PER-CLASS `_mixInt` methods (the fmix32 body in the
member's own frame, seeds read in-frame, words handed to the caller via a module `Int32Array`
`_HG`), a field-free `_ckAlt` (Cuckoo alt bucket) and `mulhiU32(ah, al, b)` (16-bit Smi halves).
The STATIC members (XorFilter, BinaryFuse) INLINE all four fmix32 bodies as locals at their single
query site -- THE RULE's "one frame" clause -- which is both compliant and faster than the `_HG`
hop (`_mixTail`, the V4 helper, ended with no callers and was deleted). Result: 0 scavenges / 1.6M
ops for every member, inline AND no-inline, on Node (32-bit Smis) AND V8 d8 (31-bit Smis). Xor/BF
BUILD stays on plain `fmix32` (cold). Interleaved per-process int-`has` ops/s vs 1.2.0 (median of
K pairs, `research/h2-proto/opsps.mjs`), measured on a quiet machine:
K=7 pairs per member, best-of-5 per child, N=30M ops/trial, Node 26.8.2, 2026-10-05.
Ratio of medians [per-pair min..max]: Bloom 0.972 [0.924..1.041], CountingBloom 0.970
[0.860..0.994], BlockedBloom 0.992 [0.961..1.028], Cuckoo 0.919 [0.895..0.934], Quotient 0.931
[0.923..0.939], XorFilter 0.856 [0.838..0.973] (a second, independent K=7 run: 0.886 [0.841..0.970]), BinaryFuse 1.037 [1.020..1.058].
Cuckoo and Quotient are consistently slower (every pair below 1.0) but within the 10% budget.
XorFilter is the one member over it (ROADMAP 13 written justification): its query is unchanged
arithmetic -- the same four mixes and three `%` reductions -- with the hash words now signed
locals read as `>>> 0` at the `%`, instead of unsigned returns from inlined `fmix32` calls; the
gap is code generation, not extra work (~10 ns per query, 16.0 -> 13.7 Mops/s). A variant that
keeps the locals unsigned read 0.885 [0.842..0.924] (parity-clean, d8 0 scavenges): inside the
noise of the shipped form, so it was not adopted. The trade is accepted for the zero-box int path
on both engines, which is the point of 1.2.1; BinaryFuse, the family's recommended static filter,
is ~10x faster than XorFilter and reads 1.037.

Gate-teeth lessons from the reviewer's two REJECT rounds (each a gate that looked green but proved
nothing):

- **Kick lane never kicked.** The first Cuckoo "kick" lane filled to `0.85 * capacity`, but the
  real ceiling is `maxLoad = nb*b` (= 2x capacity), so the table was 42% full and `remove(k); add(k)`
  refilled the freed slot without ever displacing (`_rng` never moved). Fix: fill to `0.93 * maxLoad`
  and slide a live window of fresh keys over a ring pool; COUNT `_rng` changes (via its low 30 bits,
  so the counter itself stays a Smi and never boxes) and fail closed if the count is 0.
- **Add lane stopped adding.** `if (!has(k)) add(k)` stops adding after the 4096 distinct probe keys
  are present, so `add` was never in the measured window. Fix: an every-op `add(keys[i & 4095])`
  lane (add-only members just re-set bits / saturate counters).
- **Re-entrancy test had no teeth.** The inner filter was a string-keyed Bloom that never wrote
  `_HG`, so the test could not have caught a corruption. Fix: an int-keyed Cuckoo inner (writes
  `_HG[0..2]`) plus a MUST-FAIL control that injects `has()` into the forbidden window between the
  outer `_hash`'s `_HG` write and its read, asserting the result then DIFFERS.
- **Shared-process ops/s bias.** Running OLD then NEW through one shared `f.has` call site across 4
  classes x 2 modes made the site megamorphic and understated the rewrite. Two numbers, labelled:
  the `_mixTail`/`_HG` version (before the static-member locals inline) read BinaryFuse ~0.75 in that
  shared harness; the SHIPPED code (locals inline) read ~0.87 in the same shared harness. Isolating
  one child process per (member, module) removed the bias and BinaryFuse measured ~1.02x. Final
  figures are the interleaved-median opsps on a quiet machine (the 2.7 outcome table above).

The torture harness gained one settle `globalThis.gc()` before the GC-profiler window (reviewer-
verified legitimate): the window was reclaiming pre-window garbage from the two 2^16-key static
builds, a one-time major GC, not a hot-loop allocation; `maxMajor: 0` is unchanged and the BREAK
control still fails.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
