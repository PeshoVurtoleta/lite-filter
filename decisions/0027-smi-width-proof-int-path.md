# 0027 -- Smi-width-proof int hot path (THE RULE)

Status: accepted (1.2.1)

## Context

The H1 audit (RESEARCH.md section 1) measured the `keys:'int'` hot path with V8 inlining ON, and so
missed a boxing defect found by lite-hud's M5 peer probe (RESEARCH.md section 2), which gates every
peer under `--max-inlined-bytecode-size=0` -- because a real consumer's hot path (large, polymorphic)
is the non-inlined case. With inlining OFF, every member allocated on the int path, and BinaryFuse
allocated even inlined.

Cause: a 32-bit hash word crosses a call boundary that V8 does not inline, and is not a Smi there, so
it is boxed into a ~16 B HeapNumber. Which values are not Smis depends on the engine:

- Node (no pointer compression, 32-bit Smis): unsigned values `>= 2^31` -- half of all hashes.
- Chrome / d8 (pointer compression, 31-bit Smis): anything outside `[-2^30, 2^30)` -- half of all
  SIGNED hashes. Hash outputs are uniform over 32 bits regardless of key magnitude, so no key-range
  proxy models this; only a 31-bit-Smi engine (V8 d8) can.

The prototype V3 (signed `fmix32` returns + `>>> 0` at the callers) read 0 scavenges on Node but only
trimmed d8 (Bloom 2->14 became 1->11, BinaryFuse 3->25 became 3->23). V3 is therefore the parity
reference and the Node evidence, NOT the fix.

## Decision

THE RULE (code-review law for `Filter.js` hot paths): no value that can leave `[-2^30, 2^30)` crosses
a call boundary, as an argument OR a return. Only tagged references (the filter, the caller's own
key), Smis (16-bit halves, indices, counts) and `undefined` cross. A 32-bit word is produced and
consumed in ONE frame, or handed over through the module `Int32Array` scratch `_HG`.

1. **Per-class int mixers, not one shared helper.** Each member's int path calls a PER-CLASS
   `_mixInt` (or Quotient's `_hash`) that runs the `fmix32` body in its OWN frame, reading the
   double-representation `_seed` / `_seed2` fields there (a load inside the frame never boxes; a load
   passed as an argument does), and writes the words to `_HG`. A single SHARED helper would see 7
   maps (> V8's polymorphic limit of 4); the megamorphic LoadIC would re-box the double-field seed
   into a fresh HeapNumber per load -- the very box being removed -- and the one-member-per-process
   perf lanes could not see it. Rejected too: staging seeds into the scratch for a shared helper (a
   forgotten store would hash with another instance's seed -- false negatives, fail-OPEN). Each mixer
   body is byte-identical to `fmix32`, proven per member by `test/parity/parity.mjs`.

2. **Field-free module helpers are PERMITTED, not mandated.** `_ckAlt(fp)` (Cuckoo alt bucket; `fp`
   is a Smi < 2^16) and `mulhiU32(ah, al, b)` (the first operand split into two 16-bit Smi halves)
   take only Smis and read no double fields, so they stay monomorphic. The STATIC members (XorFilter,
   BinaryFuse) have a SINGLE query call site, so their query INLINES all four `fmix32` bodies as
   locals -- THE RULE's primary "one frame" clause, no `_HG` hop. This is both compliant and faster
   (the `_HG` round-trip is measurable overhead for a ~100 Mops/s query). Interleaved per-process
   int-`has` ops/s vs 1.2.0 (median of K pairs, `research/h2-proto/opsps.mjs`, quiet machine):
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

3. **`mulhiU32` takes 16-bit halves.** `mulhiU32(h >>> 16, h & 0xffff, scl)`: the full `h` never
   crosses the boundary, and the return is `< scl < 2^30` (a Smi on both engines). The body already
   consumed its first operand only as `>>> 16` / `& 0xffff`, so this is byte-identical.

4. **Xor/BinaryFuse BUILD stays on plain `fmix32`.** The peel is COLD -- every attempt allocates
   scaffold arrays anyway -- so THE RULE does not apply; `fmix32` now returns `h | 0` (signed) and
   the cold/string callers wrap `>>> 0` where they consume the word non-bitwise (byte-identical,
   from V3).

5. **Quotient index bound.** `_runStart` / `_place` take array indices `< nslots`. These are Smis
   on a 31-bit-Smi engine ONLY while `nslots <= 2^30` (`nslots === 2^30` is INSIDE the bound; the
   first size above it is the next power of two, `nslots === 2^31`, whose indices box). This is the
   array-index geometry, not the hash words, and is documented rather than fixed -- `MAX_NSLOTS`
   stays `2^31` (a >= 2 GiB store is out of scope for the zero-box claim).

6. **The string path is deferred to H3.** `hashStr(key, this._seed)` passes a double-field seed and
   returns a 32-bit word. On a 31-bit-Smi engine (Chrome/d8) a non-inlined consumer boxes there (the
   unsigned seed and a return outside [-2^30, 2^30) are both non-Smi). On Node (32-bit Smis) the
   `hashStr` return is signed (`| 0` -> a Smi), so for members whose string hash crosses the boundary
   only as that signed word the Node non-inlined cost is UNMEASURED and not claimed -- no over-claim
   either way: the string path is simply out of the 1.2.1 zero-box claim. Inline lanes stay 0 B
   (unchanged). The Smi-width-proof string path (same `(this, str)`-in, scratch-out pattern) is H3
   with its own lane.

7. **Caller caveat.** On a 31-bit-Smi engine the caller must pass int keys in `[-2^30, 2^30)` -- a
   key outside it is boxed by the caller's own `add(k)` / `has(k)` expression, before this library
   runs. A Chrome-clean consumer folds with `(x << 1) >> 1`, not just `| 0` (which is Node-clean
   only). That fold is LOSSY (`x` and `x ^ 0x80000000` collide), so it can only add false positives,
   never a false negative -- the one-sided contract is preserved. Documented in README, llms.txt,
   and `Filter.d.ts`.

## Gates

The two PERF gates FAIL on 1.2.0 and pass on the rewrite (revert-checked): SmiWidth (Node) is 10/13
red on 1.2.0, SmiWidthD8 (d8) is 9/14 red. Parity is a WITNESS that passes on 1.2.0 by construction
(the rewrite is byte-for-byte identical to it); its teeth are the seed-perturb and re-entrancy
MUST-FAIL controls, not a red-on-1.2.0 result.

- `test/perf/SmiWidth.test.mjs` (Node, 32-bit Smis): every member's int `add` / `mightContain` = 0
  scavenges at 1.6M ops, inline AND `--max-inlined-bytecode-size=0`, full int32 keys; the deletable
  churn and Cuckoo kick lanes are gated NO-INLINE only (inline measures 0 too but is not asserted);
  nop / object / box control lanes must grow; a pointer-compressed Node build fails closed with a
  message.
- `test/perf/SmiWidthD8.test.mjs` (V8 d8, 31-bit Smis): same members and ops, keys `>> 1` so every
  key is a Smi (the caller never boxes and every scavenge is the library's); the add / `mightContain`
  lanes are gated inline + no-inline, churn / kick no-inline only; the parity file runs on d8 with a
  digest identical to Node. FAILS CLOSED when d8 is absent (never a skip); in `verify`.
- `test/Parity.test.js` + `test/parity/parity.mjs`: 3,521,664 checks, 0 differences vs the frozen
  `test/fixtures/Filter.1.2.0.js` (same digest on Node and d8). Teeth: a seed-perturb control (seed
  ^ 1 must diverge) and a re-entrancy control (inject `has()` into the forbidden window between a
  `_HG` write and its read -- the result MUST change).

## The torture harness settle gc()

`test/torture.mjs` gained one `globalThis.gc()` immediately before the GC-profiler window opens. The
harness's existing gc() runs at the end of phase 1, BEFORE the seven phase-2 instances are built --
and the two STATIC builds (`XorFilter.from` / `BinaryFuse.from` over the full 2^16 key set) allocate
large transient peel scaffolds that are garbage by the time the window opens. Reclaiming that
pre-window garbage is a ONE-TIME major GC that V8 may schedule inside the window; it is not a hot-loop
allocation. In the shipped harness WITHOUT the settle gc(), 1.2.0 reads major=0 minor=1 and the
rewrite reads major=1 minor=1 (the rewrite deterministically trips the one-time reclamation); WITH
the settle gc() both read major=0 minor=0, and the in-window heap growth is 1 B/op (rewrite) vs
3 B/op (1.2.0) -- the rewrite allocates strictly less, not more. The settle gc() makes the window
measure the steady-state hot loop, as the harness comment states it intends, and matches the
torture-harness skill template. It does NOT widen the budget (`maxMajor: 0` is unchanged) and the
BREAK control still fails (its retained sink grows unboundedly inside the window regardless).

## Consequences

- No API, wire, snapshot, or hash-output change -- parity is byte-for-byte with 1.2.0.
- The int hot path is zero-alloc inline and non-inlined on 32-bit- and 31-bit-Smi engines; this is
  what lite-hud M5 pins `>= 1.2.1` for.
- `fmix32` now returns a signed word; the one cold checksum caller is byte-identical (every use of
  the result is bitwise or a final `>>> 0`).
