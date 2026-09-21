// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What may be broadcast as multi-input, and what may mark a pane as used.
 *
 * xterm delivers user input and its own protocol answers through the same `onData` event, so the two
 * are told apart at the one place every emission passes through: `CoreService.triggerDataEvent(data,
 * wasUserInput)`. xterm sets that flag for input it classifies as the user's - a key press, a paste,
 * text committed by an input method, `Terminal.input()` - and leaves it unset for the answers it
 * generates for the program (device attributes, cursor position, colours).
 *
 * The flag, and not the task an event arrives in, has to be the source of truth, because the
 * composition path is asynchronous: `CompositionHelper.compositionend()` defers its emission through
 * `setTimeout(..., 0)`, so an IME commit reaches `onData` a macrotask after the composition event.
 * These tests measure that against the vendored xterm sources the bundled terminal is built from, and
 * then drive the real terminal and the real seam, so a change in any of it fails here.
 */

import { installUserInputSeam } from "@/app/view/term/user-input-source";
import { Terminal } from "@xterm/xterm";
import { readFile } from "fs/promises";
import { join } from "path";
import { afterEach, assert, beforeAll, describe, test } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The vendored xterm sources: the code the bundled terminal is built from, with the class names still
 * visible. The specifiers are not literals so that TypeScript leaves these sources out of the
 * project's type-check program; Vite still resolves and compiles them at run time.
 */
const compositionHelperModule = "@xterm/xterm/src/browser/input/CompositionHelper";
const clipboardModule = "@xterm/xterm/src/browser/Clipboard";

type CompositionHelperLike = {
    compositionstart(): void;
    compositionupdate(ev: { data: string }): void;
    compositionend(): void;
};
type PasteFunction = (
    text: string,
    textarea: { value: string },
    coreService: CoreService,
    optionsService: { rawOptions: { ignoreBracketedPasteMode: boolean } }
) => void;
type CoreService = { triggerDataEvent(data: string, wasUserInput?: boolean): void };

let compositionHelperCtor: new (
    textarea: unknown,
    compositionView: unknown,
    bufferService: unknown,
    optionsService: unknown,
    coreService: CoreService,
    renderService: unknown
) => CompositionHelperLike;
let pasteIntoTerminal: PasteFunction;

beforeAll(async () => {
    compositionHelperCtor = ((await import(compositionHelperModule)) as any).CompositionHelper;
    pasteIntoTerminal = ((await import(clipboardModule)) as any).paste;
});

/** The real terminal, the seam, and the two things the app does with a data event. */
function makeTerminal() {
    const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
    const sent: string[] = [];
    const broadcast: string[] = [];
    const seam = installUserInputSeam(terminal, (data) => broadcast.push(data));
    terminal.onData((data) => sent.push(data)); // what handleTermData does: this pane's controller
    terminals.push(terminal);
    return { terminal, sent, broadcast, seam, coreService: (terminal as any)._core.coreService as CoreService };
}

let terminals: Terminal[] = [];

afterEach(() => {
    terminals.forEach((terminal) => terminal.dispose());
    terminals = [];
});

describe("multi-input: the real composition path", () => {
    /**
     * The real `CompositionHelper`, wired to a real terminal's own core service, so what the test
     * observes is the emission xterm itself produces. Only the objects it writes to are stand-ins.
     */
    function makeComposition(h: ReturnType<typeof makeTerminal>) {
        const textarea = { value: "", style: {} };
        const classes = new Set<string>();
        const view = {
            textContent: "",
            style: {},
            classList: {
                add: (name: string) => classes.add(name),
                remove: (name: string) => classes.delete(name),
            },
        };
        const helper = new compositionHelperCtor(
            textarea,
            view,
            { buffer: { isCursorInViewport: false } },
            {},
            h.coreService,
            {}
        );
        return { helper, textarea, view, composing: () => classes.has("active") };
    }

    test("compositionend emits nothing in its own task: the commit arrives a macrotask later", async () => {
        const h = makeTerminal();
        const { helper, textarea, composing } = makeComposition(h);

        textarea.value = "";
        helper.compositionstart();
        assert.isTrue(composing(), "the composition view is active while an input method is composing");
        // What a browser does between start and end: the textarea receives the composed text.
        textarea.value = "漢";
        helper.compositionupdate({ data: "漢" });
        helper.compositionend();

        assert.isFalse(composing(), "compositionend finalizes the composition");
        assert.isEmpty(h.sent, "xterm defers the commit, so nothing is emitted in the event's own task");
        assert.isEmpty(h.broadcast, "and nothing can be broadcast then either");

        await wait(0);
        assert.deepEqual(h.sent, ["漢"], "the committed text is sent to this pane's controller");
        assert.deepEqual(h.broadcast, ["漢"], "and broadcast as multi-input, a task after the event");
    });

    test("the deferred commit is broadcast even when a protocol answer crosses the channel first", async () => {
        const h = makeTerminal();
        const { helper, textarea } = makeComposition(h);

        helper.compositionstart();
        textarea.value = "漢";
        helper.compositionend();
        // The window between the composition event and its deferred emission, used by a program that
        // asks the terminal who it is.
        h.coreService.triggerDataEvent("\x1b[1;1R");
        h.terminal.write("\x1b[c");

        await wait(50);
        assert.include(h.sent, "\x1b[1;1R", "the answer still reaches this pane's controller");
        assert.deepEqual(h.broadcast, ["漢"], "only the text the user composed is broadcast");
    });
});

describe("multi-input: the real terminal, through the seam", () => {
    test("the seam installs on the terminal this app builds", () => {
        assert.isTrue(makeTerminal().seam.installed);
    });

    test("input the terminal classifies as the user's is broadcast, and still reaches this controller", () => {
        const h = makeTerminal();
        h.terminal.input("a", true);

        assert.deepEqual(h.broadcast, ["a"], "user input must reach the other panes");
        assert.deepEqual(h.sent, ["a"], "and this pane's controller");
    });

    test("input produced later than the event that caused it is still broadcast", async () => {
        const h = makeTerminal();
        setTimeout(() => h.terminal.input("z", true), 0);
        await wait(20);

        assert.deepEqual(h.broadcast, ["z"], "the classification is xterm's, not the timing of an event");
    });

    test("a paste is broadcast, with xterm's own line-ending normalization", () => {
        const h = makeTerminal();
        pasteIntoTerminal("a\nb", { value: "" }, h.coreService, { rawOptions: { ignoreBracketedPasteMode: false } });

        assert.deepEqual(h.broadcast, ["a\rb"], "pasted text is user input and goes to the other panes");
        assert.deepEqual(h.sent, ["a\rb"]);
    });

    test("a program's query answers are never broadcast, and still reach this controller", async () => {
        const h = makeTerminal();

        // A shell that asks the terminal who it is: device attributes and cursor position.
        h.terminal.write("\x1b[c");
        h.terminal.write("\x1b[6n");
        await wait(100);

        assert.isNotEmpty(h.sent, "the answers must still be sent to this pane's controller");
        assert.isEmpty(h.broadcast, "a protocol answer must never be broadcast to the other panes");
        assert.isTrue(
            h.sent.every((data) => data.startsWith("\x1b")),
            "what was sent are the terminal's own answers"
        );
    });

    test("an answer emitted in a later task is still not broadcast", async () => {
        const h = makeTerminal();
        setTimeout(() => h.coreService.triggerDataEvent("\x1b[0n"), 0);
        await wait(20);

        assert.deepEqual(h.sent, ["\x1b[0n"], "it reaches this controller");
        assert.isEmpty(h.broadcast, "being late does not make it user input");
    });

    test("uninstalling the seam stops the broadcast and leaves the terminal delivering data", () => {
        const h = makeTerminal();
        h.seam.uninstall();
        h.terminal.input("q", true);

        assert.deepEqual(h.sent, ["q"], "the terminal keeps sending data");
        assert.isEmpty(h.broadcast, "nothing is reported once the seam is gone");
    });
});

describe("multi-input: the seam itself", () => {
    function fakeCoreService() {
        const forwarded: string[] = [];
        const coreService: CoreService = {
            triggerDataEvent(data: string) {
                forwarded.push(data);
            },
        };
        return { coreService, forwarded };
    }

    const fakeTerminal = (coreService: unknown) => ({ _core: { coreService } });

    test("only what xterm flagged as user input is reported, and every emission is forwarded", () => {
        const { coreService, forwarded } = fakeCoreService();
        const reported: string[] = [];
        const seam = installUserInputSeam(fakeTerminal(coreService) as any, (data) => reported.push(data));

        assert.isTrue(seam.installed);
        coreService.triggerDataEvent("a", true); // a key press, a paste or a commit
        coreService.triggerDataEvent("\x1b[?1;2c"); // device attributes, the terminal answering a program
        coreService.triggerDataEvent("", true); // a flagged emission with nothing in it
        coreService.triggerDataEvent("b"); // the program's own input

        assert.deepEqual(reported, ["a"], "only flagged, non-empty data is user input");
        assert.deepEqual(forwarded, ["a", "\x1b[?1;2c", "", "b"], "every emission still reaches the terminal");
    });

    test("uninstall restores the original method and stops reporting", () => {
        const { coreService, forwarded } = fakeCoreService();
        const original = coreService.triggerDataEvent;
        const reported: string[] = [];
        const seam = installUserInputSeam(fakeTerminal(coreService) as any, (data) => reported.push(data));

        seam.uninstall();
        assert.strictEqual(coreService.triggerDataEvent, original, "the terminal is left as it was found");
        coreService.triggerDataEvent("c", true);

        assert.deepEqual(reported, [], "nothing is reported after the seam is removed");
        assert.deepEqual(forwarded, ["c"], "and data still reaches the terminal");
    });

    test("a terminal that does not expose the seam says so instead of throwing", () => {
        for (const terminal of [undefined, {}, { _core: {} }, { _core: { coreService: {} } }]) {
            const seam = installUserInputSeam(terminal as any, () => {
                throw new Error("nothing may be reported when there is no seam");
            });
            assert.isFalse(seam.installed, `${JSON.stringify(terminal)} must not claim a seam`);
            seam.uninstall();
        }
    });
});

describe("multi-input: the wiring in TermWrap", () => {
    let termwrap: string;

    beforeAll(async () => {
        termwrap = await readSource("frontend/app/view/term/termwrap.ts");
    });

    test("the data channel only sends: it never broadcasts and never reports user input", () => {
        const start = termwrap.indexOf("handleTermData(data: string)");
        const body = termwrap.slice(start, termwrap.indexOf("\n    }", start));
        assert.match(body, /this\.sendDataHandler\?\.\(data\)/, "every data event reaches this controller");
        assert.notMatch(body, /multiInputCallback/, "the broadcast does not belong to the data channel");
        assert.notMatch(body, /reportUserInput/, "and neither does the user-input report");
    });

    test("the seam is the only source of the broadcast, and it reports what it broadcasts", () => {
        assert.match(termwrap, /import \{ installUserInputSeam, UserInputSeam \} from "\.\/user-input-source"/);
        assert.match(
            termwrap,
            /this\.userInputSeam\?\.uninstall\(\);\s*this\.userInputSeam = installUserInputSeam\(this\.terminal, \(data\) => \{\s*this\.reportUserInput\(\);\s*this\.multiInputCallback\?\.\(data\);/,
            "the seam must be replaced when it is installed again, and report and broadcast the same data"
        );
        const broadcasts = termwrap.match(/this\.multiInputCallback\?\.\(/g) ?? [];
        assert.lengthOf(broadcasts, 1, "the seam callback is the one place that broadcasts");
    });

    test("no user input is attributed by task scope any more", () => {
        assert.notMatch(termwrap, /userInputAttribution/i, "the timing-based attribution must be gone");
        assert.notMatch(termwrap, /\.note\(\)/, "nothing may depend on an event's task any more");
    });

    test("key presses report, and composed text reports through the seam", () => {
        assert.match(
            termwrap,
            /terminal\.onKey\(\(\) => this\.reportUserInput\(\)\)/,
            "a key press is user input and must mark the pane"
        );
        const onKey = termwrap.slice(termwrap.indexOf("terminal.onKey("));
        assert.notMatch(onKey.slice(0, 200), /multiInputCallback/, "the key handler does not broadcast by itself");
        assert.notMatch(
            termwrap,
            /addEventListener\("compositionend"/,
            "composed text must not need an event listener of its own"
        );
    });

    test("every paste path goes through the terminal's own paste", () => {
        const pastes = termwrap.match(/this\.terminal\.paste\(/g) ?? [];
        assert.lengthOf(pastes, 3, "the paste handler (text and image) and the file drop");
        assert.match(termwrap, /this\.terminal\.paste\(paths\.join\(" "\) \+ " "\)/, "a dropped file is pasted");
        assert.notMatch(termwrap, /pasteUserText/, "there is no separate paste path left to keep in sync");
    });

    test("the seam is removed when the terminal is disposed", () => {
        const start = termwrap.indexOf("dispose() {");
        const body = termwrap.slice(start, termwrap.indexOf("\n    }", start));
        assert.match(body, /this\.userInputSeam\?\.uninstall\(\)/, "the terminal must be left as it was found");
    });
});
