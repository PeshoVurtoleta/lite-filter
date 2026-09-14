/**
 * @zakkster/lite-filter -- source-hygiene gate (suite law).
 *
 * The shipped source must be ASCII-only (U+00D7 and U+00B5 excepted) and must carry
 * no stray tool-call tags. This test is the teeth: a non-ASCII byte or a leaked tag
 * fails the boundary suite, not a human eyeball.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FILES = ["../Filter.js", "../Filter.d.ts"];
const ALLOWED = new Set([0x00d7, 0x00b5]); // x (multiply) and micro

test("source is ASCII-only (U+00D7 and U+00B5 excepted)", () => {
    for (const rel of FILES) {
        const path = new URL(rel, import.meta.url).pathname;
        const text = readFileSync(path, "utf8");
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c > 0x7f && !ALLOWED.has(c)) {
                assert.fail(rel + " has non-ASCII U+" + c.toString(16) + " at index " + i);
            }
        }
    }
});

test("source carries no stray tool-call tags", () => {
    for (const rel of FILES) {
        const path = new URL(rel, import.meta.url).pathname;
        const text = readFileSync(path, "utf8");
        assert.equal(text.includes("antml:"), false, rel + " has a stray tool-call tag");
        assert.equal(text.includes("function_calls"), false, rel + " has a stray tool-call tag");
    }
});
