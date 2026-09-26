import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CommandJournalServiceType } from "@/store/services";
import { clearProductHistory } from "./clear-product-history";
import {
    createTerminalClearActionRunner,
    formatTerminalClearError,
    TERMINAL_CLEAR_SUCCESS_MESSAGE,
    TerminalClearAction,
} from "./terminal-clear-action";

const actionSource = readFileSync(new URL("./terminal-clear-action.tsx", import.meta.url), "utf8");
const termSource = readFileSync(new URL("./term.tsx", import.meta.url), "utf8");
const termModelSource = readFileSync(new URL("./term-model.ts", import.meta.url), "utf8");
const termStyles = readFileSync(new URL("./term.scss", import.meta.url), "utf8");

describe("terminal-native clear action", () => {
    it("renders one accessible compact action and delegates through the shared helper", () => {
        const markup = renderToStaticMarkup(
            React.createElement(TerminalClearAction, {
                model: { blockId: "block-1", termRef: { current: null } } as any,
            })
        );

        expect(markup).toContain("terminal-clear-action");
        expect(markup).toContain('aria-label="清除可视历史"');
        expect(markup).not.toContain(">清除</button>");
        expect(markup).toContain('aria-hidden="true"');
        expect(markup).toContain('viewBox="0 0 24 24"');
        expect(markup).toContain('role="status"');
        expect(markup).toContain('aria-live="polite"');
        expect(actionSource).toContain("clearProductHistoryForModel(model)");
        expect(actionSource).toContain("onMouseDown={(event) => event.preventDefault()}");
        expect(actionSource).toContain("disabled={pending}");
        expect(actionSource).not.toContain("ClearVisualHistory");
        expect(actionSource).not.toContain("clearVisualBuffer");
    });

    it("guards duplicate calls while the authoritative operation is pending", async () => {
        let resolveClear: () => void = () => {};
        const clear = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveClear = resolve;
                })
        );
        const runner = createTerminalClearActionRunner(async () => {
            await clear();
            return "cleared" as const;
        });

        const first = runner.run();
        expect(runner.pending).toBe(true);
        await expect(runner.run()).resolves.toBe("ignored");
        resolveClear();
        await expect(first).resolves.toBe("cleared");
        expect(clear).toHaveBeenCalledTimes(1);

        resolveClear();
        expect(runner.pending).toBe(false);
    });

    it("keeps success and failure status copy explicit", () => {
        expect(TERMINAL_CLEAR_SUCCESS_MESSAGE).toContain("PowerShell");
        expect(TERMINAL_CLEAR_SUCCESS_MESSAGE).toContain("会话已保留");
        expect(formatTerminalClearError(new Error("journal unavailable"))).toBe(
            "清除失败；终端未被清除: journal unavailable"
        );
        expect(actionSource).toContain("TERMINAL_CLEAR_PENDING_MESSAGE");
        expect(actionSource).toContain("TERMINAL_CLEAR_SUCCESS_MESSAGE");
        expect(actionSource).toContain("formatTerminalClearError(error)");
    });

    it("mounts the action only in ordinary term mode", () => {
        expect(termSource).toContain('termWrap={termMode == "term" ? termWrapInst : null}');
        expect(termSource).toContain("<TerminalContentFrame");
        expect(termSource).not.toContain("termMode == \"vdom\" && <TerminalClearAction");
        expect(termStyles).toContain(".terminal-clear-action");
        expect(termStyles).toContain("position: absolute");
        expect(termStyles).toContain("pointer-events: none");
        expect(termStyles).toContain("pointer-events: auto");
    });

    it("routes the context menu through the same fire-and-forget product operation", () => {
        expect(termModelSource).toContain('uiText("terminal.clearVisualHistory")');
        expect(termModelSource).toContain(
            "click: () => fireAndForget(() => clearProductHistoryForModel(this))"
        );
        expect(termModelSource).toContain("clearProductHistoryForModel(this)");
    });

    it("keeps backend-first Clear and clears through xterm's own buffer API", async () => {
        const order: string[] = [];
        const service: Pick<CommandJournalServiceType, "ClearVisualHistory"> = {
            ClearVisualHistory: vi.fn(async (_blockId: string) => {
                order.push("backend");
                return { generation: 2 };
            }),
        };
        const host = {
            withProductClearBoundary: async (run: (session: unknown) => Promise<unknown>) =>
                run({
                    prepare: () => ({ keepStartAbs: 0, keepEndAbs: 0, cursorRowOffset: 0, cursorColumn: 1 }),
                    apply: async () => {
                        order.push("display");
                    },
                }),
        };
        await expect(clearProductHistory("block-1", service, host as never)).resolves.toBe("cleared");
        expect(order).toEqual(["backend", "display"]);

        const termwrapSource = readFileSync(new URL("./termwrap.ts", import.meta.url), "utf8");
        // The product path is terminal-owned: xterm's clear(), never an ESC wipe of the prompt
        // and never any input to the shell.
        // The product path is a display-only region mutation: no xterm clear(), no ESC wipe of the
        // prompt, and no shell input.
        expect(termwrapSource).toContain("canClearProductBuffer(): boolean");
        expect(termwrapSource).toContain("applyProductClear(): Promise<void>");
        // The mutation is xterm's own public buffer clear, reached without any parser bytes.
        expect(termwrapSource).toContain("this.terminal.clear()");
        expect(termwrapSource).not.toContain("this.sendDataHandler(\"\\x1b[2J");
        expect(termwrapSource).not.toContain("this.terminal.reset()");
        // The ESC-based wipe survives only in the file-origin reset seam.
        expect(termwrapSource).toContain(String.raw`this.writeParsed("\x1b[2J\x1b[3J\x1b[H")`);
        const resetStart = termwrapSource.indexOf("resetTerminalFileOrigin()");
        expect(termwrapSource.indexOf(String.raw`"\x1b[2J\x1b[3J\x1b[H"`)).toBeGreaterThan(resetStart);
    });
});

describe("terminal clear action result propagation", () => {
    it("reports the outcome instead of always claiming success", async () => {
        const cleared = createTerminalClearActionRunner(async () => "cleared");
        await expect(cleared.run()).resolves.toBe("cleared");

        const unsupported = createTerminalClearActionRunner(async () => "unsupported");
        await expect(unsupported.run()).resolves.toBe("unsupported");

        const failing = createTerminalClearActionRunner(async () => {
            throw new Error("journal unavailable");
        });
        await expect(failing.run()).rejects.toThrow("journal unavailable");
    });

    it("shows an explicit unsupported message and never the success one", () => {
        const source = readFileSync(new URL("./terminal-clear-action.tsx", import.meta.url), "utf8");
        // The success message is only set for a real clear; an unsupported outcome has its own
        // message and never reaches the success branch.
        expect(source).toContain('if (result === "cleared")');
        expect(source).toContain("TERMINAL_CLEAR_UNSUPPORTED_MESSAGE");
        const successIndex = source.indexOf("setStatus(TERMINAL_CLEAR_SUCCESS_MESSAGE)");
        const unsupportedIndex = source.indexOf("setStatus(TERMINAL_CLEAR_UNSUPPORTED_MESSAGE)");
        expect(successIndex).toBeGreaterThan(0);
        expect(unsupportedIndex).toBeGreaterThan(successIndex);
    });
});
