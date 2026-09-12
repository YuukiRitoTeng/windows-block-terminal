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
        expect(markup).toContain('aria-label="Clear visual history"');
        expect(markup).toContain(">Clear</button>");
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
        const runner = createTerminalClearActionRunner(clear);

        const first = runner.run();
        expect(runner.pending).toBe(true);
        await expect(runner.run()).resolves.toBe("ignored");
        expect(clear).toHaveBeenCalledTimes(1);

        resolveClear();
        await expect(first).resolves.toBe("started");
        expect(runner.pending).toBe(false);
    });

    it("keeps success and failure status copy explicit", () => {
        expect(TERMINAL_CLEAR_SUCCESS_MESSAGE).toContain("PowerShell session preserved");
        expect(formatTerminalClearError(new Error("journal unavailable"))).toBe(
            "Clear failed; terminal was not cleared: journal unavailable"
        );
        expect(actionSource).toContain("TERMINAL_CLEAR_PENDING_MESSAGE");
        expect(actionSource).toContain("TERMINAL_CLEAR_SUCCESS_MESSAGE");
        expect(actionSource).toContain("formatTerminalClearError(error)");
    });

    it("mounts the action only in ordinary term mode", () => {
        expect(termSource).toContain("termMode == \"term\" && termWrapInst != null && (");
        expect(termSource).toContain("<TerminalClearAction model={model} />");
        expect(termSource).not.toContain("termMode == \"vdom\" && <TerminalClearAction");
        expect(termStyles).toContain(".terminal-clear-action");
        expect(termStyles).toContain("position: absolute");
        expect(termStyles).toContain("pointer-events: none");
        expect(termStyles).toContain("pointer-events: auto");
    });

    it("routes the context menu through the same fire-and-forget product operation", () => {
        expect(termModelSource).toContain('label: "Clear visual history"');
        expect(termModelSource).toContain(
            "click: () => fireAndForget(() => clearProductHistoryForModel(this))"
        );
        expect(termModelSource).toContain("clearProductHistoryForModel(this)");
    });

    it("preserves backend-first Clear and display-only xterm controls", async () => {
        const order: string[] = [];
        const service: Pick<CommandJournalServiceType, "ClearVisualHistory"> = {
            ClearVisualHistory: vi.fn(async () => {
                order.push("backend");
                return { generation: 2 };
            }),
        };
        await clearProductHistory("block-1", service, () => order.push("display"));
        expect(order).toEqual(["backend", "display"]);

        const termwrapSource = readFileSync(new URL("./termwrap.ts", import.meta.url), "utf8");
        expect(termwrapSource).toContain(String.raw`this.terminal.write("\x1b[2J\x1b[3J\x1b[H")`);
        expect(termwrapSource).not.toContain("this.sendDataHandler(\"\\x1b[2J");
        expect(termwrapSource).not.toContain("this.terminal.reset()");
    });
});
