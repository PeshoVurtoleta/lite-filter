/**
 * @zakkster/lite-filter -- type-level surface gate (compiled by `tsc --noEmit`,
 * never run). The TEETH for Filter.d.ts: it asserts the generic surface is present
 * and correct AND proves the family contract -- that `Bloom` SATISFIES the uniform
 * `LiteFilter` interface, so a caller can swap one member for another.
 *
 * Test-only; not in files[]. ASCII-only.
 */
import Bloom, { VERSION, CountingBloom, BlockedBloom, Quotient, XorFilter } from "../../Filter.js";
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

// ---- CountingBloom: the deletable member, remove() is REAL (boolean) ---------
const cbf = new CountingBloom<number>(1000, { fpp: 0.01, keys: "int" });
expectTrue<Equal<ReturnType<typeof cbf.mightContain>, boolean>>();
const removed: boolean = cbf.remove(1);
expectTrue<Equal<typeof removed, boolean>>();

// CountingBloom SATISFIES the uniform surface (one-line member swap).
const iface2: LiteFilter<number> = new CountingBloom<number>(1000);
iface2.add(1);
const got2 = iface2.mightContain(1);
expectTrue<Equal<typeof got2, boolean>>();

// snapshot round-trips through the typed surface.
const cbfSnap: FilterSnapshot = cbf.dump();
const cbfRestored: CountingBloom<number> = CountingBloom.restore(cbfSnap);
void cbfRestored;

// ---- BlockedBloom: the cache-local member, add-only (remove is `never`) -------
const bb = new BlockedBloom<number>(1000, { fpp: 0.01, keys: "int" });
expectTrue<Equal<ReturnType<typeof bb.mightContain>, boolean>>();
expectTrue<Equal<ReturnType<typeof bb.has>, boolean>>();
expectTrue<Equal<ReturnType<typeof bb.fpp>, number>>();

// remove() is add-only -> `never` (like Bloom, unlike CountingBloom's boolean).
expectTrue<Equal<ReturnType<typeof bb.remove>, never>>();

// BlockedBloom SATISFIES the uniform surface (one-line member swap).
const iface3: LiteFilter<number> = new BlockedBloom<number>(1000);
iface3.add(1);
const got3 = iface3.mightContain(1);
expectTrue<Equal<typeof got3, boolean>>();

// snapshot round-trips through the typed surface.
const bbSnap: FilterSnapshot = bb.dump();
const bbRestored: BlockedBloom<number> = BlockedBloom.restore(bbSnap);
void bbRestored;

// ---- Quotient: the mergeable + resizable deletable member --------------------
const qf = new Quotient<number>(1000, { fpp: 0.01, keys: "int" });
expectTrue<Equal<ReturnType<typeof qf.mightContain>, boolean>>();
const qfRemoved: boolean = qf.remove(1);
expectTrue<Equal<typeof qfRemoved, boolean>>();
// resize() and merge() return the filter (chainable), NOT void.
const qfResized: Quotient<number> = qf.resize(2000);
const qfMerged: Quotient<number> = qf.merge(new Quotient<number>(1000, { fpp: 0.01, keys: "int" }));
void qfResized;
void qfMerged;

// Quotient SATISFIES the uniform surface (one-line member swap).
const iface4: LiteFilter<number> = new Quotient<number>(1000);
iface4.add(1);
const got4 = iface4.mightContain(1);
expectTrue<Equal<typeof got4, boolean>>();

// snapshot round-trips through the typed surface.
const qfSnap: FilterSnapshot = qf.dump();
const qfRestored: Quotient<number> = Quotient.restore(qfSnap);
void qfRestored;

// ---- XOR: the space-optimal STATIC member (from()/build(), no mutation) -------
const xf = XorFilter.from<number>([1, 2, 3], { fpp: 0.01, keys: "int" });
expectTrue<Equal<ReturnType<typeof xf.mightContain>, boolean>>();
expectTrue<Equal<ReturnType<typeof xf.has>, boolean>>();
expectTrue<Equal<ReturnType<typeof xf.fpp>, number>>();
expectTrue<Equal<typeof xf.size, number>>();
expectTrue<Equal<typeof xf.capacity, number>>();

// static: add / remove / clear are all `never` (a static filter has no mutation).
expectTrue<Equal<ReturnType<typeof xf.add>, never>>();
expectTrue<Equal<ReturnType<typeof xf.remove>, never>>();
expectTrue<Equal<ReturnType<typeof xf.clear>, never>>();

// the .build alias has the same shape as from().
const xf2: XorFilter<number> = XorFilter.build<number>([4, 5, 6], { keys: "int" });
void xf2;

// @ts-expect-error -- there is no public constructor (build via the factory).
void new XorFilter<number>();

// snapshot round-trips through the typed surface.
const xfSnap: FilterSnapshot = xf.dump();
const xfRestored: XorFilter = XorFilter.restore(xfSnap);
void xfRestored;
