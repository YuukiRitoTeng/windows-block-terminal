// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { uiText } from "@/util/ui-locale";
import type { TermViewModel } from "./term-model";
import { clearProductHistoryForModel, type ProductClearOutcome } from "./clear-product-history";

export const TERMINAL_CLEAR_PENDING_MESSAGE = uiText("terminal.clearing");
export const TERMINAL_CLEAR_SUCCESS_MESSAGE = uiText("terminal.clearSuccess");
export const TERMINAL_CLEAR_UNSUPPORTED_MESSAGE = uiText("terminal.clearUnsupported");

const TERMINAL_CLEAR_ERROR_PREFIX = uiText("command.clearFailedPrefix");

export type TerminalClearActionRunResult = ProductClearOutcome | "ignored";

export type TerminalClearActionRunner = {
    readonly pending: boolean;
    run: () => Promise<TerminalClearActionRunResult>;
};

/** Keeps the visible action from issuing a second clear while the Journal call is in flight. */
export function createTerminalClearActionRunner(clear: () => Promise<ProductClearOutcome>): TerminalClearActionRunner {
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
                return await clear();
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
    const [failed, setFailed] = React.useState(false);
    const generation = React.useRef(0);
    React.useEffect(() => {
        generation.current++;
        setStatus(""); setFailed(false); setPending(false);
        return () => { generation.current++; };
    }, [model]);
    React.useEffect(() => {
        if (status !== TERMINAL_CLEAR_SUCCESS_MESSAGE) return;
        const timer = setTimeout(() => setStatus(""), 3000);
        return () => clearTimeout(timer);
    }, [status]);
    const runner = React.useMemo(
        () =>
            createTerminalClearActionRunner(() => clearProductHistoryForModel(model)),
        [model]
    );

    const clear = React.useCallback(async () => {
        if (runner.pending) {
            return;
        }
        setPending(true);
        setFailed(false);
        const epoch = generation.current;
        setStatus(TERMINAL_CLEAR_PENDING_MESSAGE);
        try {
            const result = await runner.run();
            if (epoch !== generation.current) {
                return;
            }
            if (result === "cleared") {
                setStatus(TERMINAL_CLEAR_SUCCESS_MESSAGE);
            } else if (result === "unsupported") {
                // Nothing was cleared and the backend generation did not advance: this must never
                // look like a success.
                setStatus(TERMINAL_CLEAR_UNSUPPORTED_MESSAGE);
            }
        } catch (error) {
            if (epoch === generation.current) { setStatus(formatTerminalClearError(error)); setFailed(true); }
        } finally {
            if (epoch === generation.current) setPending(false);
        }
    }, [runner]);

    return (
        <div className="terminal-clear-action" aria-label={uiText("terminal.actions")}>
            <button
                className="terminal-clear-action-button"
                type="button"
                aria-label={uiText("terminal.clearVisualHistory")}
                title={uiText("terminal.clearVisualHistory")}
                aria-busy={pending}
                disabled={pending}
                onMouseDown={(event) => event.preventDefault()}
                onClick={clear}
            >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M15 3 22 10 11 21H7L2 16Z M8 10 16 18 M11 21H22" />
                </svg>
            </button>
            <span className="terminal-clear-action-status" role="status" aria-live="polite">
                {status}
                {failed && <button type="button" aria-label={uiText("command.dismissNotice")} onClick={() => { setStatus(""); setFailed(false); }}>×</button>}
            </span>
        </div>
    );
};
