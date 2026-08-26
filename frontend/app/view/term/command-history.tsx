// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import { base64ToArray } from "@/util/util";
import * as React from "react";
import type { TermViewModel } from "./term-model";

export const MAX_HISTORY_RECORDS = 100;
export const MAX_PRESENTATION_BYTES = 64 * 1024;

export type OutputProjection =
    | { kind: "safe"; text: string }
    | { kind: "unsafe"; reason: string };

export class HistoryRequestEpoch {
    private value = 0;
    bump(): number {
        this.value += 1;
        return this.value;
    }
    capture(): number {
        return this.value;
    }
    isCurrent(captured: number): boolean {
        return captured === this.value;
    }
}

// PTY text commonly contains ANSI styling (for example ESC[m).  Those
// sequences are terminal presentation bytes, not binary command output.  Strip
// the well-known CSI/OSC forms before projecting text into cards/clipboard,
// while continuing to reject other control bytes and malformed sequences.
export function sanitizeTerminalText(text: string): string | null {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const sanitized = text
        .replace(new RegExp(`${esc}\\][^${bel}]*(?:${bel}|${esc}\\\\)`, "g"), "")
        .replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
        .replace(new RegExp(`${esc}[()][0-2A-Z0-9]`, "g"), "");
    for (const char of sanitized) {
        const code = char.charCodeAt(0);
        if ((code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x80 && code <= 0x9f) || code === 0x7f || code === 0x1b) && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
            return null;
        }
    }
    return sanitized;
}

export function limitVisibleRecords(records: RecordView[]): RecordView[] {
    if (records.length <= MAX_HISTORY_RECORDS) {
        return records;
    }
    return records.slice(records.length - MAX_HISTORY_RECORDS);
}

export function projectOutput(record: RecordView, data64: string): OutputProjection {
    if (!canCopyOutput(record)) {
        if (record.execution_mode === "interactive") {
            return { kind: "unsafe", reason: "Interactive output remains in the terminal." };
        }
        return { kind: "unsafe", reason: "Output is not complete, text-safe, and authoritatively attributed." };
    }
    if (record.output_stored_bytes > MAX_PRESENTATION_BYTES) {
        return { kind: "unsafe", reason: "Output is larger than the bounded card preview." };
    }
    try {
        const bytes = base64ToArray(data64 ?? "");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const sanitized = sanitizeTerminalText(text);
        if (sanitized == null) {
            return { kind: "unsafe", reason: "Output contains terminal control or binary data." };
        }
        return { kind: "safe", text: sanitized };
    } catch {
        return { kind: "unsafe", reason: "Output is not valid UTF-8 text." };
    }
}

export function formatDuration(record: RecordView): string {
    if (record.finished_at_unix_ms == null) {
        return "running";
    }
    const duration = Math.max(0, record.finished_at_unix_ms - record.started_at_unix_ms);
    return duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(2)} s`;
}

export function canCopyOutput(record: RecordView): boolean {
    return (
        record.execution_mode !== "interactive" &&
        record.output_state === "closed" &&
        record.output_completeness === "complete" &&
        record.output_attribution === "exclusive" &&
        record.output_text_safety === "plain_text" &&
        !record.output_truncated &&
        record.output_stored_bytes <= MAX_PRESENTATION_BYTES
    );
}

export async function clearProductHistory(
    blockId: string,
    service: Pick<services.CommandJournalServiceType, "ClearVisualHistory">,
    clearTerminal: () => void
): Promise<void> {
    // The terminal is cleared only after the product visibility transaction succeeds.
    await service.ClearVisualHistory(blockId);
    clearTerminal();
}

type CommandHistoryProps = {
    blockId: string;
    model: TermViewModel;
};

type OutputState = { loading: boolean; projection?: OutputProjection; data64?: string };

const statusLabel = (record: RecordView) => {
    if (record.state === "running") return "running";
    if (record.success === true) return "success";
    if (record.success === false) return "failed";
    return record.state || "unknown";
};

const CommandCard = ({
    record,
    output,
    onLoadOutput,
    onCopy,
    onCopyAll,
}: {
    record: RecordView;
    output?: OutputState;
    onLoadOutput: () => void;
    onCopy: (kind: "command" | "output") => void;
    onCopyAll: () => void;
}) => {
    const copyButtonProps = {
        onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
        type: "button" as const,
    };
    return (
        <article className="command-card" data-command-id={record.id}>
            <div className="command-card-header">
                <code className="command-card-command">{record.command}</code>
                <span className={`command-card-status command-card-status-${statusLabel(record)}`}>
                    {statusLabel(record)}
                </span>
            </div>
            <div className="command-card-meta">
                <span>exit {record.exit_code ?? "—"}</span>
                <span>{record.execution_mode || "unknown"}</span>
                <span>{formatDuration(record)}</span>
                {record.cwd && <span title={record.cwd}>{record.cwd}</span>}
                <span>{record.output_stored_bytes}/{record.output_total_bytes} bytes{record.output_truncated ? " · truncated" : ""}</span>
            </div>
            <div className="command-card-actions">
                <button {...copyButtonProps} onClick={() => onCopy("command")}>Copy Command</button>
                <button {...copyButtonProps} disabled={!canCopyOutput(record)} onClick={() => onCopy("output")}>
                    Copy Output
                </button>
                <button {...copyButtonProps} disabled={!canCopyOutput(record)} onClick={onCopyAll}>Copy All</button>
                <button {...copyButtonProps} onClick={onLoadOutput}>{output?.projection ? "Hide Output" : "Show Output"}</button>
            </div>
            {output?.loading && <div className="command-card-output-note">Loading bounded output projection…</div>}
            {output?.projection?.kind === "safe" && <pre className="command-card-output">{output.projection.text}</pre>}
            {output?.projection?.kind === "unsafe" && <div className="command-card-output-note">{output.projection.reason}</div>}
        </article>
    );
};

export const CommandHistory = ({ blockId, model }: CommandHistoryProps) => {
    const [records, setRecords] = React.useState<RecordView[]>([]);
    const [health, setHealth] = React.useState<HealthView | null>(null);
    const [outputs, setOutputs] = React.useState<Record<string, OutputState>>({});
    const [message, setMessage] = React.useState<string | null>(null);
    const mounted = React.useRef(true);
    const requestEpoch = React.useRef(new HistoryRequestEpoch());

    const refresh = React.useCallback(async () => {
        const capturedEpoch = requestEpoch.current.capture();
        try {
            const next = await services.CommandJournalService.ListVisibleRecords(blockId);
            if (mounted.current && requestEpoch.current.isCurrent(capturedEpoch)) setRecords(limitVisibleRecords(next ?? []));
        } catch (error) {
            if (mounted.current && requestEpoch.current.isCurrent(capturedEpoch)) setMessage(`History unavailable: ${String(error)}`);
        }
    }, [blockId]);

    React.useEffect(() => {
        mounted.current = true;
        requestEpoch.current.bump();
        setRecords([]);
        setOutputs({});
        void refresh();
        const interval = window.setInterval(() => void refresh(), 750);
        const healthInterval = window.setInterval(async () => {
            try {
                const next = await services.CommandJournalService.GetHealth();
                if (mounted.current) setHealth(next);
            } catch (error) {
                if (mounted.current) setMessage(`Persistence health unavailable: ${String(error)}`);
            }
        }, 2000);
        return () => {
            mounted.current = false;
            window.clearInterval(interval);
            window.clearInterval(healthInterval);
        };
    }, [refresh]);

    const loadOutput = React.useCallback(async (record: RecordView) => {
        const current = outputs[record.id];
        if (current?.projection) {
            setOutputs((old) => ({ ...old, [record.id]: { loading: false } }));
            return;
        }
        if (!canCopyOutput(record)) {
            setOutputs((old) => ({ ...old, [record.id]: { loading: false, projection: { kind: "unsafe", reason: "Output is not complete, text-safe, and bounded." } } }));
            return;
        }
        setOutputs((old) => ({ ...old, [record.id]: { loading: true } }));
        try {
            const output = await services.CommandJournalService.GetOutput(record.id);
            const projection = projectOutput(record, output?.data ?? "");
            if (mounted.current) setOutputs((old) => ({ ...old, [record.id]: { loading: false, projection, data64: output?.data } }));
        } catch (error) {
            if (mounted.current) setOutputs((old) => ({ ...old, [record.id]: { loading: false, projection: { kind: "unsafe", reason: `Output unavailable: ${String(error)}` } } }));
        }
    }, [outputs]);

    const copyRecord = React.useCallback(async (record: RecordView, kind: "command" | "output" | "all") => {
        let text = record.command;
        if (kind !== "command") {
            if (!canCopyOutput(record)) {
                setMessage("Output copy disabled because the product data is incomplete, unsafe, or truncated.");
                return;
            }
            const output = await services.CommandJournalService.GetOutput(record.id);
            const projection = projectOutput(record, output?.data ?? "");
            if (projection.kind !== "safe") {
                setMessage(projection.reason);
                return;
            }
            text = kind === "all" ? `${record.command}\n${projection.text}` : projection.text;
        }
        try {
            await navigator.clipboard.writeText(text);
            setMessage(`Copied ${kind === "all" ? "command and output" : kind}.`);
        } catch (error) {
            setMessage(`Clipboard unavailable: ${String(error)}`);
        }
    }, []);

    const clear = React.useCallback(async () => {
        try {
            requestEpoch.current.bump();
            await clearProductHistory(blockId, services.CommandJournalService, () => model.termRef.current?.clearVisualBuffer());
            setOutputs({});
            await refresh();
            setMessage("Visual history cleared; PowerShell session preserved.");
        } catch (error) {
            setMessage(`Clear failed; terminal was not cleared: ${String(error)}`);
        }
    }, [blockId, model, refresh]);

    return (
        <section className="command-history" aria-label="Command history">
            <div className="command-history-toolbar">
                <span>Command History</span>
                {health && <span className={`command-history-health command-history-health-${health.status}`}>
                    persistence: {health.status}{health.output_complete === false ? " · output may be incomplete" : ""}
                </span>}
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={clear}>Clear Visual History</button>
            </div>
            {message && <div className="command-history-message" role="status">{message}</div>}
            <div className="command-history-list">
                {records.map((record) => (
                    <CommandCard
                        key={record.id}
                        record={record}
                        output={outputs[record.id]}
                        onLoadOutput={() => void loadOutput(record)}
                        onCopy={(kind) => void copyRecord(record, kind)}
                        onCopyAll={() => void copyRecord(record, "all")}
                    />
                ))}
                {records.length === 0 && <div className="command-history-empty">No completed commands in the current visible generation.</div>}
            </div>
        </section>
    );
};
