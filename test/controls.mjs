/**
 * @zakkster/lite-filter -- standalone control driver (the must-fail proof).
 *
 * Every gate must be provably able to fail. This entry drives the torture control arms
 * out-of-process and asserts BOTH directions of each invariant. A nonzero exit alone is
 * NOT enough -- each failing arm must fail for its OWN reason, matched on the SPECIFIC
 * stderr violation text, so a single unrelated breakage cannot masquerade as all three:
 *
 *   - a CLEAN run (`node --expose-gc test/torture.mjs`) prints exactly "ok" on stdout,
 *     exits 0, and emits no violation text;
 *   - the BREAK arm (LFILTER_TORTURE_BREAK=1) feeds a retained object into the phase-2
 *     hot loop, so the GC gate rejects the window: exit != 0, no "ok", stderr carries a
 *     `violation gc.major` line (the alloc budget was blown);
 *   - the LEAK arm (LFILTER_TORTURE_LEAK=1) plants a retained-but-tracked object in
 *     phase 1, so tracker.size() cannot return to 0: exit != 0, no "ok", stderr carries a
 *     `RETENTION:` line;
 *   - the SABOTAGE arm (LFILTER_TORTURE_SABOTAGE=1) wipes a built filter's store, so an
 *     added key reads false: exit != 0, no "ok", stderr carries a `SABOTAGE:` line.
 *
 * A suite that always fails is as useless as one that never does; every arm is required.
 * This entry prints exactly "ok" and exits 0 when EVERY control behaved as designed.
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from "node:child_process";

const ENTRY = new URL("./torture.mjs", import.meta.url).pathname;

function runWith(envVar) {
    const env = Object.assign({}, process.env);
    delete env.LFILTER_TORTURE_BREAK;
    delete env.LFILTER_TORTURE_LEAK;
    delete env.LFILTER_TORTURE_SABOTAGE;
    if (envVar) env[envVar] = "1";
    const res = spawnSync(process.execPath, ["--expose-gc", ENTRY], { env, encoding: "utf8" });
    return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function fail(msg) {
    process.stderr.write("controls: FAIL -- " + msg + "\n");
    process.exit(1);
}

// 1. The clean run must pass. If it does not, every break arm is meaningless.
{
    const r = runWith(null);
    if (r.code !== 0) fail("clean run exited " + r.code + " (expected 0)\n" + r.stderr);
    if (r.stdout.trim() !== "ok") fail("clean run stdout was " + JSON.stringify(r.stdout) + ", expected exactly \"ok\"");
    if (/\bviolation\b|RETENTION:|SABOTAGE:/.test(r.stderr))
        fail("clean run emitted a violation line -- a gate is tripping without a control set\n" + r.stderr);
}

// Each break arm: exit != 0, no "ok", and the SPECIFIC violation text present.
const arms = [
    { env: "LFILTER_TORTURE_BREAK", label: "alloc/GC gate", rx: /violation gc\.major/ },
    { env: "LFILTER_TORTURE_LEAK", label: "retention gate", rx: /RETENTION:/ },
    { env: "LFILTER_TORTURE_SABOTAGE", label: "false-negative gate", rx: /SABOTAGE:/ },
];

for (const arm of arms) {
    const r = runWith(arm.env);
    if (r.code === 0) fail(arm.env + "=1 still exited 0 -- the " + arm.label + " is decorative");
    if (r.stdout.trim() === "ok") fail(arm.env + "=1 printed \"ok\" on a failing run");
    if (!arm.rx.test(r.stderr))
        fail(arm.env + "=1 exited nonzero but its stderr did NOT carry the expected " +
            arm.label + " text " + String(arm.rx) + " -- it may be failing for the wrong reason\n" + r.stderr);
}

process.stdout.write("ok\n");
