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
or box on any int32, negatives included. The consumer MUST fold `(sid, op, code)` to a SIGNED int32
(`| 0`), never `>>> 0`. It would benefit from N2 (detect keys:'int' without sniffing) and N3 (a real
headroom getter) before the M5 rework.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
