# 0017 -- Quotient remove(): the fingerprint-collision false-negative caveat

Status: accepted (v0.5.0)

## Context

`Quotient` implements a real `remove(key) -> boolean` (decisions/0003 for the surface):
it splits the key's hash into `(quotient, remainder)`, scans the quotient's run for the
remainder, and on a match clears the slot and repairs the cluster (decisions/0016). It
returns `false` and mutates nothing when the remainder is not in the run. Like Cuckoo's
delete this is SHARPER than a Counting Bloom delete -- it removes a concrete stored
`(quotient, remainder)` instance, not a shared counter -- and it carries the same honest
caveat that sharpness always brings.

## Decision

**State the fingerprint-collision false-negative caveat plainly; do not soften it.**

A remainder is a small hash (`r = ceil(log2(1/fpp))` bits, e.g. 7 at `fpp = 0.01`), and the
quotient is likewise a bounded slice of the hash, so distinct keys collide on the SAME
`(quotient, remainder)` routinely. If a caller removes a key that was NEVER inserted, and
that key's `(quotient, remainder)` COLLIDES with a real key that WAS inserted, `remove`
cannot tell them apart -- it clears the real key's slot. The result is a later FALSE NEGATIVE
for that other, legitimately-present key: the one-sided guarantee is void for it.

### A non-vacuous, constructed example

With `new Quotient(16, { fpp: 0.3, keys: 'int' })` (the default seed `0x9e3779b1`), the
geometry is `r = 2`, `q = 5`, `nslots = 32`, `p = 7`, so a 7-bit fingerprint makes an exact
`(quotient, remainder)` collision easy to exhibit:

    key A = 42   ->  (quotient 6, remainder 2)
    key B = 131  ->  (quotient 6, remainder 2)     -- SAME slot + remainder

Then:

    f.add(42)                 -> mightContain(42) === true,  size === 1
    f.remove(131)             -> returns true  (131 was NEVER inserted!)
    mightContain(42)          -> now FALSE       -- a false negative for a key we still "own"
    size                      -> 0

`remove(131)` reports a (spurious) successful delete and clears the slot that key 42's
remainder occupies, because 42 and 131 share both the home quotient and the remainder. The
caller who owns 42 never touched it, yet it is now unfindable.

Contrast with a legitimate remove: deleting a key you actually inserted always clears one
instance of a `(quotient, remainder)` that is genuinely present. Because a Quotient stores
MULTIPLICITY (it does not dedup, decisions/0016), two present keys sharing a fingerprint hold
two slots, and removing one leaves the other resident -- no currently-present key loses its
last instance by accident. The hazard is ONLY the never-inserted key.

The rule, therefore: **only remove keys you actually inserted.** This is documented in the
`remove` docstring, `Filter.d.ts`, the README member section, and llms.txt. `remove` does NOT
attempt to verify prior insertion (it cannot -- the filter is approximate), and it does NOT
fail closed on a `false` result (a `false` is the correct, safe answer: nothing matched,
nothing mutated). The caveat is a property of Quotient deletes, surfaced not hidden.

## Consequences

- A workload that removes arbitrary / untrusted keys should use a structure that tolerates
  it, or gate removes behind an authoritative set; the Quotient's delete is for keys you own
  -- exactly as Cuckoo's is (decisions/0015).
- The torture delete-churn oracle only ever removes keys the mirror `Set` says are present,
  so it exercises the SAFE path (0 false negatives, size == present); the QA suite exhibits
  the UNSAFE path as the constructed example above (a single engineered collision that flips
  `mightContain(A)` from true to false). The caveat is a documented property, not a tested-
  happy behavior.
- Combined with the fail-closed load ceiling (decisions/0016), the Quotient's honest edges --
  fill, delete, and the fixed-`p` resize limit -- are all explicit.
