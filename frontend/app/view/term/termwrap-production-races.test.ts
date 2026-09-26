// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Production-path behaviour for the alternate buffer and paste, driven through the real entry points.
 *
 * The real `pasteHandler`, with only the clipboard/temp-file I/O mocked so each suspension point
 * can be resolved by the test. (Alternate-buffer / OSC R ordering is a separate terminal-recovery
 * task, deliberately out of Global Clear scope.)
 */

import { Terminal } from "@xterm/headless";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TermWrap } from "./termwrap";

const extractAllClipboardData = vi.fn();
const createTempFileFromBlob = vi.fn();
vi.mock("./termutil", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./termutil")>()),
    extractAllClipboardData: (...args: unknown[]) => extractAllClipboardData(...args),
    createTempFileFromBlob: (...args: unknown[]) => createTempFileFromBlob(...args),
}));

function makeTerminal(): Terminal {
    return new Terminal({ allowProposedApi: true, cols: 40, rows: 8, scrollback: 50 });
}

function makeWrap(term: Terminal) {
    const wrap: TermWrap = Object.create(TermWrap.prototype);
    const internals = wrap as unknown as Record<string, unknown>;
    internals.terminal = term;
    internals.ingressState = "live";
    internals.ingressGeneration = 1;
    internals.heldData = [];
    internals.ptyOffset = 0;
    internals.dataBytesProcessed = 0;
    internals.visualBufferGeneration = 0;
    internals.promptMarkers = [];
    internals.visualAnchorCues = new Map();
    internals.visualAnchorRegistry = { invalidate: vi.fn() };
    internals.commandAnchorSubscribers = new Set();
    internals.toDispose = [];
    internals.loaded = true;
    internals.presentationTail = Promise.resolve();
    internals.disposedOnce = false;
    internals.idleTimeoutHandle = null;
    internals.idleCallbackHandle = null;
    internals.pasteActive = false;
    const jotai = require("jotai");
    internals.shellIntegrationStatusAtom = jotai.atom(null);
    internals.claudeCodeActiveAtom = jotai.atom(false);
    internals.getZoneId = () => "block-races";
    const win = (globalThis as unknown as Record<string, unknown>).window as Record<string, unknown>;
    win.api ??= { getIsDev: () => false, getEnv: () => "" };
    return { wrap, internals };
}

function bufferText(term: Terminal): string {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n");
}

// The display path and the harness read `window.api`; the node test environment has no window.
beforeAll(() => {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.window ??= {
        setTimeout,
        clearTimeout,
        requestIdleCallback: (cb: () => void) => setTimeout(cb, 0) as unknown as number,
        cancelIdleCallback: (handle: number) => clearTimeout(handle),
    };
    const win = globals.window as Record<string, unknown>;
    win.api ??= { getIsDev: () => false, getEnv: () => "" };
});

describe("pasteHandler lifecycle races", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    function deferred<T>() {
        let resolve: (value: T) => void = () => {};
        const promise = new Promise<T>((r) => {
            resolve = r;
        });
        return { promise, resolve };
    }

    it("does not paste a text clipboard read that resolves after dispose", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        const paste = vi.fn();
        (term as unknown as { paste: unknown }).paste = paste;
        const clipboard = deferred<Array<{ text?: string }>>();
        extractAllClipboardData.mockReturnValue(clipboard.promise);

        const pasting = wrap.pasteHandler();
        internals.ingressState = "disposed";
        clipboard.resolve([{ text: "late paste" }]);
        await pasting;

        expect(paste).not.toHaveBeenCalled();
        term.dispose();
    });

    it("does not paste an image whose temp file resolves after dispose", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        const paste = vi.fn();
        (term as unknown as { paste: unknown }).paste = paste;
        extractAllClipboardData.mockResolvedValue([{ image: {} }]);
        const tempFile = deferred<string>();
        createTempFileFromBlob.mockReturnValue(tempFile.promise);

        const pasting = wrap.pasteHandler();
        await Promise.resolve();
        internals.ingressState = "disposed";
        tempFile.resolve("/tmp/late.png");
        await pasting;

        expect(paste).not.toHaveBeenCalled();
        term.dispose();
    });

    it("does not paste the second image when dispose happens during the 150ms gap", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        const paste = vi.fn();
        (term as unknown as { paste: unknown }).paste = paste;
        extractAllClipboardData.mockResolvedValue([{ image: {} }, { image: {} }]);
        createTempFileFromBlob.mockResolvedValue("/tmp/first.png");

        const pasting = wrap.pasteHandler();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(paste).toHaveBeenCalledTimes(1);
        internals.ingressState = "disposed";
        await new Promise((resolve) => setTimeout(resolve, 200));
        await pasting;

        expect(paste).toHaveBeenCalledTimes(1);
        term.dispose();
    });

    it("keeps normal live pastes working", async () => {
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        const paste = vi.fn();
        (term as unknown as { paste: unknown }).paste = paste;
        extractAllClipboardData.mockResolvedValue([{ text: "hello" }]);

        await wrap.pasteHandler();

        expect(paste).toHaveBeenCalledWith("hello");
        term.dispose();
    });
});
