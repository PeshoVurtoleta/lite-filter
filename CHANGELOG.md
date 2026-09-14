# Changelog

All notable changes to `@zakkster/lite-filter` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `VERSION` constant, `package.json` `version`, and `llms.txt` are bumped
together (three-place version sync) at release.

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
