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
 *                             measured FPR <= 0.0125 (<= 25% over the formula).
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
    const { Bloom } = await import("../Filter.js");
    const { validate } = await import("./validate.mjs");
    const { differentialInt } = await import("./torture/oracle.mjs");

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
            });
            dispose(e); // disposing the owner untracks the filter -> collectable
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

    // The BREAK control: a retained sink the hot loop feeds one fresh object per op,
    // so heapUsed climbs and the major-GC / pause gate rejects the window.
    const sink = BREAK ? [] : null;

    const gc = new GcProfiler().start();
    const heapBefore = process.memoryUsage().heapUsed;
    let acc = 0;
    for (let i = 0; i < HOT; i++) {
        inst.add(i & MASK);
        acc = (acc + (inst.mightContain((i * 2 + 1) & MASK) ? 1 : 0)) | 0;
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

    // clear() must reuse the SAME ArrayBuffer (zero-alloc reset).
    inst.clear();
    const sameBuffer = inst._words.buffer === bufBefore;
    validate(inst);

    const allocPerOp = Math.max(0, Math.round((heapAfter - heapBefore) / HOT));

    // ---- phase 3: differential Set oracle ------------------------------------
    // Law 1: 1e6 adds then requery -- exactly 0 false negatives.
    const law1 = differentialInt(Bloom, { n: 1000000, fpp: 0.01, probes: 1, seed: SEED });
    // Law 2: n=1e5, fpp=0.01, 1e6 disjoint probes -- FPR <= 0.0125 (<= 25% over formula).
    const law2 = differentialInt(Bloom, { n: 100000, fpp: 0.01, probes: 1000000, seed: SEED ^ 0x55 });
    const FPR_LIMIT = 0.0125;

    // ---- verdict --------------------------------------------------------------
    const oracleOk =
        law1.falseNegatives === 0 &&
        law2.falseNegatives === 0 &&
        law2.fpr <= FPR_LIMIT;
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
        if (law1.falseNegatives + law2.falseNegatives > 0)
            process.stderr.write("  FALSE NEGATIVE -- the one-sided guarantee is void\n");
        if (law2.fpr > FPR_LIMIT)
            process.stderr.write("  FPR " + law2.fpr.toFixed(5) + " over limit " + FPR_LIMIT + "\n");
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
