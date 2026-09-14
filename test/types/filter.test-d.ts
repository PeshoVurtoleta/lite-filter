/**
 * @zakkster/lite-filter -- type-level surface gate (compiled by `tsc --noEmit`,
 * never run). The TEETH for Filter.d.ts: it asserts the generic surface is present
 * and correct AND proves the family contract -- that `Bloom` SATISFIES the uniform
 * `LiteFilter` interface, so a caller can swap one member for another.
 *
 * Test-only; not in files[]. ASCII-only.
 */
import Bloom, { VERSION } from "../../Filter.js";
import type { LiteFilter, FilterOptions, FilterSnapshot } from "../../Filter.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
declare function expectTrue<_T extends true>(): void;

// ---- surface shapes ---------------------------------------------------------
const f = new Bloom<string>(1000, { fpp: 0.01 });
expectTrue<Equal<ReturnType<typeof f.mightContain>, boolean>>();
expectTrue<Equal<ReturnType<typeof f.has>, boolean>>();
expectTrue<Equal<typeof f.size, number>>();
expectTrue<Equal<typeof f.count, number>>();
expectTrue<Equal<typeof f.capacity, number>>();
expectTrue<Equal<ReturnType<typeof f.fpp>, number>>();

// add returns void
const added: void = f.add("k");
void added;

// ---- VERSION is a string ----------------------------------------------------
expectTrue<Equal<typeof VERSION, string>>();

// ---- family contract: Bloom SATISFIES LiteFilter (the one-line member swap) --
const iface: LiteFilter<string> = new Bloom<string>(1000);
iface.add("k");
const got = iface.mightContain("k");
expectTrue<Equal<typeof got, boolean>>();

// ---- construction options type-check ----------------------------------------
const opts: FilterOptions = { fpp: 0.001, seed: 42, keys: "int", stats: true };
void new Bloom<number>(10, opts);

// ---- snapshot round-trips through the typed surface -------------------------
const snap: FilterSnapshot = f.dump();
const restored: Bloom<string> = Bloom.restore(snap);
void restored;

// @ts-expect-error -- keys only accepts the literal 'int'
void new Bloom(10, { keys: "int32" });

// @ts-expect-error -- capacity is required
void new Bloom();
