/**
 * @zakkster/lite-filter -- torture gate entry.  node --expose-gc test/torture.mjs
 *
 * The DONE-WHEN is a single command that prints exactly "ok" and exits 0. It fuses
 * three tortures into one gate (ROADMAP section 9; the torture-harness skill):
 *
 *   phase 1  RETENTION      -- churn Bloom instances through a leak tracker; after gc
 *                             the tracker size MUST return to 0 (nothing outlived its
 *                             owner) with zero orphan findings.
 *   phase 2  ALLOCATION/GC  -- steady-state add + mightContain on the keys:'int'
 *                             backing; the GC profiler gate demands maxMajor 0 and a
 *                             bounded pause. clear() must reuse the SAME ArrayBuffer.
 *   phase 3  DIFFERENTIAL   -- the Set-oracle falsifiable laws: 1e6 adds -> 0 false
 *                             negatives; n=1e5/fpp=0.01 over 1e6 disjoint probes ->
 *                             measured FPR <= 0.0125 (<= 25% over the formula). Also
 *                             the BlockedBloom laws: 0 false negatives, and a measured
 *                             FPR within its HONEST looser ceiling (<= 0.0175) that is
 *                             PROVEN to run OVER the plain-Bloom theory (decisions/0013).
 *
 * ENTRY CONTRACT (mirrors lite-lru): the --expose-gc guard, a dynamic peer preflight
 * AFTER the guard, and a printed replay seed on failure. The GATE line prints to
 * stderr; stdout carries only "ok" on success (so test/controls.mjs can gate it).
 *
 * CONTROL: LFILTER_TORTURE_BREAK=1 injects a retained allocation into the phase-2
 * hot loop -- the alloc gate rejects it, the run exits non-zero, and it never prints
 * "ok". A normal run exits 0. (Proven both ways by test/controls.mjs.)
 *
 * @license MIT
 */

async function main() {
    // --- guard: the GC gate is meaningless without --expose-gc ----------------
    if (typeof globalThis.gc !== "function") {
        process.stderr.write(
            "torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n");
        process.exit(1);
    }

    // --- preflight: peers must be installed before anything is imported --------
    for (const pkg of ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-signal"]) {
        try { await import(pkg); }
        catch {
            process.stderr.write(
                "torture: FAIL -- missing devDependency " + pkg + " -- run: npm install\n");
            process.exit(2);
        }
    }

    const { GcProfiler, checkNoGc } = await import("@zakkster/lite-gc-profiler");
    const {
        createLeakTracker,
        createOwnerCascadeOrphanKernel,
    } = await import("@zakkster/lite-leak");
    const { createRoot, effect, dispose } = await import("@zakkster/lite-signal");
    const { Bloom, CountingBloom, BlockedBloom, Cuckoo, Quotient, XorFilter, BinaryFuse } = await import("../Filter.js");
    const { validate, validateCounting, validateBlocked, validateCuckoo, validateQuotient, validateXor, validateBinaryFuse } =
        await import("./validate.mjs");
    const { differentialInt, differentialChurnInt, differentialResizeInt, differentialMergeInt, differentialStaticInt } =
        await import("./torture/oracle.mjs");

    const SEED = (process.env.TORTURE_SEED >>> 0) || 0x1f2e3d4c;
    const BREAK = process.env.LFILTER_TORTURE_BREAK === "1";
    // Two more must-fail control arms (test/controls.mjs drives all three out-of-process,
    // each matched on its SPECIFIC stderr violation text, not merely a nonzero exit):
    //   LEAK     -- plant a retained-but-tracked object in phase 1 so tracker.size() cannot
    //               return to 0; the retention gate MUST fail with a RETENTION diagnostic.
    //   SABOTAGE -- wipe a built filter's store so an added key reads false; the FN law MUST
    //               trip with a SABOTAGE diagnostic. Both are inert unless their env is set.
    const LEAK = process.env.LFILTER_TORTURE_LEAK === "1";
    const SABOTAGE = process.env.LFILTER_TORTURE_SABOTAGE === "1";
    const leakSink = [];   // module-lifetime retainer for the LEAK arm (never released)

    const leaks = [];
    const warns = [];
    const tracker = createLeakTracker({
        name: "filter-torture",
        onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
        onWarning: (w) => warns.push(w.kind + ":" + w.reason),
    });
    // Bloom patches NO timer / listener / observer / async surface, so per the
    // torture-harness skill we register ONLY the owner-cascade retention kernel --
    // the one that answers "did a filter outlive its owner?". Adding the surface
    // kernels here would only emit no-owner-set advisories for surfaces we never use.
    tracker.registerKernel(createOwnerCascadeOrphanKernel());

    // Phase-1 LIVENESS proof (a torture that never fires is a false PASS): count every
    // tracker.track() call and assert it equals the EXACT total the literal loop bounds
    // below produce. If a loop silently stops tracking (a broken effect, a swallowed
    // throw), the count diverges from EXPECTED_TRACKED and the gate fails -- so a green
    // `live === 0` can never be the vacuous "nothing was ever tracked" pass.
    let tracked = 0;
    const track = (obj, cleanup, tag, opts) => { tracked++; tracker.track(obj, cleanup, tag, opts); };

    // ---- phase 1: retention torture ------------------------------------------
    // Bloom holds only a typed array -- no timers, listeners, or global registry.
    // Each cycle tracks a fresh filter INSIDE a reactive owner scope; disposing the
    // scope must untrack it and let it be collected, so the tracker returns to 0.
    // The cleanup + tag are detached primitives: they must NOT close over `f`.
    const CYCLES = 4096;
    createRoot(() => {
        for (let i = 0; i < CYCLES; i++) {
            const e = effect(() => {
                const f = new Bloom(1024, { keys: "int" });
                f.add(i | 0);
                f.mightContain(i | 0);
                track(f, () => {}, "bloom", { audit: true });
                // CountingBloom holds only a Uint8Array -- same retention shape. Churn
                // it through the SAME owner scope so a leak here surfaces too.
                const g = new CountingBloom(1024, { keys: "int" });
                g.add(i | 0);
                g.remove(i | 0);
                track(g, () => {}, "counting-bloom", { audit: true });
                // BlockedBloom holds only a Uint32Array -- same retention shape as Bloom.
                // Churn it through the SAME owner scope so a leak here surfaces too.
                const h = new BlockedBloom(1024, { keys: "int" });
                h.add(i | 0);
                h.mightContain(i | 0);
                track(h, () => {}, "blocked-bloom", { audit: true });
                // Cuckoo holds only a Uint8Array|Uint16Array -- same retention shape.
                // Churn it through the SAME owner scope so a leak here surfaces too.
                const c = new Cuckoo(1024, { keys: "int" });
                c.add(i | 0);
                c.mightContain(i | 0);
                c.remove(i | 0);
                track(c, () => {}, "cuckoo", { audit: true });
                // Quotient holds only a Uint8Array|Uint16Array (+ two preallocated scratch
                // buffers) -- same retention shape. Churn it through the SAME owner scope.
                const qf = new Quotient(1024, { keys: "int" });
                qf.add(i | 0);
                qf.mightContain(i | 0);
                qf.remove(i | 0);
                track(qf, () => {}, "quotient", { audit: true });
            });
            dispose(e); // disposing the owner untracks the filters -> collectable
        }
    });
    // XOR build-then-drop retention (decisions/0018): the static member's peel scaffold
    // (edge lists, degree counters, peel stack) is allocated inside from() and MUST NOT
    // outlive the instance -- and the instance itself must be collectable once its owner
    // scope disposes. 50 cycles is enough to surface a retained buffer; after gc the
    // tracker returns to 0. The cleanup + tag are detached primitives (no capture of `xf`).
    createRoot(() => {
        for (let i = 0; i < 50; i++) {
            const e = effect(() => {
                const xf = XorFilter.from([i, i + 1, i + 2, i + 3, i + 4], { keys: "int" });
                xf.mightContain(i | 0);
                track(xf, () => {}, "xor", { audit: true });
            });
            dispose(e); // disposing the owner untracks the filter -> collectable
        }
    });
    // BinaryFuse build-then-drop retention (decisions/0022): identical to XOR -- the peel
    // scaffold allocated inside from() MUST NOT outlive the instance, and the instance must be
    // collectable once its owner scope disposes. 50 cycles surfaces a retained buffer; after gc
    // the tracker returns to 0. cleanup + tag are detached primitives (no capture of `bf`).
    createRoot(() => {
        for (let i = 0; i < 50; i++) {
            const e = effect(() => {
                const bf = BinaryFuse.from([i, i + 1, i + 2, i + 3, i + 4], { keys: "int" });
                bf.mightContain(i | 0);
                track(bf, () => {}, "binary-fuse", { audit: true });
            });
            dispose(e); // disposing the owner untracks the filter -> collectable
        }
    });
    // LEAK control arm: track an object AND retain it in a module-lifetime array, so it can
    // never be collected. tracker.size() therefore cannot return to 0 -- the retention gate
    // MUST fail. Uses tracker.track directly (not the counted wrapper) so the phase-1 liveness
    // count stays exact and the ONLY failing cause is the planted leak. Inert unless LEAK set.
    if (LEAK) {
        const planted = new Bloom(1024, { keys: "int" });
        tracker.track(planted, () => {}, "leak-plant", { audit: true });
        leakSink.push(planted); // retained forever -> never finalized -> live stays > 0
    }
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 50));
    const live = tracker.size();
    const findings = tracker.audit();
    // The EXACT track() total the loops above must have produced, derived from the literal
    // bounds: the main scope tracks 5 members (bloom, counting, blocked, cuckoo, quotient)
    // per cycle over CYCLES cycles, then the XOR loop tracks 1 over 50 cycles, then the
    // BinaryFuse loop tracks 1 over 50 cycles. A divergence means a loop silently stopped
    // tracking -- so the gate can never pass vacuously on "nothing tracked".
    const EXPECTED_TRACKED = CYCLES * 5 + 50 + 50;
    const trackedOk = tracked === EXPECTED_TRACKED;

    // ---- phase 2: allocation + GC torture ------------------------------------
    const HOT_CAP = 1 << 16;   // 65536
    const MASK = HOT_CAP - 1;
    const HOT = 3000000;
    const inst = new Bloom(HOT_CAP, { keys: "int" });
    const bufBefore = inst._words.buffer;
    // CountingBloom steady-state instance: add / mightContain / remove all on the hot
    // path, all strictly zero-alloc (nibble read/modify/write, no scratch array).
    const cinst = new CountingBloom(HOT_CAP, { keys: "int" });
    const cbufBefore = cinst._cnts.buffer;
    // BlockedBloom steady-state instance: add / mightContain on the hot path, both
    // strictly zero-alloc (one block, odd-stride within-block walk, no scratch).
    const binst = new BlockedBloom(HOT_CAP, { keys: "int" });
    const bbufBefore = binst._words.buffer;
    // Cuckoo steady-state instance: add / mightContain / remove all on the hot path, all
    // strictly zero-alloc (two-bucket b=4 scan, single scalar victim register on kicks, no
    // scratch array). add-then-remove each op keeps the table near-empty so no kick throws.
    const kinst = new Cuckoo(HOT_CAP, { keys: "int" });
    const kbufBefore = kinst._store.buffer;
    // Quotient steady-state instance: add / mightContain / remove all on the hot path, all
    // strictly zero-alloc (linear-probe split + shift, preallocated cluster scratch on
    // remove). add-then-remove each op keeps occupancy near zero so no insert throws.
    const qinst = new Quotient(HOT_CAP, { keys: "int" });
    const qbufBefore = qinst._store.buffer;
    // XOR steady-state instance: STATIC, built ONCE from the full [0, HOT_CAP) key set
    // (the build is a cold path -- allocation there is fine and happens OUTSIDE the hot
    // loop). The hot loop only QUERIES it: mightContain is strictly zero-alloc on keys:'int'
    // (3 hashes, 3 modulo reductions, an XOR-compare -- no scratch). Every probed key is
    // present, so it exercises the query-HIT path. XOR has no add/remove/clear (they throw),
    // so it is not mutated in the loop and is excluded from the clear()-reuse check below.
    const xkeys = new Array(HOT_CAP);
    for (let i = 0; i < HOT_CAP; i++) xkeys[i] = i;
    const xinst = XorFilter.from(xkeys, { keys: "int" });
    // BinaryFuse steady-state instance: STATIC, built ONCE from the full [0, HOT_CAP) key set
    // (the build is a cold path -- allocation there is fine, OUTSIDE the hot loop). The hot loop
    // only QUERIES it: mightContain is strictly zero-alloc on keys:'int' (3 hashes, a
    // multiply-shift + 2 within-segment offsets, an XOR-compare -- no scratch). Every probed key
    // is present, so it exercises the query-HIT path. Like XOR it has no add/remove/clear.
    const binstFuse = BinaryFuse.from(xkeys, { keys: "int" });
    // STRING-KEY steady-state lane (llms.txt: "string keys are zero-alloc-proven"). The
    // default (arbitrary-key) backing hashes a string over its UTF-16 code units via
    // charCodeAt -- no String() encode, no scratch -- so add/mightContain on a string key
    // allocate NOTHING. The keys are pre-interned into an array HERE, OUTSIDE the profiled
    // loop (building a string per op WOULD allocate and is the very thing the lane must not
    // do), so the loop below only reads existing string references. It runs inside the SAME
    // GcProfiler window under the same maxMajor:0 gate, making the llms.txt claim true.
    const skeys = new Array(HOT_CAP);
    for (let i = 0; i < HOT_CAP; i++) skeys[i] = "k:" + i;
    const sinst = new Bloom(HOT_CAP, {});   // default backing: arbitrary (string) keys

    // The BREAK control: a retained sink the hot loop feeds one fresh object per op,
    // so heapUsed climbs and the major-GC / pause gate rejects the window.
    const sink = BREAK ? [] : null;

    const gc = new GcProfiler().start();
    const heapBefore = process.memoryUsage().heapUsed;
    let acc = 0;
    for (let i = 0; i < HOT; i++) {
        inst.add(i & MASK);
        acc = (acc + (inst.mightContain((i * 2 + 1) & MASK) ? 1 : 0)) | 0;
        // CountingBloom: add then immediately remove the same key so the store stays
        // bounded and both hot paths (two-pass remove included) are exercised.
        cinst.add(i & MASK);
        acc = (acc + (cinst.mightContain(i & MASK) ? 1 : 0)) | 0;
        cinst.remove(i & MASK);
        // BlockedBloom: add then query on the hot path, both zero-alloc on keys:'int'.
        binst.add(i & MASK);
        acc = (acc + (binst.mightContain((i * 2 + 1) & MASK) ? 1 : 0)) | 0;
        // Cuckoo: add then query then remove the same key so the table stays near-empty
        // (no kick throw) and all three hot paths run, each zero-alloc on keys:'int'.
        kinst.add(i & MASK);
        acc = (acc + (kinst.mightContain(i & MASK) ? 1 : 0)) | 0;
        kinst.remove(i & MASK);
        // Quotient: add then query then remove the same key so occupancy stays near zero
        // (no ceiling throw) and all three hot paths run, each zero-alloc on keys:'int'.
        qinst.add(i & MASK);
        acc = (acc + (qinst.mightContain(i & MASK) ? 1 : 0)) | 0;
        qinst.remove(i & MASK);
        // XOR: query-only hot path (the filter is static). Every probed key is present, so
        // this is the zero-alloc query-hit path on keys:'int'.
        acc = (acc + (xinst.mightContain(i & MASK) ? 1 : 0)) | 0;
        // BinaryFuse: query-only hot path (static). Every probed key is present -- the zero-alloc
        // multiply-shift query-hit path on keys:'int'.
        acc = (acc + (binstFuse.mightContain(i & MASK) ? 1 : 0)) | 0;
        // STRING lane: add then query a PRE-INTERNED string key (no per-op allocation). Under
        // the same gc window and maxMajor:0 -- the proof string keys are zero-alloc.
        sinst.add(skeys[i & MASK]);
        acc = (acc + (sinst.mightContain(skeys[i & MASK]) ? 1 : 0)) | 0;
        if (BREAK) sink.push({ i: i, acc: acc }); // retained: MUST trip the gate
        if ((i & 8191) === 0) {
            gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
    }
    if (acc === -1) process.stderr.write("");       // keep `acc` observable (no DCE)
    if (BREAK && sink.length === 0) process.stderr.write("");

    await new Promise((r) => setTimeout(r, 50));
    const heapAfter = process.memoryUsage().heapUsed;
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();

    // String lane law: every distinct pre-interned string key was added during the loop
    // (i & MASK cycles the full [0, HOT_CAP) key domain), so all must read true -- one-sided,
    // 0 false negatives. Proves the string hot path is not only zero-alloc but CORRECT.
    let strFn = 0;
    for (let i = 0; i < HOT_CAP; i++) if (!sinst.mightContain(skeys[i])) strFn++;

    // clear() must reuse the SAME ArrayBuffer (zero-alloc reset) for both members.
    inst.clear();
    cinst.clear();
    binst.clear();
    kinst.clear();
    qinst.clear();
    const sameBuffer = inst._words.buffer === bufBefore &&
        cinst._cnts.buffer === cbufBefore &&
        binst._words.buffer === bbufBefore &&
        kinst._store.buffer === kbufBefore &&
        qinst._store.buffer === qbufBefore;
    validate(inst);
    validateCounting(cinst);
    validateBlocked(binst);
    validateCuckoo(kinst);
    validateQuotient(qinst);
    validateXor(xinst);
    validateBinaryFuse(binstFuse);

    // allocPerOp is measured across the phase-2 HOT loop ONLY (heapBefore/heapAfter bracket
    // that loop, before any merge/resize law runs), so it reflects the genuinely zero-alloc
    // add/mightContain/remove hot paths. A small nonzero value (single-digit B/op) is
    // heapUsed sampling noise, NOT cold-path amortization -- the real zero-alloc proof is the
    // GC profiler's GATED metric (major=0 above; minor GCs are REPORTED but not individually
    // gated here -- the lite-perf-gate 0-scavenge scenarios own the minor/scavenge bound). If
    // this creeps into the tens/hundreds it is a real hot-path regression, not noise.
    const allocPerOp = Math.max(0, Math.round((heapAfter - heapBefore) / HOT));

    // ---- phase 3: differential Set oracle ------------------------------------
    // Law 1: 1e6 adds then requery -- exactly 0 false negatives.
    const law1 = differentialInt(Bloom, { n: 1000000, fpp: 0.01, probes: 1, seed: SEED });
    // Law 2: n=1e5, fpp=0.01, 1e6 disjoint probes -- FPR <= 0.0125 (<= 25% over formula).
    const law2 = differentialInt(Bloom, { n: 100000, fpp: 0.01, probes: 1000000, seed: SEED ^ 0x55 });
    const FPR_LIMIT = 0.0125;
    // Law 3a (CountingBloom): 1e6 adds then requery -- exactly 0 false negatives (add-only
    // view; the same one-sided law every member carries).
    const cbfLaw1 = differentialInt(CountingBloom, { n: 1000000, fpp: 0.01, probes: 1, seed: SEED });
    // Law 3b (CountingBloom churn): mixed add/remove ops mirrored against a Set -- 0 false
    // negatives for keys CURRENTLY present, and the net count tracks the present-set. The
    // keyspace:20000 bound RECURS keys so remove() actually fires (equilibrium present-set
    // ~keyspace/2, well under the n=20000 capacity, every key at multiplicity 1 so no counter
    // saturates, decisions/0008). removes MUST exceed 20000 -- proof the delete path ran hard,
    // not a vacuous add-only churn -- and validateCounting on the CHURNED instance proves the
    // nibble store survived the churn intact.
    const churn = differentialChurnInt(CountingBloom,
        { n: 20000, fpp: 0.01, ops: 100000, seed: SEED ^ 0xa5, keyspace: 20000 });
    validateCounting(churn.filter);
    const cbfRemovesOk = churn.removes > 20000;

    // Law 4 (BlockedBloom): 1e6 adds -> exactly 0 false negatives (add-only, one-sided).
    const bbLaw1 = differentialInt(BlockedBloom, { n: 1000000, fpp: 0.01, probes: 1, seed: SEED });
    // Law 5 (BlockedBloom): n=1e5, fpp=0.01, 1e6 disjoint probes -> measured FPR within
    // the HONEST looser ceiling (decisions/0013): <= 0.0175. AND the penalty must be
    // PROVEN present -- the measured FPR must run OVER a floor set ABOVE plain Bloom's
    // OWN measured rate for this fill (law2.fpr ~ 0.00997, itself over the 0.00949 closed
    // form), so a penalty-free / plain-behaving build CANNOT pass this gate. BlockedBloom
    // measures ~0.01378 here, so a 0.0115 floor has real teeth with safe margin on both
    // sides (comfortably above plain ~0.00997, comfortably below blocked ~0.01378).
    const bbLaw2 = differentialInt(BlockedBloom, { n: 100000, fpp: 0.01, probes: 1000000, seed: SEED ^ 0x55 });
    const BB_FPR_LIMIT = 0.0175;   // honest ceiling: blocked runs OVER plain (decisions/0013)
    const BB_THEORY_FLOOR = 0.0115; // ABOVE plain Bloom's MEASURED rate -- must be EXCEEDED

    // Law 6 (Cuckoo): 1e6 adds -> exactly 0 false negatives (one-sided; no fingerprint
    // dropped below the load target). Sized for n, load ~0.61, so no kick throws.
    const cfLaw1 = differentialInt(Cuckoo, { n: 1000000, fpp: 0.01, probes: 1, seed: SEED });
    // Law 7 (Cuckoo): n=1e5, fpp=0.01, 1e6 disjoint probes -> measured FPR within a
    // ceiling BELOW the configured 0.01 target. Cuckoo's FPR is width-quantized to
    // ~2b/2^f (f=10 -> 8/1024 = 0.0078); the byte-aligned width lands the MEASURED rate
    // (~0.0061 here) UNDER the configured target -- the measure-vs-configured honesty hook.
    const cfLaw2 = differentialInt(Cuckoo, { n: 100000, fpp: 0.01, probes: 1000000, seed: SEED ^ 0x55 });
    const CF_FPR_LIMIT = 0.0090;   // above measured ~0.0061, below configured 0.01
    // Law 8 (Cuckoo delete): bounded-keyspace add/remove churn mirrored against a Set -> 0
    // false negatives for present keys, and net size tracks the present-set (decisions/0014).
    // The keyspace bound keeps the churn under the load target so no add() throws.
    const cfChurn = differentialChurnInt(Cuckoo,
        { n: 50000, fpp: 0.01, ops: 100000, seed: SEED ^ 0xa5, keyspace: 20000 });
    // Law 9 (Cuckoo overload): a small filter filled past capacity MUST throw a
    // [lite-filter] Error after 500 kicks (fail closed, decisions/0014) -- never a silent
    // drop -- AND the throw MUST NOT drop a previously-added key (the cardinal law: no
    // false negative on a successfully-added key) AND a thrown add MUST be a byte-identical
    // no-op (unwound to the exact pre-add state). Proven in-process.
    let cfOverload = false;      // the overflow raised a [lite-filter] Error
    let cfOverloadFn = 0;        // false negatives among keys added BEFORE the throw
    let cfOverloadNoop = false;  // a thrown add left dump() byte-identical (true no-op)
    {
        const full = new Cuckoo(64, { fpp: 0.01, keys: "int" });
        const added = [];
        try {
            for (let i = 0; i < 200000; i++) { full.add(i); added.push(i); }
        } catch (e) {
            cfOverload = e instanceof Error && /\[lite-filter\]/.test(e.message);
        }
        // The bug this catches: an overflow that drops an already-added key. Requery EVERY
        // key added before the throw -- 0 false negatives is the hard law.
        for (let j = 0; j < added.length; j++) if (!full.mightContain(added[j])) cfOverloadFn++;
        // A thrown add is a no-op: snapshot immediately before each attempt; on the attempt
        // that throws, the post-catch snapshot MUST equal the pre-add one (byte-identical).
        for (let t = 0; t < 200000; t++) {
            const before = JSON.stringify(full.dump());
            try { full.add(1000000 + t); }
            catch (e) { cfOverloadNoop = before === JSON.stringify(full.dump()); break; }
        }
    }

    // Law 10 (Cuckoo achievable load): a correct random-slot victim pick (r & 3 -- all four
    // b=4 slots evictable) must reach a HIGH load factor before the fail-closed door. Fill
    // to 90% of the slot capacity and assert NO throw and 0 false negatives. A degraded pick
    // (e.g. r & 1, only two slots evictable) cannot reach 90% and trips this -- covering the
    // kick-slot blind spot QA flagged (decisions/0014). Achievable load with r & 3 is ~0.96.
    let cfLoadOk = false;
    let cfLoadFn = 0;
    let cfLoadFrac = 0;
    {
        const lf = new Cuckoo(100000, { fpp: 0.01, keys: "int", seed: SEED });
        const target = Math.floor(0.90 * lf._store.length);
        let threw = false;
        try { for (let i = 0; i < target; i++) lf.add(i); } catch (e) { threw = true; }
        if (!threw) for (let i = 0; i < target; i++) if (!lf.mightContain(i)) cfLoadFn++;
        cfLoadFrac = lf.size / lf._store.length;
        cfLoadOk = !threw && cfLoadFn === 0;
    }

    // ---- Quotient laws (decisions/0016, 0017) --------------------------------
    // Law 11 (Quotient): 1e6 adds -> exactly 0 false negatives (one-sided; the linear
    // shift never drops a stored fingerprint below the load ceiling).
    const qfLaw1 = differentialInt(Quotient, { n: 1000000, fpp: 0.01, probes: 1, seed: SEED });
    // Law 12 (Quotient): n=1e5, fpp=0.01, 1e6 disjoint probes -> measured FPR within a
    // ceiling BELOW the configured 0.01 target. The FPR is remainder-quantized to
    // ~load*2^-r; r = ceil(log2(1/0.01)) = 7 (2^-7 = 0.0078), and load ~0.55 at this fill,
    // so the measured rate lands well under target -- the measure-vs-configured honesty hook.
    const qfLaw2 = differentialInt(Quotient, { n: 100000, fpp: 0.01, probes: 1000000, seed: SEED ^ 0x55 });
    const QF_FPR_LIMIT = 0.0090;   // above the measured rate, below the configured 0.01
    // Law 13 (Quotient delete): bounded-keyspace add/remove churn mirrored against a Set ->
    // 0 false negatives for present keys, and net size tracks the present-set. The keyspace
    // bound keeps the churn under the load ceiling so no add() throws (decisions/0016).
    const qfChurn = differentialChurnInt(Quotient,
        { n: 50000, fpp: 0.01, ops: 200000, seed: SEED ^ 0xa5, keyspace: 20000 });
    // Law 14 (Quotient resize): grow AND shrink round-trips -> 0 false negatives, size
    // preserved (resize re-inserts every stored fingerprint without the original keys).
    const qfGrow = differentialResizeInt(Quotient, { n: 50000, fpp: 0.01, seed: SEED ^ 0x77, factor: 4 });
    const qfShrink = differentialResizeInt(Quotient, { n: 50000, fpp: 0.01, seed: SEED ^ 0x77, factor: 0.6 });
    const qfResizeFn = qfGrow.falseNegatives + qfShrink.falseNegatives;
    const qfResizeOk = qfResizeFn === 0 &&
        qfGrow.sizeAfter === qfGrow.sizeBefore && qfShrink.sizeAfter === qfShrink.sizeBefore;
    // Law 15 (Quotient merge): disjoint-set merge round-trip -> 0 false negatives + exact
    // additive size (decisions/0016).
    const qfMerge = differentialMergeInt(Quotient, { n: 50000, fpp: 0.01, seed: SEED ^ 0xc3 });
    const qfMergeOk = qfMerge.falseNegatives === 0 && qfMerge.mergedSize === qfMerge.expectedSize;
    // Law 16 (Quotient ceiling): a small filter filled past the 0.90 ceiling MUST throw a
    // [lite-filter] Error (fail closed, decisions/0016) -- never a silent drop -- AND the
    // throw MUST NOT drop a previously-added key AND a thrown add MUST be a byte-identical
    // no-op (memcmp the store before/after; size unchanged). Proven in-process.
    let qfCeilingThrew = false;   // the overload raised a [lite-filter] Error
    let qfCeilingFn = 0;          // false negatives among keys added BEFORE the throw
    let qfCeilingNoop = false;    // a thrown add left the store byte-identical + size fixed
    {
        const full = new Quotient(64, { fpp: 0.01, keys: "int" });
        const added = [];
        try {
            for (let i = 0; i < 200000; i++) { full.add(i); added.push(i); }
        } catch (e) {
            qfCeilingThrew = e instanceof Error && /\[lite-filter\]/.test(e.message);
        }
        for (let j = 0; j < added.length; j++) if (!full.mightContain(added[j])) qfCeilingFn++;
        // A thrown add is a byte-identical no-op: memcmp the store + size across the attempt.
        for (let t = 0; t < 200000; t++) {
            const beforeStore = full._store.slice();
            const beforeSize = full.size;
            try { full.add(1000000 + t); }
            catch (e) {
                let identical = full._store.length === beforeStore.length && full.size === beforeSize;
                for (let z = 0; identical && z < beforeStore.length; z++) {
                    if (full._store[z] !== beforeStore[z]) identical = false;
                }
                qfCeilingNoop = identical;
                break;
            }
        }
        // Law 16b: cluster/metadata integrity survives churn -> validateQuotient passes.
        validateQuotient(full);
    }
    // Law 16c: validate structure after the churn filter too (the shift-back repair proof).
    {
        const vq = new Quotient(20000, { fpp: 0.01, keys: "int", seed: SEED });
        const rng = (function (seed) { let x = seed >>> 0 || 1; return function () { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x >>> 0; }; })(SEED ^ 0x1234);
        const live = new Set();
        for (let i = 0; i < 200000; i++) {
            const k = rng() % 8000;
            if (live.has(k)) { vq.remove(k); live.delete(k); } else { vq.add(k); live.add(k); }
        }
        validateQuotient(vq);
    }

    // ---- XOR laws (decisions/0018, 0019, 0020) --------------------------------
    // Law 17 (XOR): a static filter built from 1e6 distinct int keys -> EXACTLY 0 false
    // negatives (the complete-peel assignment guarantees every key in the set reads true).
    const xfLaw1 = differentialStaticInt(XorFilter, { n: 1000000, fpp: 0.01, probes: 1, seed: SEED });
    // Law 18 (XOR): n=1e5, fpp=0.01 (fw=8), 1e6 disjoint probes -> measured FPR within the
    // width-quantized ceiling 2^-8 (~0.0039) AND strictly > 0 (non-vacuous). The 0.0050
    // ceiling sits above the ~0.0039 characteristic rate with margin; a broken query that
    // never matches (fpr==0) or one running over the width would trip this.
    const xfLaw2 = differentialStaticInt(XorFilter, { n: 100000, fpp: 0.01, probes: 1000000, seed: SEED ^ 0x55 });
    const XF_FPR_LIMIT = 0.0050;   // above the ~0.0039 characteristic rate (fw=8), below any regression
    // Law 19 (XOR build door): a DEGENERATE key set -- distinct objects that all encode to
    // the same string ("[object Object]") -> duplicate hypergraph edges no reseed can
    // separate -> peeling exhausts all 100 attempts and THROWS [lite-filter] (fail closed,
    // never a partial build). Proven in-process.
    let xfBuildThrew = false;
    try { XorFilter.from([{}, {}, {}]); }
    catch (e) { xfBuildThrew = e instanceof Error && /\[lite-filter\]/.test(e.message); }
    // Law 20 (XOR immutability): add / remove / clear / new XorFilter each THROW
    // [lite-filter] fail closed (a static filter has no mutation surface, decisions/0019).
    let xfMutThrew = false;
    {
        const xf = XorFilter.from([1, 2, 3, 4, 5], { keys: "int" });
        let a = false, r = false, c = false, ctor = false;
        try { xf.add(6); } catch (e) { a = /\[lite-filter\]/.test(e.message); }
        try { xf.remove(1); } catch (e) { r = /\[lite-filter\]/.test(e.message); }
        try { xf.clear(); } catch (e) { c = /\[lite-filter\]/.test(e.message); }
        try { new XorFilter(); } catch (e) { ctor = /\[lite-filter\]/.test(e.message); }
        xfMutThrew = a && r && c && ctor;
        validateXor(xf);
    }
    const xfFn = xfLaw1.falseNegatives + xfLaw2.falseNegatives;

    // ---- BinaryFuse laws (decisions/0022) ------------------------------------
    // Law bf1 (BinaryFuse): a static filter built from 1e6 distinct int keys -> EXACTLY 0
    // false negatives (the complete-peel assignment guarantees every key reads true -- the
    // fail-open regression gate). ALSO measure the space headline off the same 1e6 build:
    // slots/item in [1.08, 1.13] (2dp) AND bits/item <= 9.30 (leaner than XOR's ~9.84).
    let bfFn = 0, bfSlotsPerItem = 0, bfBitsPerItem = 0;
    {
        const N = 1000000;
        const keys = new Array(N);
        for (let i = 0; i < N; i++) keys[i] = i;
        const bf = BinaryFuse.from(keys, { fpp: 0.01, keys: "int" });
        for (let i = 0; i < N; i++) if (!bf.mightContain(i)) bfFn++;
        bfSlotsPerItem = bf._arrayLen / N;
        bfBitsPerItem = (bf._fp.byteLength * 8) / N;
        validateBinaryFuse(bf);
    }
    const bfSlotsRound = Math.round(bfSlotsPerItem * 100) / 100;
    const BF_SLOTS_LO = 1.08, BF_SLOTS_HI = 1.13, BF_BITS_LIMIT = 9.30;
    // Law bf2 (BinaryFuse): n=1e5, fpp=0.01 (fw=8), 1e6 disjoint probes -> measured FPR within
    // the width-quantized ceiling 2^-8 (~0.0039) AND strictly > 0 (non-vacuous).
    const bfLaw2 = differentialStaticInt(BinaryFuse, { n: 100000, fpp: 0.01, probes: 1000000, seed: SEED ^ 0x55 });
    const BF_FPR_LIMIT = 0.0050;
    // Law bf3 (BinaryFuse build door): a DEGENERATE key set (distinct objects that all encode
    // to "[object Object]") -> peeling exhausts all 100 attempts and THROWS [lite-filter].
    let bfBuildThrew = false;
    try { BinaryFuse.from([{}, {}, {}]); }
    catch (e) { bfBuildThrew = e instanceof Error && /\[lite-filter\]/.test(e.message); }
    // Law bf4 (BinaryFuse immutability): add / remove / clear / new all THROW [lite-filter].
    let bfMutThrew = false;
    {
        const bf = BinaryFuse.from([1, 2, 3, 4, 5], { keys: "int" });
        let a = false, r = false, c = false, ctor = false;
        try { bf.add(6); } catch (e) { a = /\[lite-filter\]/.test(e.message); }
        try { bf.remove(1); } catch (e) { r = /\[lite-filter\]/.test(e.message); }
        try { bf.clear(); } catch (e) { c = /\[lite-filter\]/.test(e.message); }
        try { new BinaryFuse(); } catch (e) { ctor = /\[lite-filter\]/.test(e.message); }
        bfMutThrew = a && r && c && ctor;
        validateBinaryFuse(bf);
    }
    // Law bf5 (BinaryFuse restore fail-open): the CHARTER-SIGNATURE hunt -- an internally
    // consistent-but-wrong segment geometry (fp.length === (sc+2)*sl but sl disagrees with
    // _bfDims(count)) MUST be rejected by re-derivation; a chk mismatch (keys flip) MUST throw.
    let bfRestoreOk = false;
    {
        const isTag = (e) => e instanceof Error && /\[lite-filter\]/.test(e.message);
        const keys = []; for (let i = 0; i < 2000; i++) keys.push(i);
        const bf = BinaryFuse.from(keys, { keys: "int" });
        const pristine = BinaryFuse.restore(JSON.parse(JSON.stringify(bf.dump())));
        let ok = true; for (let i = 0; i < 2000; i++) if (!pristine.mightContain(i)) ok = false;
        let geom = false;
        {
            const s = bf.dump(); s.sl = s.sl * 2; s.fp = new Array((s.sc + 2) * s.sl).fill(0);
            try { BinaryFuse.restore(s); } catch (e) { geom = isTag(e); }
        }
        let chk = false;
        { const s = bf.dump(); s.keys = null; try { BinaryFuse.restore(s); } catch (e) { chk = isTag(e); } }
        let word = false;
        { const s = bf.dump(); const j = s.fp.length >> 1; s.fp[j] = (s.fp[j] ^ 1) & 0xff; try { BinaryFuse.restore(s); } catch (e) { word = isTag(e); } }
        bfRestoreOk = ok && geom && chk && word;
    }

    // Law 21 (snapshot integrity checksum, decisions/0021): the family-wide `chk` (format
    // litefilter/3) must REJECT a keys-mode flip and a store-bit flip fail-closed -- the QA
    // fail-open. Proven for a representative MUTABLE member (Bloom) and the STATIC member
    // (XorFilter): pristine dumps round-trip; a flipped keys-mode and a flipped store word
    // each throw [lite-filter]. A pass here means the provenance/store corruption door holds.
    let snapChkOk = false;
    {
        const isTag = (e) => e instanceof Error && /\[lite-filter\]/.test(e.message);
        const b = new Bloom(4096, { keys: "int" });
        for (let i = 0; i < 2000; i++) b.add(i);
        const bPristine = Bloom.restore(JSON.parse(JSON.stringify(b.dump())));
        let bOk = true; for (let i = 0; i < 2000; i++) if (!bPristine.mightContain(i)) bOk = false;
        let bKeys = false; { const s = b.dump(); s.keys = null; try { Bloom.restore(s); } catch (e) { bKeys = isTag(e); } }
        let bWord = false; { const s = b.dump(); const j = s.bits.length >> 1; s.bits[j] = (s.bits[j] ^ 1) >>> 0; try { Bloom.restore(s); } catch (e) { bWord = isTag(e); } }
        // XorFilter -- the exact QA repro: flip keys->null on a 2000-int-key dump.
        const xkeys2 = []; for (let i = 0; i < 2000; i++) xkeys2.push(i);
        const xf2 = XorFilter.from(xkeys2, { keys: "int" });
        const xPristine = XorFilter.restore(JSON.parse(JSON.stringify(xf2.dump())));
        let xOk = true; for (let i = 0; i < 2000; i++) if (!xPristine.mightContain(i)) xOk = false;
        let xKeys = false; { const s = xf2.dump(); s.keys = null; try { XorFilter.restore(s); } catch (e) { xKeys = isTag(e); } }
        let xWord = false; { const s = xf2.dump(); const j = s.fp.length >> 1; s.fp[j] = (s.fp[j] ^ 1) & 0xff; try { XorFilter.restore(s); } catch (e) { xWord = isTag(e); } }
        snapChkOk = bOk && bKeys && bWord && xOk && xKeys && xWord;
    }

    // SABOTAGE control arm: build a filter, add keys, then WIPE its bit store so every added
    // key now reads false -- a manufactured FALSE NEGATIVE. sabotageFn counts them; it stays 0
    // on a normal run and is nonzero only when SABOTAGE is set, so the FN law below trips ONLY
    // under sabotage. Inert (0) unless the env is set. Proves the FN gate has teeth.
    let sabotageFn = 0;
    if (SABOTAGE) {
        const sf = new Bloom(4096, { keys: "int" });
        for (let i = 0; i < 1000; i++) sf.add(i);
        sf._words.fill(0);   // corrupt the built store: every added key now reads false
        for (let i = 0; i < 1000; i++) if (!sf.mightContain(i)) sabotageFn++;
    }

    // ---- verdict --------------------------------------------------------------
    const oracleOk =
        law1.falseNegatives === 0 &&
        law2.falseNegatives === 0 &&
        law2.fpr <= FPR_LIMIT &&
        cbfLaw1.falseNegatives === 0 &&
        churn.falseNegatives === 0 &&
        churn.present === churn.filterSize &&
        cbfRemovesOk === true &&
        bbLaw1.falseNegatives === 0 &&
        bbLaw2.falseNegatives === 0 &&
        bbLaw2.fpr <= BB_FPR_LIMIT &&
        bbLaw2.fpr > BB_THEORY_FLOOR &&
        cfLaw1.falseNegatives === 0 &&
        cfLaw2.falseNegatives === 0 &&
        cfLaw2.fpr <= CF_FPR_LIMIT &&
        cfChurn.falseNegatives === 0 &&
        cfChurn.present === cfChurn.filterSize &&
        cfOverload === true &&
        cfOverloadFn === 0 &&
        cfOverloadNoop === true &&
        cfLoadOk === true &&
        qfLaw1.falseNegatives === 0 &&
        qfLaw2.falseNegatives === 0 &&
        qfLaw2.fpr <= QF_FPR_LIMIT &&
        qfChurn.falseNegatives === 0 &&
        qfChurn.present === qfChurn.filterSize &&
        qfResizeOk === true &&
        qfMergeOk === true &&
        qfCeilingThrew === true &&
        qfCeilingFn === 0 &&
        qfCeilingNoop === true &&
        xfFn === 0 &&
        xfLaw2.fpr <= XF_FPR_LIMIT &&
        xfLaw2.fpr > 0 &&
        xfBuildThrew === true &&
        xfMutThrew === true &&
        bfFn === 0 &&
        bfSlotsRound >= BF_SLOTS_LO &&
        bfSlotsRound <= BF_SLOTS_HI &&
        bfBitsPerItem <= BF_BITS_LIMIT &&
        bfLaw2.fpr <= BF_FPR_LIMIT &&
        bfLaw2.fpr > 0 &&
        bfBuildThrew === true &&
        bfMutThrew === true &&
        bfRestoreOk === true &&
        snapChkOk === true;
    const ok =
        report.ok &&
        live === 0 &&
        leaks.length === 0 &&
        findings.length === 0 &&
        trackedOk &&
        strFn === 0 &&
        sabotageFn === 0 &&
        sameBuffer &&
        oracleOk;

    process.stderr.write(
        "GATE leak=size " + live + "/0 findings=" + findings.length +
        " warnings=" + warns.length +
        " tracked=" + tracked + "/" + EXPECTED_TRACKED +
        " | gc major=" + s.gc.major + " minor=" + s.gc.minor +
        " maxMs=" + s.gc.maxMs.toFixed(2) +
        " | alloc=" + allocPerOp + " B/op strFn=" + strFn +
        " | oracle fn=" + (law1.falseNegatives + law2.falseNegatives) +
        " fpr=" + law2.fpr.toFixed(5) + " target=" + law2.target.toFixed(5) +
        " over=" + (((law2.fpr - law2.target) / law2.target) * 100).toFixed(1) + "%" +
        " | cbf fn=" + cbfLaw1.falseNegatives + " churn fn=" + churn.falseNegatives +
        " removes=" + churn.removes +
        " present=" + churn.present + " size=" + churn.filterSize +
        " | bb fn=" + (bbLaw1.falseNegatives + bbLaw2.falseNegatives) +
        " fpr=" + bbLaw2.fpr.toFixed(5) + " ceiling=" + BB_FPR_LIMIT.toFixed(5) +
        " floor=" + BB_THEORY_FLOOR.toFixed(5) +
        " overTheory=" + (bbLaw2.fpr > BB_THEORY_FLOOR) +
        " | cf fn=" + (cfLaw1.falseNegatives + cfLaw2.falseNegatives) +
        " fpr=" + cfLaw2.fpr.toFixed(5) + " ceiling=" + CF_FPR_LIMIT.toFixed(5) +
        " churnFn=" + cfChurn.falseNegatives +
        " present=" + cfChurn.present + " size=" + cfChurn.filterSize +
        " overload=" + cfOverload + " overloadFn=" + cfOverloadFn +
        " overloadNoop=" + cfOverloadNoop +
        " load=" + cfLoadFrac.toFixed(3) + " loadOk=" + cfLoadOk +
        " | qf fn=" + (qfLaw1.falseNegatives + qfLaw2.falseNegatives) +
        " fpr=" + qfLaw2.fpr.toFixed(5) + " ceiling=" + QF_FPR_LIMIT.toFixed(5) +
        " churnFn=" + qfChurn.falseNegatives +
        " present=" + qfChurn.present + " size=" + qfChurn.filterSize +
        " resizeFn=" + qfResizeFn + " mergeFn=" + qfMerge.falseNegatives +
        " mergeSize=" + qfMerge.mergedSize + "/" + qfMerge.expectedSize +
        " ceilingThrew=" + qfCeilingThrew + " ceilingNoop=" + qfCeilingNoop +
        " | xf fn=" + xfFn +
        " fpr=" + xfLaw2.fpr.toFixed(5) + " ceiling=" + XF_FPR_LIMIT.toFixed(5) +
        " buildThrew=" + xfBuildThrew + " mutThrew=" + xfMutThrew +
        " | bf fn=" + bfFn +
        " fpr=" + bfLaw2.fpr.toFixed(5) + " ceiling=" + BF_FPR_LIMIT.toFixed(5) +
        " slots/item=" + bfSlotsPerItem.toFixed(4) + " bits/item=" + bfBitsPerItem.toFixed(3) +
        " buildThrew=" + bfBuildThrew + " mutThrew=" + bfMutThrew +
        " restoreOk=" + bfRestoreOk +
        " | snapChk=" + (snapChkOk ? "ok" : "FAIL") +
        " clearReuse=" + sameBuffer +
        " | " + (ok ? "ok" : "FAIL") + "\n");

    if (!ok) {
        for (const v of report.violations) {
            process.stderr.write(
                "  violation " + v.metric + " limit=" + v.limit + " actual=" + v.actual + "\n");
        }
        for (const f of findings) process.stderr.write("  finding " + f.kind + ":" + f.reason + "\n");
        for (const l of leaks) process.stderr.write("  leak " + l + "\n");
        if (live !== 0)
            process.stderr.write("  RETENTION: " + live +
                " tracked object(s) outlived their owner -- tracker.size() did not return to 0\n");
        if (sabotageFn > 0)
            process.stderr.write("  SABOTAGE: " + sabotageFn +
                " FALSE NEGATIVE(s) on a corrupted store -- the one-sided guarantee is void\n");
        if (!trackedOk)
            process.stderr.write("  phase-1 liveness: tracked " + tracked + " != expected " +
                EXPECTED_TRACKED + " -- a retention loop stopped tracking (would falsely PASS)\n");
        if (strFn > 0)
            process.stderr.write("  STRING lane FALSE NEGATIVE " + strFn +
                " -- the string hot path read an added key false\n");
        if (cbfLaw1.falseNegatives > 0)
            process.stderr.write("  CountingBloom FALSE NEGATIVE on the 1e6-add law -- one-sided guarantee void\n");
        if (!cbfRemovesOk)
            process.stderr.write("  CountingBloom churn removes=" + churn.removes +
                " <= 20000 -- the delete path did not run hard enough (vacuous churn)\n");
        if (!sameBuffer) process.stderr.write("  clear() reallocated the bit store\n");
        if (law1.falseNegatives + law2.falseNegatives + churn.falseNegatives +
            bbLaw1.falseNegatives + bbLaw2.falseNegatives +
            cfLaw1.falseNegatives + cfLaw2.falseNegatives + cfChurn.falseNegatives > 0)
            process.stderr.write("  FALSE NEGATIVE -- the one-sided guarantee is void\n");
        if (churn.present !== churn.filterSize)
            process.stderr.write("  CBF size " + churn.filterSize + " != present " + churn.present + "\n");
        if (cfChurn.present !== cfChurn.filterSize)
            process.stderr.write("  Cuckoo size " + cfChurn.filterSize + " != present " + cfChurn.present + "\n");
        if (cfLaw2.fpr > CF_FPR_LIMIT)
            process.stderr.write("  Cuckoo FPR " + cfLaw2.fpr.toFixed(5) + " over limit " + CF_FPR_LIMIT + "\n");
        if (!cfOverload)
            process.stderr.write("  Cuckoo overload did NOT throw -- fail-closed door broken (decisions/0014)\n");
        if (cfOverloadFn > 0)
            process.stderr.write("  Cuckoo overload DROPPED " + cfOverloadFn +
                " already-added key(s) -- FALSE NEGATIVE on overflow (decisions/0014)\n");
        if (!cfOverloadNoop)
            process.stderr.write("  Cuckoo thrown add was NOT a byte-identical no-op -- the eviction chain did not unwind\n");
        if (!cfLoadOk)
            process.stderr.write("  Cuckoo could not reach 90% load (fn=" + cfLoadFn + ", load=" +
                cfLoadFrac.toFixed(3) + ") -- degraded kick-slot pick (decisions/0014)\n");
        if (qfLaw1.falseNegatives + qfLaw2.falseNegatives + qfChurn.falseNegatives > 0)
            process.stderr.write("  Quotient FALSE NEGATIVE -- the one-sided guarantee is void\n");
        if (qfChurn.present !== qfChurn.filterSize)
            process.stderr.write("  Quotient size " + qfChurn.filterSize + " != present " + qfChurn.present + "\n");
        if (qfLaw2.fpr > QF_FPR_LIMIT)
            process.stderr.write("  Quotient FPR " + qfLaw2.fpr.toFixed(5) + " over limit " + QF_FPR_LIMIT + "\n");
        if (!qfResizeOk)
            process.stderr.write("  Quotient resize round-trip broke membership/size (grow fn=" +
                qfGrow.falseNegatives + " shrink fn=" + qfShrink.falseNegatives + ")\n");
        if (!qfMergeOk)
            process.stderr.write("  Quotient merge round-trip broke membership/size (fn=" +
                qfMerge.falseNegatives + " size=" + qfMerge.mergedSize + "/" + qfMerge.expectedSize + ")\n");
        if (!qfCeilingThrew)
            process.stderr.write("  Quotient ceiling did NOT throw -- fail-closed door broken (decisions/0016)\n");
        if (qfCeilingFn > 0)
            process.stderr.write("  Quotient ceiling DROPPED " + qfCeilingFn +
                " already-added key(s) -- FALSE NEGATIVE on overload (decisions/0016)\n");
        if (!qfCeilingNoop)
            process.stderr.write("  Quotient thrown add was NOT a byte-identical no-op\n");
        if (xfFn > 0)
            process.stderr.write("  XOR FALSE NEGATIVE -- a peeled key read false; the peel was INCOMPLETE (fail-open!) (decisions/0018)\n");
        if (xfLaw2.fpr > XF_FPR_LIMIT)
            process.stderr.write("  XOR FPR " + xfLaw2.fpr.toFixed(5) + " over ceiling " + XF_FPR_LIMIT + "\n");
        if (!(xfLaw2.fpr > 0))
            process.stderr.write("  XOR FPR is 0 -- vacuous (the query never matches a non-member; structure broken)\n");
        if (!xfBuildThrew)
            process.stderr.write("  XOR degenerate build did NOT throw -- the 100-attempt exhaustion door is broken (decisions/0018)\n");
        if (!xfMutThrew)
            process.stderr.write("  XOR mutation (add/remove/clear/new) did NOT throw fail-closed (decisions/0019)\n");
        if (bfFn > 0)
            process.stderr.write("  BinaryFuse FALSE NEGATIVE -- a peeled key read false; the peel was INCOMPLETE (fail-open!) (decisions/0022)\n");
        if (!(bfSlotsRound >= BF_SLOTS_LO && bfSlotsRound <= BF_SLOTS_HI))
            process.stderr.write("  BinaryFuse slots/item " + bfSlotsPerItem.toFixed(4) +
                " outside [" + BF_SLOTS_LO + ", " + BF_SLOTS_HI + "] (2dp) (decisions/0022)\n");
        if (bfBitsPerItem > BF_BITS_LIMIT)
            process.stderr.write("  BinaryFuse bits/item " + bfBitsPerItem.toFixed(3) +
                " over ceiling " + BF_BITS_LIMIT + " -- not leaner than XOR (decisions/0022)\n");
        if (bfLaw2.fpr > BF_FPR_LIMIT)
            process.stderr.write("  BinaryFuse FPR " + bfLaw2.fpr.toFixed(5) + " over ceiling " + BF_FPR_LIMIT + "\n");
        if (!(bfLaw2.fpr > 0))
            process.stderr.write("  BinaryFuse FPR is 0 -- vacuous (the query never matches a non-member; structure broken)\n");
        if (!bfBuildThrew)
            process.stderr.write("  BinaryFuse degenerate build did NOT throw -- the 100-attempt exhaustion door is broken (decisions/0022)\n");
        if (!bfMutThrew)
            process.stderr.write("  BinaryFuse mutation (add/remove/clear/new) did NOT throw fail-closed (decisions/0022)\n");
        if (!bfRestoreOk)
            process.stderr.write("  BinaryFuse restore did NOT reject an inconsistent geometry / chk flip -- fail-open door broken (decisions/0021, 0022)\n");
        if (!snapChkOk)
            process.stderr.write("  SNAPSHOT CHECKSUM: a keys-mode / store-bit flip was NOT rejected -- the fail-open door is broken (decisions/0021)\n");
        if (law2.fpr > FPR_LIMIT)
            process.stderr.write("  FPR " + law2.fpr.toFixed(5) + " over limit " + FPR_LIMIT + "\n");
        if (bbLaw2.fpr > BB_FPR_LIMIT)
            process.stderr.write("  BB FPR " + bbLaw2.fpr.toFixed(5) + " over ceiling " + BB_FPR_LIMIT + "\n");
        if (!(bbLaw2.fpr > BB_THEORY_FLOOR))
            process.stderr.write("  BB FPR " + bbLaw2.fpr.toFixed(5) +
                " NOT over plain-Bloom theory " + BB_THEORY_FLOOR +
                " -- the locality penalty is not visible (check h1/h2 independence)\n");
        process.stderr.write("  replay: TORTURE_SEED=" + SEED + " node --expose-gc test/torture.mjs\n");
        process.exit(1);
    }

    // Reaching here in BREAK mode means the phase-2 control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write(
            "torture: FAIL -- LFILTER_TORTURE_BREAK set but the gate still passed\n");
        process.exit(1);
    }

    process.stdout.write("ok\n");
    process.exit(0);
}

main().catch((e) => {
    // A throw anywhere in the gate is a FAIL, not a crash-with-clean-stdout that could be
    // mistaken for a pass: print the error to stderr and exit nonzero with stdout untouched.
    process.stderr.write("torture: FAIL -- " + ((e && e.stack) || String(e)) + "\n");
    process.exit(1);
});
