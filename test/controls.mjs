/**
 * @zakkster/lite-filter -- standalone control driver (the must-fail proof).
 *
 * Every gate must be provably able to fail. This entry drives the torture BREAK
 * control out-of-process and asserts BOTH directions of the invariant:
 *
 *   - a CLEAN run (`node --expose-gc test/torture.mjs`) prints exactly "ok" on
 *     stdout and exits 0;
 *   - the BREAK run (`LFILTER_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`)
 *     injects a retained allocation into the phase-2 hot loop, so the GC gate
 *     rejects the window, the run exits NON-zero, and it never prints "ok".
 *
 * A suite that always fails is as useless as one that never does; both arms are
 * required. This entry prints exactly "ok" and exits 0 when EVERY control behaved
 * as designed, and exits non-zero otherwise.
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from "node:child_process";

const ENTRY = new URL("./torture.mjs", import.meta.url).pathname;

function runWith(breakOn) {
    const env = Object.assign({}, process.env);
    if (breakOn) env.LFILTER_TORTURE_BREAK = "1";
    else delete env.LFILTER_TORTURE_BREAK;
    const res = spawnSync(process.execPath, ["--expose-gc", ENTRY], { env, encoding: "utf8" });
    return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function fail(msg) {
    process.stderr.write("controls: FAIL -- " + msg + "\n");
    process.exit(1);
}

// 1. The clean run must pass. If it does not, the BREAK arm is meaningless.
{
    const r = runWith(false);
    if (r.code !== 0) fail("clean run exited " + r.code + " (expected 0)\n" + r.stderr);
    if (r.stdout.trim() !== "ok") fail("clean run stdout was " + JSON.stringify(r.stdout) + ", expected exactly \"ok\"");
}

// 2. The BREAK run must exit non-zero and must NOT print "ok".
{
    const r = runWith(true);
    if (r.code === 0) fail("LFILTER_TORTURE_BREAK=1 still exited 0 -- the phase-2 gate is decorative");
    if (r.stdout.trim() === "ok") fail("LFILTER_TORTURE_BREAK=1 printed \"ok\" on a failing run");
}

process.stdout.write("ok\n");
