// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The "somebody typed here" marker.
 *
 * Reclaiming a pane is only allowed for a terminal the Snap Bar created and nobody used. The command
 * journal is the authoritative record of commands, but it depends on shell integration reporting them;
 * this marker is written on the first keystroke, so a used pane can never be reclaimed even if the
 * journal never saw the command.
 *
 * The guard itself is pure and tested above; this file pins the wiring that makes it fire - one
 * keystroke path, one marker write, and only for Snap-created terminals.
 */

import { SNAP_AUTOCREATED_META_KEY, SNAP_TOUCHED_META_KEY, shouldMarkSnapTerminalTouched } from "@/app/workspace/snapReclaim";
import { readFile } from "fs/promises";
import { join } from "path";
import { assert, beforeAll, describe, test } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");

describe("snap usage marker: the guard", () => {
    test("only a Snap-created terminal that is not marked yet is marked", () => {
        assert.isTrue(shouldMarkSnapTerminalTouched({ [SNAP_AUTOCREATED_META_KEY]: true }));
        assert.isFalse(
            shouldMarkSnapTerminalTouched({ [SNAP_AUTOCREATED_META_KEY]: true, [SNAP_TOUCHED_META_KEY]: true }),
            "the marker is written once"
        );
    });

    test("nothing else is ever marked", () => {
        assert.isFalse(shouldMarkSnapTerminalTouched({ view: "term", controller: "shell" }), "not a snap terminal");
        assert.isFalse(shouldMarkSnapTerminalTouched({}), "no meta");
        assert.isFalse(shouldMarkSnapTerminalTouched(null));
        assert.isFalse(shouldMarkSnapTerminalTouched(undefined));
        assert.isFalse(
            shouldMarkSnapTerminalTouched({ [SNAP_AUTOCREATED_META_KEY]: "true" }),
            "the marker must be a real boolean"
        );
    });
});

describe("snap usage marker: the wiring", () => {
    let termwrap: string;
    let termModel: string;
    let term: string;
    let snapTouch: string;

    beforeAll(async () => {
        termwrap = await readSource("frontend/app/view/term/termwrap.ts");
        termModel = await readSource("frontend/app/view/term/term-model.ts");
        term = await readSource("frontend/app/view/term/term.tsx");
        snapTouch = await readSource("frontend/app/view/term/snap-touch.ts");
    });

    test("the terminal's data channel must not report user input", () => {
        // xterm's onData also carries the answers the terminal generates for the program's queries
        // (device attributes, cursor position, colours), so a shell that merely starts would look like
        // a user typing. handleTermData is that channel: it must not report anything.
        const handler = termwrap.slice(termwrap.indexOf("handleTermData(data: string)"));
        const body = handler.slice(0, handler.indexOf("\n    }"));
        assert.notMatch(body, /reportUserInput/, "the data channel must never mark a pane as used");
        assert.match(body, /this\.sendDataHandler\?\.\(data\)/, "it must still forward the data");
    });

    test("only real user input reports: a key press, a paste, composed text, or dropped files", () => {
        // A key press reports directly; the data it produces is broadcast from the user-input seam.
        assert.match(
            termwrap,
            /terminal\.onKey\(\(\) => this\.reportUserInput\(\)\)/,
            "key presses must report"
        );
        // Pasted text, dropped files and IME-composed text all reach xterm's own user-input path, which
        // the seam reports from - so a paste and a composition are marked by the same line.
        assert.match(
            termwrap,
            /installUserInputSeam\(this\.terminal, \(data\) => \{\s*this\.reportUserInput\(\);/,
            "the seam must report the input it broadcasts"
        );
        // Dropped files go through the terminal's own paste, which is on that same path.
        assert.match(termwrap, /this\.terminal\.paste\(paths\.join\(" "\) \+ " "\)/, "a file drop must report");
        assert.notMatch(termwrap, /pasteUserText/, "there is no second paste path to keep in sync");
    });

    test("the report is a guarded one-shot", () => {
        assert.match(termwrap, /private reportUserInput\(\)/, "the report must be a guarded one-shot");
        assert.match(termwrap, /if \(this\.userInputReported\)/, "it must fire at most once");
        assert.match(termwrap, /userInputHandler\?: \(\) => void/, "the option must exist");
    });

    test("the terminal view wires the handler to the model", () => {
        assert.match(term, /userInputHandler:\s*model\.markSnapTerminalTouched\.bind\(model\)/);
    });

    test("the model writes the marker only for Snap-created terminals", () => {
        assert.match(snapTouch, /shouldMarkSnapTerminalTouched\(meta\)/, "the shared guard must be used");
        assert.match(snapTouch, /\[SNAP_TOUCHED_META_KEY\]: true/);
        assert.match(snapTouch, /SetMetaCommand/, "the marker is persisted on the block");
        assert.match(termModel, /markSnapTerminalTouched\(this\.blockId\)/, "the model must use the shared helper");
    });
});

/**
 * The app rewrites some key presses itself: it sends the terminal input and returns `false` from the
 * custom key handler, which stops xterm from ever firing its own key event. Every such path has to
 * report the input itself, or a pane the user is typing in can be reclaimed as unused.
 */
describe("snap usage marker: input the app sends itself", () => {
    let termModel: string;

    /** The body of one method of TermViewModel, by name. */
    function methodBody(name: string): string {
        const start = termModel.indexOf(`    ${name}(`);
        assert.isAtLeast(start, 0, `${name} must exist`);
        const end = termModel.indexOf("\n    }", start);
        assert.isAtLeast(end, 0, `${name} must have a body`);
        return termModel.slice(start, end);
    }

    beforeAll(async () => {
        termModel = await readSource("frontend/app/view/term/term-model.ts");
    });

    test("the send helper marks the terminal before sending", () => {
        const body = methodBody("sendUserInputToController");
        const markAt = body.indexOf("this.markSnapTerminalTouched()");
        const sendAt = body.indexOf("this.sendDataToController(data)");
        assert.isAtLeast(markAt, 0, "the helper must mark the terminal as used");
        assert.isAtLeast(sendAt, 0, "the helper must send the input");
        assert.isBelow(markAt, sendAt, "the marker must be written before the input goes out");
    });

    test("the key handler does not send user input any other way", () => {
        const keydown = methodBody("handleTerminalKeydown");
        assert.notMatch(
            keydown,
            /this\.sendDataToController\(/,
            "every rewritten key must go through the marking helper"
        );
    });

    test("Shift+Enter reports the input it sends", () => {
        const keydown = methodBody("handleTerminalKeydown");
        const branch = keydown.slice(keydown.indexOf('"Shift:Enter"'));
        assert.match(branch.slice(0, 400), /this\.sendUserInputToController\("\\n"\)/);
        assert.match(branch.slice(0, 500), /return false;/, "the handler still consumes the key");
    });

    test("macOS Cmd+Arrow reports the input it sends", () => {
        const keydown = methodBody("handleTerminalKeydown");
        const cmdLeft = keydown.slice(keydown.indexOf('"Cmd:ArrowLeft"'));
        assert.match(cmdLeft.slice(0, 300), /this\.sendUserInputToController\("\\x01"\)/);
        const cmdRight = keydown.slice(keydown.indexOf('"Cmd:ArrowRight"'));
        assert.match(cmdRight.slice(0, 300), /this\.sendUserInputToController\("\\x05"\)/);
    });

    test("a multi-input broadcast marks the panes it types into", async () => {
        // The broadcast loop lives in the shared multi-input rule; the model applies it to the panes in
        // the tab. Either way the panes are typed into as user input, which is what marks them.
        const body = methodBody("multiInputHandler");
        assert.match(body, /broadcastToOtherPanes\(getAllBasicTermModels\(\), this,/, "the shared rule");
        assert.notMatch(body, /sendDataToController\(/, "a broadcast is user input, not a raw send");

        const rule = await readSource("frontend/app/view/term/multi-input.ts");
        const loop = rule.slice(rule.indexOf("export function broadcastToOtherPanes"));
        assert.match(loop, /target\.sendUserInputToController\(data\)/, "broadcast input is user input too");
        assert.notMatch(loop, /sendDataToController\(/, "and never the raw send");
    });

    test("a sticker's click command marks the terminal it types into", async () => {
        const sticker = await readSource("frontend/app/view/term/termsticker.tsx");
        const click = sticker.slice(sticker.indexOf("if (sticker.clickcmd)"));
        assert.match(click.slice(0, 400), /markSnapTerminalTouched\(config\.blockId\)/);
        const markAt = click.indexOf("markSnapTerminalTouched(config.blockId)");
        const sendAt = click.indexOf("ControllerInputCommand");
        assert.isBelow(markAt, sendAt, "the marker must be written before the command is sent");
    });

    test("a terminal resize is not user input", async () => {
        const source = await readSource("frontend/app/view/term/termwrap.ts");
        const resize = source.slice(source.indexOf("termsize: termSize"));
        assert.notMatch(resize.slice(0, 200), /reportUserInput/, "resizing must not mark the pane as used");
    });
});
