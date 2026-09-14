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
    for (const pkg of ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]) {
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
    const { Bloom, CountingBloom, BlockedBloom, Cuckoo } = await import("../Filter.js");
    const { validate, validateCounting, validateBlocked, validateCuckoo } = await import("./validate.mjs");
    const { differentialInt, differentialChurnInt } = await import("./torture/oracle.mjs");

    const SEED = (process.env.TORTURE_SEED >>> 0) || 0x1f2e3d4c;
    const BREAK = process.env.LFILTER_TORTURE_BREAK === "1";

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
                tracker.track(f, () => {}, "bloom", { audit: true });
                // CountingBloom holds only a Uint8Array -- same retention shape. Churn
                // it through the SAME owner scope so a leak here surfaces too.
                const g = new CountingBloom(1024, { keys: "int" });
                g.add(i | 0);
                g.remove(i | 0);
                tracker.track(g, () => {}, "counting-bloom", { audit: true });
                // BlockedBloom holds only a Uint32Array -- same retention shape as Bloom.
                // Churn it through the SAME owner scope so a leak here surfaces too.
                const h = new BlockedBloom(1024, { keys: "int" });
                h.add(i | 0);
                h.mightContain(i | 0);
                tracker.track(h, () => {}, "blocked-bloom", { audit: true });
                // Cuckoo holds only a Uint8Array|Uint16Array -- same retention shape.
                // Churn it through the SAME owner scope so a leak here surfaces too.
                const c = new Cuckoo(1024, { keys: "int" });
                c.add(i | 0);
                c.mightContain(i | 0);
                c.remove(i | 0);
                tracker.track(c, () => {}, "cuckoo", { audit: true });
            });
            dispose(e); // disposing the owner untracks the filters -> collectable
        }
    });
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 50));
    const live = tracker.size();
    const findings = tracker.audit();

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

    // clear() must reuse the SAME ArrayBuffer (zero-alloc reset) for both members.
    inst.clear();
    cinst.clear();
    binst.clear();
    kinst.clear();
    const sameBuffer = inst._words.buffer === bufBefore &&
        cinst._cnts.buffer === cbufBefore &&
        binst._words.buffer === bbufBefore &&
        kinst._store.buffer === kbufBefore;
    validate(inst);
    validateCounting(cinst);
    validateBlocked(binst);
    validateCuckoo(kinst);

    const allocPerOp = Math.max(0, Math.round((heapAfter - heapBefore) / HOT));

    // ---- phase 3: differential Set oracle ------------------------------------
    // Law 1: 1e6 adds then requery -- exactly 0 false negatives.
    const law1 = differentialInt(Bloom, { n: 1000000, fpp: 0.01, probes: 1, seed: SEED });
    // Law 2: n=1e5, fpp=0.01, 1e6 disjoint probes -- FPR <= 0.0125 (<= 25% over formula).
    const law2 = differentialInt(Bloom, { n: 100000, fpp: 0.01, probes: 1000000, seed: SEED ^ 0x55 });
    const FPR_LIMIT = 0.0125;
    // Law 3 (CountingBloom): 1e5 mixed add/remove ops mirrored against a Set -- 0 false
    // negatives for keys CURRENTLY present, and the net count tracks the present-set.
    const churn = differentialChurnInt(CountingBloom,
        { n: 20000, fpp: 0.01, ops: 100000, seed: SEED ^ 0xa5 });

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

    // ---- verdict --------------------------------------------------------------
    const oracleOk =
        law1.falseNegatives === 0 &&
        law2.falseNegatives === 0 &&
        law2.fpr <= FPR_LIMIT &&
        churn.falseNegatives === 0 &&
        churn.present === churn.filterSize &&
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
        cfLoadOk === true;
    const ok =
        report.ok &&
        live === 0 &&
        leaks.length === 0 &&
        findings.length === 0 &&
        sameBuffer &&
        oracleOk;

    process.stderr.write(
        "GATE leak=size " + live + "/0 findings=" + findings.length +
        " warnings=" + warns.length +
        " | gc major=" + s.gc.major + " minor=" + s.gc.minor +
        " maxMs=" + s.gc.maxMs.toFixed(2) +
        " | alloc=" + allocPerOp + " B/op" +
        " | oracle fn=" + (law1.falseNegatives + law2.falseNegatives) +
        " fpr=" + law2.fpr.toFixed(5) + " target=" + law2.target.toFixed(5) +
        " over=" + (((law2.fpr - law2.target) / law2.target) * 100).toFixed(1) + "%" +
        " | cbf churn fn=" + churn.falseNegatives +
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
        " clearReuse=" + sameBuffer +
        " | " + (ok ? "ok" : "FAIL") + "\n");

    if (!ok) {
        for (const v of report.violations) {
            process.stderr.write(
                "  violation " + v.metric + " limit=" + v.limit + " actual=" + v.actual + "\n");
        }
        for (const f of findings) process.stderr.write("  finding " + f.kind + ":" + f.reason + "\n");
        for (const l of leaks) process.stderr.write("  leak " + l + "\n");
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

main();
