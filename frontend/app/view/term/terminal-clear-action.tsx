// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import type { TermViewModel } from "./term-model";
import { clearProductHistoryForModel } from "./clear-product-history";

export const TERMINAL_CLEAR_PENDING_MESSAGE = "Clearing visual history…";
export const TERMINAL_CLEAR_SUCCESS_MESSAGE = "Visual history cleared; PowerShell session preserved.";

const TERMINAL_CLEAR_ERROR_PREFIX = "Clear failed; terminal was not cleared";

export type TerminalClearActionRunResult = "started" | "ignored";

export type TerminalClearActionRunner = {
    readonly pending: boolean;
    run: () => Promise<TerminalClearActionRunResult>;
};

/** Keeps the visible action from issuing a second clear while the Journal call is in flight. */
export function createTerminalClearActionRunner(clear: () => Promise<void>): TerminalClearActionRunner {
    let pending = false;
    return {
        get pending() {
            return pending;
        },
        run: async () => {
            if (pending) {
                return "ignored";
            }
            pending = true;
            try {
                await clear();
                return "started";
            } finally {
                pending = false;
            }
        },
    };
}

export function formatTerminalClearError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return detail ? `${TERMINAL_CLEAR_ERROR_PREFIX}: ${detail}` : `${TERMINAL_CLEAR_ERROR_PREFIX}.`;
}

type TerminalClearActionProps = {
    model: Pick<TermViewModel, "blockId" | "termRef">;
};

export const TerminalClearAction = ({ model }: TerminalClearActionProps) => {
    const [pending, setPending] = React.useState(false);
    const [status, setStatus] = React.useState("");
    const runner = React.useMemo(
        () => createTerminalClearActionRunner(() => clearProductHistoryForModel(model)),
        [model]
    );

    const clear = React.useCallback(async () => {
        if (runner.pending) {
            return;
        }
        setPending(true);
        setStatus(TERMINAL_CLEAR_PENDING_MESSAGE);
        try {
            const result = await runner.run();
            if (result === "started") {
                setStatus(TERMINAL_CLEAR_SUCCESS_MESSAGE);
            }
        } catch (error) {
            setStatus(formatTerminalClearError(error));
        } finally {
            setPending(false);
        }
    }, [runner]);

    return (
        <div className="terminal-clear-action" aria-label="Terminal actions">
            <button
                className="terminal-clear-action-button"
                type="button"
                aria-label="Clear visual history"
                title="Clear visual history"
                aria-busy={pending}
                disabled={pending}
                onMouseDown={(event) => event.preventDefault()}
                onClick={clear}
            >
                {pending ? "Clearing…" : "Clear"}
            </button>
            <span className="terminal-clear-action-status" role="status" aria-live="polite">
                {status}
            </span>
        </div>
    );
};
