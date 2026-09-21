// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-input, end to end: the switch, the panes, and the terminal's own user-input path.
 *
 * The pieces here are real: the switch rule the Ctrl+Shift+i handler applies, the seam over a real
 * xterm terminal, the terminal's own paste path, and the broadcast loop the terminal model calls. Only
 * the panes' controllers are doubles, because they talk to the back end.
 *
 * The case that was missing is "a terminal created after the switch was turned on": a terminal setting,
 * font size or connection change re-creates the terminal wrapper, and the switch used to be baked into
 * the wrapper when it was armed - so the new wrapper stayed silent while the mode still read on, and
 * typing went nowhere.
 */

import { armMultiInputBroadcast, broadcastToOtherPanes, MultiInputToggleKey, nextMultiInputState } from "@/app/view/term/multi-input";
import { installUserInputSeam } from "@/app/view/term/user-input-source";
import { Terminal } from "@xterm/xterm";
import { readFile } from "fs/promises";
import { join } from "path";
import { afterEach, assert, beforeAll, describe, test } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The vendored terminal's own paste function: the code the bundled terminal is built from. */
const clipboardModule = "@xterm/xterm/src/browser/Clipboard";
let pasteIntoTerminal: (text: string, textarea: { value: string }, coreService: any, optionsService: any) => void;
beforeAll(async () => {
    pasteIntoTerminal = ((await import(clipboardModule)) as any).paste;
});

/** A pane as the broadcast loop sees it: a terminal that can be typed into, with a controller. */
function makePane(name: string, options: { basic?: boolean } = {}) {
    const received: string[] = [];
    return {
        name,
        received,
        isBasicTerm: () => options.basic ?? true,
        sendUserInputToController(data: string) {
            received.push(data);
        },
    };
}

/** The switch the Ctrl+Shift+i handler writes and every broadcast reads. */
function makeSwitch(initial = false) {
    let on = initial;
    return {
        isOn: () => on,
        toggle: (basicTermCount: number) => {
            on = nextMultiInputState(on, basicTermCount);
            return on;
        },
    };
}

describe("multi-input: the switch", () => {
    test("the toggle is Ctrl+Shift+i", () => {
        assert.strictEqual(MultiInputToggleKey, "Ctrl:Shift:i");
    });

    test("it turns on with two or more basic terminals, and off again", () => {
        assert.isTrue(nextMultiInputState(false, 2), "two terminals can be typed into at once");
        assert.isTrue(nextMultiInputState(false, 5));
        assert.isFalse(nextMultiInputState(true, 2), "pressing it again turns multi-input off");
        assert.isFalse(nextMultiInputState(true, 5));
    });

    test("it refuses to turn on with fewer than two basic terminals", () => {
        assert.isFalse(nextMultiInputState(false, 1), "one terminal has nothing to broadcast to");
        assert.isFalse(nextMultiInputState(false, 0));
    });
});

describe("multi-input: from the user's keyboard to the other pane", () => {
    let terminals: Terminal[] = [];

    afterEach(() => {
        terminals.forEach((terminal) => terminal.dispose());
        terminals = [];
    });

    /**
     * Two panes in one tab, each with a real terminal and the real seam, wired exactly as the terminal
     * view and the terminal model wire them: the seam reports the terminal's user input to the wrapper,
     * and the wrapper - armed once, reading the switch - decides where it goes.
     */
    function makeTab(options: { basic?: boolean } = {}) {
        const switchState = makeSwitch(false);
        const left = makePane("left", options);
        const right = makePane("right", options);
        const panes = [left, right];
        const makeTerminal = (pane: ReturnType<typeof makePane>) => {
            const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
            terminals.push(terminal);
            const wrap: { multiInputCallback: ((data: string) => void) | null } = { multiInputCallback: null };
            const detach = armMultiInputBroadcast({
                terminal: wrap,
                isOn: switchState.isOn,
                isBasicTerm: () => pane.isBasicTerm(),
                broadcast: (data) => broadcastToOtherPanes(panes, pane, () => undefined, data),
            });
            const seam = installUserInputSeam(terminal, (data) => wrap.multiInputCallback?.(data));
            return { terminal, wrap, seam, detach };
        };
        const leftSide = makeTerminal(left);
        const rightSide = makeTerminal(right);
        return {
            switchState,
            panes,
            left,
            right,
            terminal: leftSide.terminal,
            wrap: leftSide.wrap,
            rightTerminal: rightSide.terminal,
            coreService: (leftSide.terminal as any)._core.coreService,
        };
    }

    test("the seam is what reports the input, and the wrapper is what broadcasts it", () => {
        const tab = makeTab();
        assert.isTrue(tab.switchState.toggle(tab.panes.length));

        tab.terminal.input("a", true);
        assert.deepEqual(tab.right.received, ["a"], "the seam reached the armed wrapper");

        tab.wrap.multiInputCallback = null; // an unarmed wrapper, as a terminal without multi-input has
        tab.terminal.input("b", true);
        assert.deepEqual(tab.right.received, ["a"], "nothing broadcasts without the wrapper's callback");
    });

    test("typing in the left pane reaches the right pane once multi-input is on", () => {
        const tab = makeTab();
        assert.isTrue(tab.switchState.toggle(tab.panes.length), "the switch is on");

        // a key press, and a paste - the terminal's own user-input paths
        tab.terminal.input("a", true);
        pasteIntoTerminal("bc", { value: "" }, tab.coreService, { rawOptions: { ignoreBracketedPasteMode: false } });

        assert.deepEqual(tab.left.received, [], "the pane that was typed in is not typed into again");
        assert.deepEqual(tab.right.received, ["a", "bc"], "the other pane receives the input");
    });

    test("with the switch off, typing stays in the pane that was typed in", () => {
        const tab = makeTab();

        tab.terminal.input("a", true);
        pasteIntoTerminal("bc", { value: "" }, tab.coreService, { rawOptions: { ignoreBracketedPasteMode: false } });

        assert.deepEqual(tab.right.received, [], "nothing is broadcast while multi-input is off");
        assert.deepEqual(tab.left.received, []);
    });

    test("the switch is read when the user types, not when multi-input was turned on", () => {
        const tab = makeTab();

        tab.terminal.input("before", true);
        tab.switchState.toggle(tab.panes.length); // on
        tab.terminal.input("during", true);
        tab.switchState.toggle(tab.panes.length); // off
        tab.terminal.input("after", true);

        assert.deepEqual(tab.right.received, ["during"], "only what was typed while the switch was on");
    });

    test("a program's query answers are still never broadcast", async () => {
        const tab = makeTab();
        tab.switchState.toggle(tab.panes.length);

        tab.terminal.write("\x1b[c"); // device attributes
        tab.terminal.write("\x1b[6n"); // cursor position
        await wait(100);

        assert.deepEqual(tab.right.received, [], "the terminal's own answers stay out of multi-input");
    });
});

describe("multi-input: a terminal created after the switch was turned on", () => {
    test("a re-created wrapper still broadcasts", () => {
        const switchState = makeSwitch(true); // multi-input is already on
        const left = makePane("left");
        const right = makePane("right");
        const panes = [left, right];
        const arm = (terminal: { multiInputCallback: ((data: string) => void) | null }) =>
            armMultiInputBroadcast({
                terminal,
                isOn: switchState.isOn,
                isBasicTerm: () => true,
                broadcast: (data) => broadcastToOtherPanes(panes, left, () => undefined, data),
            });

        const first: { multiInputCallback: ((data: string) => void) | null } = { multiInputCallback: null };
        const detach = arm(first);
        first.multiInputCallback?.("one");
        assert.deepEqual(right.received, ["one"], "the first wrapper broadcasts");

        // the wrapper is thrown away and rebuilt, as a terminal setting change does
        detach();
        const second: { multiInputCallback: ((data: string) => void) | null } = { multiInputCallback: null };
        arm(second);
        assert.isNotNull(second.multiInputCallback, "the new wrapper is armed as well");

        second.multiInputCallback?.("two");
        assert.deepEqual(right.received, ["one", "two"], "and it broadcasts too");
    });

    test("detaching one arming leaves a newer one alone", () => {
        const switchState = makeSwitch(true);
        const terminal: { multiInputCallback: ((data: string) => void) | null } = { multiInputCallback: null };
        const arm = () =>
            armMultiInputBroadcast({
                terminal,
                isOn: switchState.isOn,
                isBasicTerm: () => true,
                broadcast: () => {},
            });

        const detachFirst = arm();
        const detachSecond = arm();
        detachFirst();
        assert.isNotNull(terminal.multiInputCallback, "the newer arming survives the older detach");
        detachSecond();
        assert.isNull(terminal.multiInputCallback);
    });

    test("a pane that is not a basic terminal neither broadcasts nor is typed into", () => {
        const switchState = makeSwitch(true);
        const cmdPane = makePane("cmd-pane", { basic: false });
        const basicPane = makePane("basic-pane");
        const panes = [cmdPane, basicPane];

        const terminal: { multiInputCallback: ((data: string) => void) | null } = { multiInputCallback: null };
        armMultiInputBroadcast({
            terminal,
            isOn: switchState.isOn,
            isBasicTerm: () => cmdPane.isBasicTerm(),
            broadcast: (data) => broadcastToOtherPanes(panes, cmdPane, () => undefined, data),
        });
        terminal.multiInputCallback?.("from-cmd");
        assert.deepEqual(basicPane.received, [], "a cmd pane does not broadcast");

        broadcastToOtherPanes(panes, basicPane, () => undefined, "from-basic");
        assert.deepEqual(cmdPane.received, [], "and it is not typed into either");
    });
});

describe("multi-input: the wiring", () => {
    let term: string;
    let termModel: string;
    let keymodel: string;

    beforeAll(async () => {
        term = await readSource("frontend/app/view/term/term.tsx");
        termModel = await readSource("frontend/app/view/term/term-model.ts");
        keymodel = await readSource("frontend/app/store/keymodel.ts");
    });

    test("the terminal view arms the wrapper it created, and reads the switch live", () => {
        assert.match(
            term,
            /const wrap = termWrapInst;[\s\S]{0,400}?armMultiInputBroadcast\(\{[\s\S]{0,200}?isOn: \(\) => globalStore\.get\(tabModel\.isTermMultiInput\)/,
            "the view must arm the wrapper it created and ask the switch when input is produced"
        );
        assert.match(term, /\}, \[termWrapInst, model, tabModel\]\)/, "re-arming must follow the wrapper");
        assert.notMatch(term, /termRef\.current\.multiInputCallback/, "the callback is not written by hand");
        assert.notMatch(term, /const isMI = /, "the old focus-gated arming must be gone");
        assert.notMatch(term, /isFocused && /, "and so must its focus condition");
    });

    test("the model broadcasts through the shared rule", () => {
        const start = termModel.indexOf("multiInputHandler(data: string)");
        assert.isAtLeast(start, 0, "the model must still broadcast");
        const body = termModel.slice(start, termModel.indexOf("\n    }", start));
        assert.match(body, /broadcastToOtherPanes\(getAllBasicTermModels\(\), this,/, "one shared rule");
        assert.notMatch(body, /for \(const tvm/, "no second copy of the loop");
    });

    test("the Ctrl+Shift+i handler applies the shared switch rule", () => {
        const start = keymodel.indexOf("globalKeyMap.set(MultiInputToggleKey");
        assert.isAtLeast(start, 0, "the toggle must be bound to the shared key");
        const body = keymodel.slice(start, keymodel.indexOf("\n    });", start));
        assert.match(body, /nextMultiInputState\(curMI, countTermBlocks\(\)\)/, "one switch rule");
        assert.notMatch(body, /countTermBlocks\(\) <= 1/, "the refusal is part of the shared rule now");
    });
});
