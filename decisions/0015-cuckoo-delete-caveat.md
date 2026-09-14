# 0015 -- Cuckoo remove(): the fingerprint-collision false-negative caveat

Status: accepted (v0.4.0)

## Context

`Cuckoo` implements a real `remove(key) -> boolean` (decisions/0003 for the surface): it
scans the key's two candidate buckets for the key's fingerprint and clears the FIRST
matching slot, returning `true`; it returns `false` and mutates nothing when no slot
matches. This is sharper than a Counting Bloom delete -- a CBF decrements a shared counter
(and a saturated counter sticks), whereas a Cuckoo delete removes a CONCRETE fingerprint
instance. That sharpness carries its own honest caveat.

## Decision

**State the fingerprint-collision false-negative caveat plainly; do not soften it.**

A fingerprint is a small hash (8 or 16 bits), so distinct keys collide on the same
fingerprint routinely. If a caller removes a key that was NEVER inserted, and that key's
fingerprint + candidate bucket COLLIDE with a real key that WAS inserted, `remove` cannot
tell them apart -- it clears the real key's slot. The result is a later FALSE NEGATIVE for
that other, legitimately-present key: the one-sided guarantee is void for it.

Contrast with a legitimate remove: deleting a key you actually inserted always clears one
instance of a fingerprint that is genuinely present, so no currently-present key loses its
last fingerprint by accident (a shared fingerprint held by two present keys survives with
one instance until both are removed). The hazard is ONLY the never-inserted key.

The rule, therefore: **only remove keys you actually inserted.** This is documented in the
`remove` docstring, `Filter.d.ts`, the README member section, and llms.txt. `remove` does
NOT attempt to verify prior insertion (it cannot -- the filter is approximate), and it does
NOT fail closed on a `false` result (a `false` is the correct, safe answer: nothing
matched, nothing mutated). The caveat is a property of Cuckoo deletes, surfaced not hidden.

## Consequences

- A workload that removes arbitrary / untrusted keys should use a structure that tolerates
  it, or gate removes behind an authoritative set; Cuckoo's delete is for keys you own.
- The torture delete-churn oracle only ever removes keys the mirror `Set` says are present,
  so it exercises the SAFE path (0 false negatives, size == present); the unsafe path is a
  documented caveat, not a tested-happy behavior.
- Combined with the overload throw (decisions/0014), Cuckoo's two honest edges -- fill and
  delete -- are both explicit.
