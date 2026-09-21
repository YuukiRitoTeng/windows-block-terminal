// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keyboard regression guard for the layout keys.
 *
 * The Snap Bar round must not cost anyone their existing split or pane-navigation shortcuts, so these
 * assertions read the key map directly and pin each binding to the action it performs. They are
 * intentionally structural: renaming an action is fine, silently dropping a key is not.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { assert, beforeAll, describe, test } from "vitest";

let keymodelSource: string;

/** The body of one `globalKeyMap.set("<key>", ...)` binding, with nested braces handled. */
function bindingBody(key: string): string {
    const marker = `globalKeyMap.set("${key}",`;
    const start = keymodelSource.indexOf(marker);
    assert.isAtLeast(start, 0, `keymodel must still bind ${key}`);
    let index = keymodelSource.indexOf("{", start);
    assert.isAtLeast(index, 0, `${key} binding has no body`);
    let depth = 0;
    const bodyStart = index;
    for (; index < keymodelSource.length; index++) {
        const char = keymodelSource[index];
        if (char === "{") depth += 1;
        if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                return keymodelSource.slice(bodyStart, index + 1);
            }
        }
    }
    throw new Error(`unbalanced body for ${key}`);
}

describe("layout keyboard shortcuts are preserved", () => {
    beforeAll(async () => {
        keymodelSource = await readFile(join(process.cwd(), "frontend/app/store/keymodel.ts"), "utf-8");
    });

    test("the split shortcuts still exist and still split", () => {
        assert.match(bindingBody("Cmd:d"), /handleSplitHorizontal\("after"\)/, "Cmd:d must split horizontally");
        assert.match(bindingBody("Shift:Cmd:d"), /handleSplitVertical\("after"\)/, "Shift:Cmd:d must split vertically");
    });

    test("the split handlers still create blocks next to the focused pane", () => {
        assert.match(keymodelSource, /createBlockSplitHorizontally\(/);
        assert.match(keymodelSource, /createBlockSplitVertically\(/);
        assert.match(keymodelSource, /layoutModel\.focusedNode/, "splitting must still use the focused pane");
    });

    for (const [key, direction] of [
        ["Ctrl:Shift:ArrowUp", "Up"],
        ["Ctrl:Shift:ArrowDown", "Down"],
        ["Ctrl:Shift:ArrowLeft", "Left"],
        ["Ctrl:Shift:ArrowRight", "Right"],
    ] as const) {
        test(`${key} still moves focus ${direction}`, () => {
            assert.match(bindingBody(key), new RegExp(`switchBlockInDirection\\(NavigateDirection\\.${direction}\\)`));
        });
    }

    for (const [key, direction] of [
        ["Ctrl:Shift:h", "Left"],
        ["Ctrl:Shift:j", "Down"],
        ["Ctrl:Shift:k", "Up"],
        ["Ctrl:Shift:l", "Right"],
    ] as const) {
        test(`${key} still moves focus ${direction}`, () => {
            assert.match(bindingBody(key), new RegExp(`switchBlockInDirection\\(NavigateDirection\\.${direction}\\)`));
        });
    }

    test("tab and block creation shortcuts are untouched", () => {
        assert.match(bindingBody("Cmd:t"), /createTab\(\)/);
        assert.match(bindingBody("Cmd:m"), /magnifyNodeToggle/);
        assert.match(bindingBody("Cmd:w"), /genericClose\(\)/);
    });

    test("the Split shortcuts are also registered for the terminal key handler path", () => {
        // The terminal swallows keys unless the app declares them; the split keys must stay declared
        // or they would stop working while a terminal has focus.
        const declared = keymodelSource.match(/allKeys\.push\([\s\S]*?\);/);
        assert.isNotNull(declared, "keymodel must still declare the keys the terminal should not swallow");
        assert.match(keymodelSource, /Cmd:d/, "splitting must remain reachable from a focused terminal");
    });
});
