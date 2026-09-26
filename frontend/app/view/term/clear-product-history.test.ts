// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Global Clear is a display-only terminal transaction behind a backend visibility transaction.
 * Nothing here sends input to the shell, and a clear without a lossless display plan is refused
 * as a whole.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { clearProductHistory } from "./clear-product-history";

const clearSource = readFileSync(new URL("./clear-product-history.ts", import.meta.url), "utf8");
const termwrapSource = readFileSync(new URL("./termwrap.ts", import.meta.url), "utf8");

function makeHost(overrides: Partial<{ canClear: boolean; applied: number }> = {}) {
    const state = { applied: 0 };
    const host = {
        withProductClearBoundary: vi.fn(async (run: (session: unknown) => Promise<unknown>) =>
            run({
                prepare: () => (overrides.canClear === undefined ? true : overrides.canClear),
                apply: async () => {
                    state.applied += 1;
                },
            })
        ),
    };
    return { host, applied: state };
}

describe("Global Clear orchestration", () => {
    it("runs the backend transaction before applying the display plan", async () => {
        const order: string[] = [];
        const backend = {
            ClearVisualHistory: vi.fn(async () => {
                order.push("backend");
                return { generation: 2 };
            }),
        };
        const host = {
            withProductClearBoundary: async (run: (session: unknown) => Promise<unknown>) =>
                run({
                    prepare: () => true,
                    apply: async () => {
                        order.push("display");
                    },
                }),
        };

        await expect(clearProductHistory("block-1", backend as never, host as never)).resolves.toBe("cleared");
        expect(order).toEqual(["backend", "display"]);
    });

    it("leaves the screen untouched when the backend transaction fails", async () => {
        const backend = { ClearVisualHistory: vi.fn().mockRejectedValue(new Error("journal unavailable")) };
        const { host, applied } = makeHost();

        await expect(clearProductHistory("block-1", backend as never, host as never)).rejects.toThrow(
            "journal unavailable"
        );
        expect(applied.applied).toBe(0);
    });

    it("refuses the whole clear when no lossless display plan exists", async () => {
        const backend = { ClearVisualHistory: vi.fn().mockResolvedValue({ generation: 2 }) };
        const { host, applied } = makeHost({ canClear: false });

        await expect(clearProductHistory("block-1", backend as never, host as never)).resolves.toBe("unsupported");
        // Fail-safe: the backend generation does not advance either.
        expect(backend.ClearVisualHistory).not.toHaveBeenCalled();
        expect(applied.applied).toBe(0);
    });

    it("reports unsupported when the pane has no terminal", async () => {
        await expect(clearProductHistory("block-1", {} as never, null)).resolves.toBe("unsupported");
    });

    it("never sends application input", () => {
        expect(clearSource).not.toMatch(/sendDataHandler|ControllerInput|onData/);
        expect(clearSource).not.toMatch(/\\r/);
        expect(clearSource).toContain("withProductClearBoundary");
        // The display mutation is xterm's own buffer clear: no parser bytes, no PTY input.
        expect(termwrapSource).toContain("applyProductClear");
        expect(termwrapSource).toContain("this.terminal.clear()");
        expect(termwrapSource).not.toContain("writeBoundaryFence");
        expect(termwrapSource).not.toMatch(/sendDataHandler\("\\r"\)/);
    });
});
