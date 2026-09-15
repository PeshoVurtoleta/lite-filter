# 0020 -- XOR filter: fingerprint width, the fpp floor, and restore revalidation

Status: accepted (v0.6.0)

## Context

The XOR filter stores a small fingerprint per slot (decisions/0018). The open questions are
the fingerprint width, what happens when a target fpp is smaller than the widest supported
fingerprint, and how `restore()` guards a snapshot -- given that a static member's ENTIRE
identity is its fingerprint array, a silently-coerced corrupt word is a false negative.

## Decision

### Fingerprint width `fw` -- byte-aligned from the target fpp

    fw = 8   when fpp >= 2^-8   (~0.0039)
    fw = 16  when 2^-16 <= fpp < 2^-8
    fpp < 2^-16  THROWS  (the 16-bit floor)

Byte-aligned like Cuckoo (decisions/0014) and Quotient (decisions/0016): an 8-bit
fingerprint is a `Uint8Array`, a 16-bit one a `Uint16Array`. The delivered FPR is the
width-quantized `2^-fw`, which -- because the width is byte-aligned -- is typically UNDER the
configured target. At the default `fpp = 0.01`: `fpp >= 2^-8` so `fw = 8`, delivered FPR
`2^-8 = 0.0039` < 0.01, MEASURED ~0.0039 by the torture differential. This is surfaced, not
hidden: `fpp()` reports `2^-fw`, and the bench prints measured vs this theoretical. This is
the family's measure-vs-configured honesty hook for XOR.

`fpp < 2^-16` needs a fingerprint wider than 16 bits and THROWS a `[lite-filter]` RangeError
naming the smallest supported fpp (2^-16 ~ 0.0000153) -- parallel to Cuckoo's / Quotient's
16-bit floor. The 16-bit floor is INCLUSIVE (`fpp == 2^-16` fits `fw = 16`).

### Position range reduction -- `hash % bl`, not multiply-shift

Each position is `hash % bl` (offset into its segment). Modulo -- not Lemire multiply-shift
reduction -- is used deliberately: with a 32-bit hash and a large `bl`, `hash * bl` would
exceed 2^53 and lose double precision, silently biasing positions. `hash % bl` is EXACT for
any 32-bit hash and any `bl < 2^53`, and it is still branch-free and allocation-free on the
query hot path. The too-large door caps `3*bl <= 0x3fffffff` so the array fits a typed-array
length; a larger request throws `[lite-filter]` fail-closed.

### `restore()` -- re-derive every consistency tie BEFORE populating (REJECT, never truncate)

A static filter's identity is its fingerprint array, so `restore()` is strict. It re-derives
and cross-checks EVERY structural tie against the snapshot BEFORE writing any slot:

  - the width `fw` from the stored `fpp` (a tampered `fw` is caught, not trusted);
  - the segment length `bl` from the stored `count` (`bl == ceil(1.23*count/3)+32`);
  - the array length (`fp.length == 3*bl`);
  - every word (`0 <= word <= (1<<fw)-1`), an integer -- never coerced;
  - the format tag (`litefilter/2`), member tag, 32-bit-integer seed, and enum-legal keys
    mode (`"int"` or `null`).

Then it recomputes the family-wide integrity checksum `chk` (decisions/0021) and rejects a
mismatch. This is what actually catches a FLIPPED `keys`/`seed`: the structural checks only
enforce that `keys` is one of its two legal values and `seed` is a valid uint32 -- both
flipped values pass those -- but `keys`/`seed` cannot be re-derived from the fingerprint
array, so without the checksum a flip reconstructed under the wrong hash path (the QA
fail-open, 1990/2000 false negatives). The checksum is an INTEGRITY check against accidental
corruption, not a MAC (a forger who recomputes `chk` is out of scope).

Any mismatch or out-of-range word THROWS `[lite-filter]` and the instance is never mutated
(REJECT, never truncate; null is not zero). A coercion would silently turn a garbled value
into a wrong fingerprint -- a false negative -- which is exactly the failure a static
membership filter must never ship.

## Consequences

- The delivered FPR at the default fpp is ~2^-8, comfortably under the configured 0.01 and
  proven non-vacuous (> 0) by the torture differential.
- `restore()`'s count->bl->length chain means a corrupt `count` OR `bl` OR array length is
  caught transitively; the snapshot cannot smuggle a wrong-shaped array past the doors.
- The modulo reduction trades a few cycles for exactness; the zero-GC proof (perf gate 0
  scavenges at N and 8N) is unaffected -- modulo allocates nothing.
