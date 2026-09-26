// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real terminal behaviour for the product Global Clear.
 *
 * The product mutation is xterm's own public `Terminal.clear()` against a real xterm core
 * (`@xterm/headless@6.0.0`, the same core the app runs through `@xterm/xterm`). These tests pin
 * what the audit asked for: the prompt survives, application terminal modes cannot influence the
 * clear, an application frame that is mid-parse is never touched, a resize cannot interleave with
 * the clear, and nothing is ever sent to the shell.
 */

import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { clearProductHistory } from "./clear-product-history";
import { TermWrap } from "./termwrap";

function makeTerminal(cols = 20, rows = 6, scrollback = 50): Terminal {
    return new Terminal({ allowProposedApi: true, cols, rows, scrollback });
}

function makeWrap(term: Terminal, options: { ingress?: "loading" | "draining" | "live" | "disposed" } = {}) {
    const wrap: TermWrap = Object.create(TermWrap.prototype);
    const internals = wrap as unknown as Record<string, unknown>;
    internals.terminal = term;
    internals.ingressState = options.ingress ?? "live";
    internals.ingressGeneration = 7;
    internals.heldData = [];
    internals.ptyOffset = 1234;
    internals.dataBytesProcessed = 42;
    internals.visualBufferGeneration = 3;
    internals.promptMarkers = [];
    internals.visualAnchorCues = new Map();
    internals.visualAnchorRegistry = { invalidate: vi.fn() };
    internals.commandAnchorSubscribers = new Set();
    internals.loaded = true;
    internals.presentationTail = Promise.resolve();
    const sent: string[] = [];
    internals.sendDataHandler = (data: string) => sent.push(data);
    const onData = vi.fn();
    term.onData(onData);
    return { wrap, internals, sent, onData };
}

function write(term: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, () => resolve()));
}

function bufferText(term: Terminal): string {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n");
}

async function runClear(wrap: TermWrap) {
    const backend = { ClearVisualHistory: vi.fn().mockResolvedValue({ generation: 2 }) };
    const outcome = await clearProductHistory("block-1", backend as never, wrap as never);
    return { outcome, backend };
}

describe("product Global Clear against a real xterm core", () => {
    it("keeps the prompt line and drops old output and scrollback", async () => {
        const term = makeTerminal();
        const { wrap, sent, onData } = makeWrap(term);
        await write(term, "old output one\r\nold output two\r\nPS C:\\Users\\me> ");

        const { outcome } = await runClear(wrap);

        expect(outcome).toBe("cleared");
        const text = bufferText(term);
        expect(text).toContain("PS C:\\Users\\me>");
        expect(text).not.toContain("old output");
        expect(onData).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
        term.dispose();
    });

    it("refuses instead of mangling the screen when scroll margins home the cursor", async () => {
        // DECSTBM moves the cursor to the home position, which is exactly the upstream xterm.js#5992
        // state where the public clear() is a no-op. The clear is therefore refused as a whole -
        // nothing is deleted, nothing is kept by accident, and no terminal mode can make the clear
        // mean something else.
        const term = makeTerminal(20, 6, 50);
        const { wrap, onData } = makeWrap(term);
        await write(term, "old0\r\nold1\r\nold2\r\nPS C:> ");
        await write(term, "\x1b[3;6r"); // application scroll margins (homes the cursor)
        const before = bufferText(term);

        const { outcome, backend } = await runClear(wrap);

        expect(outcome).toBe("unsupported");
        expect(backend.ClearVisualHistory).not.toHaveBeenCalled();
        expect(bufferText(term)).toBe(before);
        expect(bufferText(term)).toContain("PS C:>");
        expect(onData).not.toHaveBeenCalled();
        term.dispose();
    });

    it("refuses instead of mangling the screen when origin mode homes the cursor", async () => {
        const term = makeTerminal(20, 6, 50);
        const { wrap, onData } = makeWrap(term);
        await write(term, "old0\r\nold1\r\nold2\r\nPS C:> ");
        await write(term, "\x1b[?6h"); // origin mode (homes the cursor)
        const before = bufferText(term);

        const { outcome, backend } = await runClear(wrap);

        expect(outcome).toBe("unsupported");
        expect(backend.ClearVisualHistory).not.toHaveBeenCalled();
        expect(bufferText(term)).toBe(before);
        expect(onData).not.toHaveBeenCalled();
        term.dispose();
    });

    it("keeps the normal buffer usable after a refused alternate-buffer clear", async () => {
        const term = makeTerminal(40, 6, 50);
        const { wrap, onData, sent } = makeWrap(term);
        await write(term, "normal output\r\nPS C:> ");
        await write(term, "\x1b[?1049h");
        await write(term, "TUI frame one\r\nTUI frame two");

        // Frozen semantics: no clear while the alternate buffer is active.
        const { outcome, backend } = await runClear(wrap);
        expect(outcome).toBe("unsupported");
        expect(backend.ClearVisualHistory).not.toHaveBeenCalled();

        await write(term, "\x1b[?1049l");
        await write(term, "PS C:> still here");
        expect(bufferText(term)).toContain("still here");
        expect(onData).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
        term.dispose();
    });

    it("refuses the upstream cursor-at-home state instead of silently doing nothing", async () => {
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        await write(term, "old0\r\nPS C:> ");
        await write(term, "\x1b[1;1H"); // cursor parked at home with content on screen
        const before = bufferText(term);

        const { outcome, backend } = await runClear(wrap);

        expect(outcome).toBe("unsupported");
        expect(backend.ClearVisualHistory).not.toHaveBeenCalled();
        expect(bufferText(term)).toBe(before);
        term.dispose();
    });

    it("refuses the auditor's cursorX>0 no-op state", async () => {
        // The real xterm 6.0.0 early return is the cursor row 0 with no scrollback - the column is
        // irrelevant (upstream #5992). Checking only column 0 committed a backend transaction whose
        // screen never changed.
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        await write(term, "old0\r\nold1\r\nPS C:> ");
        await write(term, "\x1b[1;4H"); // cursor row 0, column 3, old text below
        const buffer = term.buffer.active;
        expect(buffer.cursorY).toBe(0);
        expect(buffer.cursorX).toBe(3);
        expect(buffer.baseY).toBe(0);
        const before = bufferText(term);

        const { outcome, backend } = await runClear(wrap);

        expect(outcome).toBe("unsupported");
        expect(backend.ClearVisualHistory).not.toHaveBeenCalled();
        expect(bufferText(term)).toBe(before);
        term.dispose();
    });

    it("clears when only the cursor's own line is on screen", async () => {
        // The no-op state is only a problem when something else would have to disappear: a screen
        // holding nothing but the prompt is already what a clear produces.
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        await write(term, "PS C:> ");

        const { outcome } = await runClear(wrap);

        expect(outcome).toBe("cleared");
        expect(bufferText(term)).toContain("PS C:>");
        term.dispose();
    });

    it("does not touch an application frame that is mid-parse", async () => {
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        const received: string[] = [];
        term.parser.registerOscHandler(123, (payload) => {
            received.push(payload);
            return false;
        });
        await write(term, "old output\r\nPS C:> ");

        await write(term, "\x1b]123;part1");
        const { outcome } = await runClear(wrap);
        expect(outcome).toBe("cleared");
        await write(term, "part2\x07");

        expect(received).toEqual(["part1part2"]);
        term.dispose();
    });

    it("keeps partial CSI, DCS and a lone ESC intact across the clear", async () => {
        const term = makeTerminal(40, 6, 50);
        const { wrap } = makeWrap(term);
        const csiSeen: string[] = [];
        term.parser.registerCsiHandler({ final: "q" }, () => {
            csiSeen.push("q");
            return false;
        });
        await write(term, "PS C:> ");

        await write(term, "\x1b[1");
        await runClear(wrap);
        await write(term, ";2q");
        expect(csiSeen).toEqual(["q"]);

        await write(term, "\x1bP1$r");
        await runClear(wrap);
        await write(term, "0m\x1b\\");
        await write(term, "PS C:> after dcs");
        expect(bufferText(term)).toContain("PS C:> after dcs");

        await write(term, "\x1b");
        await runClear(wrap);
        await write(term, "]0;title\x07");
        term.dispose();
    });

    it("delivers a split OSC 16162 frame as one complete frame", async () => {
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        const frames: string[] = [];
        term.parser.registerOscHandler(16162, (payload) => {
            frames.push(payload);
            return false;
        });
        await write(term, "PS C:> ");

        await write(term, "\x1b]16162;P;{\"v\":1,\"epoch\":\"e1\",");
        await runClear(wrap);
        await write(term, "\"seq\":2}\x07");

        expect(frames).toEqual(['P;{"v":1,"epoch":"e1","seq":2}']);
        term.dispose();
    });

    it("queues a resize behind the clear instead of reflowing mid-transaction", async () => {
        const term = makeTerminal(20, 6, 50);
        const { wrap, internals } = makeWrap(term);
        await write(term, "old output\r\nPS C:> ");
        const fit = vi.fn(() => term.resize(30, 6));
        internals.fitAddon = { fit };
        internals.hasResized = true;

        const clearing = wrap.withProductClearBoundary(async (session) => {
            expect(session.prepare()).toBe(true);
            // The resize arrives while the transaction is open: it must not reflow yet.
            wrap.handleResize();
            expect(fit).not.toHaveBeenCalled();
            await session.apply();
        });
        await clearing;
        await Promise.resolve();
        expect(fit).toHaveBeenCalled();

        expect(bufferText(term)).toContain("PS C:>");
        term.dispose();
    });

    it("keeps the prompt and cursor intact when the resize happened before the clear", async () => {
        // The other direction of the resize/clear ordering: the resize has already reflowed the
        // buffer, and the clear that follows must still keep the prompt and leave a valid cursor.
        const term = makeTerminal(20, 6, 50);
        const { wrap, onData, sent } = makeWrap(term);
        await write(term, "old output one\r\nold output two\r\nPS C:> ");
        term.resize(30, 6);
        await write(term, "Get-ChildItem");
        const cursorBefore = term.buffer.active.cursorX;

        const { outcome } = await runClear(wrap);

        expect(outcome).toBe("cleared");
        const text = bufferText(term);
        expect(text).not.toContain("old output");
        expect(text).toContain("PS C:> Get-ChildItem");
        // The kept line is now the first row, and the cursor still sits on the same cell of it.
        const cursorAfter = term.buffer.active;
        expect(cursorAfter.cursorY).toBe(0);
        expect(cursorAfter.cursorX).toBe(cursorBefore);
        expect(cursorAfter.cursorX).toBeLessThanOrEqual(term.cols);
        expect(cursorAfter.getLine(0)?.translateToString(true)).toContain("PS C:> Get-ChildItem");
        expect(onData).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
        term.dispose();
    });

    it("waits for an already submitted write, so old output cannot reappear after the clear", async () => {
        // The audit counterexample: a PTY write has been submitted but xterm has not parsed it yet
        // when the clear starts. The clear waits for that write's real completion first, so the old
        // bytes are part of what it clears instead of landing in the already cleared screen.
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        let writeFinished = false;
        let releaseWrite: () => void = () => {};
        const writeGate = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        // A write that is still inside its lane slot when the clear is requested.
        const writing = wrap.runInPresentationLane(async () => {
            await write(term, "old output\r\nPS C:> ");
            await writeGate;
            writeFinished = true;
        });
        const clearing = runClear(wrap);
        await Promise.resolve();
        expect(writeFinished).toBe(false);

        releaseWrite();
        await writing;
        const { outcome } = await clearing;

        expect(outcome).toBe("cleared");
        const text = bufferText(term);
        expect(text).toContain("PS C:>");
        expect(text).not.toContain("old output");
        term.dispose();
    });

    it("holds the same lane for the file-origin reset", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        await write(term, "old output\r\nPS C:> ");

        let resetting: Promise<void> = Promise.resolve();
        const clearing = wrap.withProductClearBoundary(async (session) => {
            expect(session.prepare()).toBe(true);
            // The reset takes the next lane slot: it cannot slip in while the clear owns the lane.
            resetting = wrap.resetTerminalFileOrigin();
            await Promise.resolve();
            expect(internals.ingressGeneration).toBe(7);
            await session.apply();
        });
        await clearing;
        await resetting;

        expect(internals.ingressGeneration).toBe(8);
        term.dispose();
    });

    it("releases the lane when the pane is disposed during the transaction", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        await write(term, "PS C:> ");

        internals.fitAddon = { fit: vi.fn() };
        internals.hasResized = true;
        const clearing = wrap.withProductClearBoundary(async (session) => {
            internals.ingressState = "disposed";
            await session.apply();
            return "cleared";
        });
        await expect(clearing).resolves.toBe("cleared");
        // The lane is released, and a later resize is a safe no-op rather than a throw.
        expect(internals.clearBoundary ?? null).toBeNull();
        expect(() => wrap.handleResize()).not.toThrow();
    });

    it("serializes two concurrent clears instead of letting them overwrite each other", async () => {
        // The audit counterexample: clear A is inside its backend transaction, clear B is requested
        // afterwards, and fresh PTY output is produced while A is still in flight. FIFO order means
        // A applies first and B second, so the fresh output (enqueued after B) is never removed by
        // the late A, and the backend calls happen in the same order.
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        await write(term, "old output\r\nPS C:> ");

        const order: string[] = [];
        const transactions: (() => void)[] = [];
        const service = (label: string) => ({
            ClearVisualHistory: vi.fn(async () => {
                order.push(`backend:${label}`);
                await new Promise<void>((resolve) => transactions.push(resolve));
                return { generation: 2 };
            }),
        });

        const clearA = clearProductHistory("block-1", service("A") as never, wrap as never);
        await Promise.resolve();
        const clearB = clearProductHistory("block-1", service("B") as never, wrap as never);
        const freshWrite = wrap.runInPresentationLane(() => write(term, "fresh first\r\nfresh second\r\n"));
        await Promise.resolve();

        // Only A has reached its backend call; B and the write are queued behind it.
        expect(order).toEqual(["backend:A"]);
        transactions.shift()?.();
        await expect(clearA).resolves.toBe("cleared");
        await Promise.resolve();
        expect(order).toEqual(["backend:A", "backend:B"]);
        transactions.shift()?.();
        await expect(clearB).resolves.toBe("cleared");
        await freshWrite;

        const text = bufferText(term);
        // The fresh output was produced after both clears, so nothing removed it.
        expect(text).toContain("fresh first");
        expect(text).toContain("fresh second");
        expect(text).not.toContain("old output");
        term.dispose();
    });

    it("freezes the product semantic: the clear keeps the cursor's row", async () => {
        // Terminal-owned clear semantics, frozen here so it is not re-litigated: the buffer is
        // emptied and the row the cursor is on survives as the new current row. When queued output
        // has already been parsed, the cursor sits on that output row, which is therefore the line
        // a clear keeps.
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        await write(term, "PS C:> ");
        await write(term, "\r\nqueued output line");
        const cursorRow = term.buffer.active.cursorY;

        const { outcome } = await runClear(wrap);

        expect(outcome).toBe("cleared");
        const text = bufferText(term);
        expect(text).toContain("queued output line");
        expect(text).not.toContain("PS C:>");
        expect(term.buffer.active.cursorY).toBe(0);
        expect(cursorRow).toBeGreaterThan(0);
        term.dispose();
    });

    it("keeps the lane usable and safe after dispose", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        await write(term, "PS C:> ");

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocking = wrap.runInPresentationLane(() => gate);
        internals.ingressState = "disposed";
        release();
        await blocking;

        // Queued work after a dispose is a safe no-op, and a failing operation does not poison the
        // lane for the operations behind it.
        await expect(wrap.doTerminalWrite("ignored")).resolves.toBeUndefined();
        await expect(
            wrap.runInPresentationLane(async () => {
                throw new Error("boom");
            })
        ).rejects.toThrow("boom");
        await expect(wrap.runInPresentationLane(async () => "still running")).resolves.toBe("still running");
        term.dispose();
    });

    it("skips the presentation mutation when the pane is disposed during the backend wait", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        await write(term, "old output\r\nPS C:> ");
        const clearSpy = vi.spyOn(term, "clear");

        let releaseBackend: () => void = () => {};
        const backend = {
            ClearVisualHistory: vi.fn(async () => {
                await new Promise<void>((resolve) => {
                    releaseBackend = resolve;
                });
                return { generation: 2 };
            }),
        };
        const clearing = clearProductHistory("block-1", backend as never, wrap as never);
        await Promise.resolve();
        internals.ingressState = "disposed";
        releaseBackend();

        // The durable commit stands, but there is no renderer left to mutate.
        await expect(clearing).resolves.toBe("cleared");
        expect(backend.ClearVisualHistory).toHaveBeenCalledTimes(1);
        expect(clearSpy).not.toHaveBeenCalled();
        expect(internals.ingressState).toBe("disposed");
        term.dispose();
    });

    it("never revives a disposed pane from a reset write callback", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        await write(term, "old output\r\nPS C:> ");
        internals.ingressState = "loading";
        internals.loaded = false;

        let releaseWrite: () => void = () => {};
        const writeGate = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        const blocking = wrap.runInPresentationLane(() => writeGate);
        const resetting = wrap.resetTerminalFileOrigin();
        internals.ingressState = "disposed";
        const generationBefore = internals.ingressGeneration;
        releaseWrite();
        await blocking;
        await resetting;

        // Disposed is terminal: the callback must not touch ingress state or restore "live".
        expect(internals.ingressState).toBe("disposed");
        expect(internals.ingressGeneration).toBe(generationBefore);
        expect(internals.heldData).toEqual([]);
        expect(internals.loaded).toBe(false);
        term.dispose();
    });

    it("runs no queued restore resize after the pane is disposed", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        await write(term, "PS C:> ");
        const resizeSpy = vi.spyOn(term, "resize");

        // A lane gate is held, so the restore-style resize is queued but not executed yet.
        let releaseGate: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const blocking = wrap.runInPresentationLane(() => gate);
        const restoring = wrap.runInPresentationLane(async () => {
            if (internals.ingressState === "disposed") {
                return;
            }
            term.resize(30, 6);
        });
        internals.ingressState = "disposed";
        releaseGate();
        await blocking;
        await restoring;

        expect(resizeSpy).not.toHaveBeenCalled();
        term.dispose();
    });

    it("reports a failing resize instead of leaving an unhandled rejection", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        internals.fitAddon = {
            fit: () => {
                throw new Error("fit failed");
            },
        };
        internals.hasResized = true;

        expect(() => wrap.handleResize()).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();
        term.dispose();
    });

    it("refuses the alternate buffer and does not let old normal history come back as cleared", async () => {
        // Global Clear promises the normal buffer's visual history only. In the alternate buffer the
        // public clear would empty the wrong screen, so the clear is refused before any backend
        // commit and the durable generation does not advance.
        const term = makeTerminal();
        const { wrap } = makeWrap(term);
        await write(term, "old normal history\r\nPS C:> ");
        await write(term, "\x1b[?1049h");
        await write(term, "TUI frame one\r\nTUI frame two");
        expect(term.buffer.active.type).toBe("alternate");
        const clearSpy = vi.spyOn(term, "clear");

        const { outcome, backend } = await runClear(wrap);

        expect(outcome).toBe("unsupported");
        expect(backend.ClearVisualHistory).not.toHaveBeenCalled();
        expect(clearSpy).not.toHaveBeenCalled();
        expect(term.buffer.active.type).toBe("alternate");

        // The standard exit sequence returns to the normal buffer with its history intact - which is
        // the expected outcome of a refused clear, not a "cleared but resurrected" state.
        await write(term, "\x1b[?1049l");
        expect(term.buffer.active.type).toBe("normal");
        expect(bufferText(term)).toContain("old normal history");
        term.dispose();
    });

    it("does not touch the terminal-file ingress state", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        await write(term, "PS C:> ");

        await runClear(wrap);

        expect(internals.ingressGeneration).toBe(7);
        expect(internals.heldData).toEqual([]);
        expect(internals.ptyOffset).toBe(1234);
        expect(internals.dataBytesProcessed).toBe(42);
        expect(internals.visualBufferGeneration).toBe(4);
        term.dispose();
    });

    it("keeps the file-origin reset separate from the product clear", async () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        await write(term, "old output\r\nPS C:> ");

        await wrap.resetTerminalFileOrigin();

        expect(internals.ingressGeneration).toBe(8);
        expect(internals.visualBufferGeneration).toBe(4);
        term.dispose();
    });

    it("clears nothing on a disposed pane", async () => {
        const term = makeTerminal();
        const { wrap } = makeWrap(term, { ingress: "disposed" });
        const { outcome, backend } = await runClear(wrap);
        expect(outcome).toBe("unsupported");
        expect(backend.ClearVisualHistory).not.toHaveBeenCalled();
        term.dispose();
    });
});
