# 0009 -- CountingBloom remove(): two passes, fail closed, and the caveats

Status: accepted (v0.2.0)

## Context

`remove(key)` is the whole reason CountingBloom exists. It must decrement the `k`
counters of a key -- but decrementing blindly is dangerous. If the key was never
added, its `k` positions may still be nonzero because OTHER keys hit them; blindly
decrementing would drop those shared counters and cause a false negative for a key
that WAS added. A Counting Bloom is only as honest as its `remove` discipline.

## Decision

### Two passes, no scratch storage

`remove` runs the probe loop TWICE over the same `(a, b)` double-hash, allocating
nothing:

1. **Verify.** Read all `k` counters. If ANY is 0, the key is definitely absent:
   return `false` and mutate NOTHING. (A partial match must not decrement -- that is
   the corruption door.)
2. **Decrement.** Only after pass 1 proves every counter > 0, decrement each counter
   in 1..14. A counter at 15 is saturated and left alone (decisions/0008); a 0 cannot
   occur here (pass 1 proved it). Then `count--`, return `true`.

The probe body is kept BRANCH-IDENTICAL to `add` so the perf gate does not drift --
two passes double the probe cost but do not add allocation.

### The two documented caveats

- **Removing a never-added key can corrupt state.** If a never-added key happens to
  collide such that all `k` counters are nonzero (a false positive), `remove` will
  decrement real keys' counters and can cause a later FALSE NEGATIVE. Only remove
  keys you actually added. This is inherent to Counting Bloom, stated not hidden.
- **Saturated counters stick.** A counter clamped at 15 (decisions/0008) never
  decrements, so a key routed only through saturated counters can remain "present"
  after removal.

## Consequences

- `remove` on an ABSENT key is safe (fail closed: returns false, no mutation).
- `size` / `count` is net add minus successful remove; it is EXACT only when every
  remove is of a key you actually added. Under the unsound-remove misuse above it is an
  approximation, and the counter is FLOORED at 0 (it never goes negative).
- The differential torture removes ONLY keys the Set oracle says are present and keeps
  multiplicity at 1, so neither caveat fires -- 0 false negatives over 1e5 mixed ops.
- CountingBloom's `remove` returns a boolean; Bloom's still throws (decisions/0003).
  The uniform `LiteFilter<K>` surface stays remove-free (member-specific).
