# 0024 -- keys:'int' stays SIGNED int32; the fix for a `>>> 0` fold is documented, not absorbed

Status: accepted (1.2.0)

## Context

decisions/0001 rules the `keys:'int'` domain as a 32-bit SIGNED integer: [-2^31, 2^31 - 1].
The 2026-09-23 audit (RESEARCH.md 1.5, N1) found the integration trap: a consumer that folds a
composite signature with `>>> 0` (e.g. `((sid << 20) | (op << 12) | code) >>> 0`) produces values
in [2^31, 2^32) for half its domain, and `add()` THROWS on the hot path for exactly those keys.
The same fold with `| 0` is accepted and allocates nothing.

Two options were weighed:

- (a) keep the domain; document the signed fold loudly and name the fix in the error text.
- (b) also accept [2^31, 2^32) by normalising `key | 0` inside the door.

## Decision

**(a).** The domain stays exactly as decisions/0001 rules it. Option (b) silently aliases two
distinct numbers (`x` and `x - 2^32`) to one key -- a surprise for any caller that is NOT folding
a bit pattern -- and adds bytes to every int hot body for a problem the caller fixes with one
character.

- The int-key TypeError text names the fix: fold with `| 0`, never `>>> 0`.
- README, llms.txt, and the `keys` option doc in Filter.d.ts carry a signed-fold example:
  `((a << 20) | (b << 12) | c) | 0`.
- A unit pins that `add(2147483648)` and `add(0xFFFFFFFF)` still throw, with the new text.

## Consequences

- No hot-path change; no snapshot or wire change.
- A `>>> 0` consumer still fails closed (throws), but the message now says how to fix it.
