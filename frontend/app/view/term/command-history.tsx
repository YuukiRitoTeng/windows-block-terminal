// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import { base64ToArray } from "@/util/util";
import { uiText } from "@/util/ui-locale";
import * as React from "react";
import type { TermViewModel } from "./term-model";
import { clearProductHistory } from "./clear-product-history";
import { copyCommandAndOutput } from "./command-copy-all";

export { clearProductHistory } from "./clear-product-history";

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

export class RefreshRequestGate {
    private nextToken = 0;
    private activeToken: number | null = null;

    acquire(): number | null {
        if (this.activeToken !== null) return null;
        const token = ++this.nextToken;
        this.activeToken = token;
        return token;
    }

    release(token: number): void {
        if (this.activeToken === token) this.activeToken = null;
    }

    invalidate(): void {
        this.activeToken = null;
    }
}

export function historyInspectorClass(open: boolean): string {
    return "command-history " + (open ? "is-open" : "is-collapsed");
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
            return { kind: "unsafe", reason: uiText("command.interactiveOutput") };
        }
        return { kind: "unsafe", reason: uiText("command.unsafeOutput") };
    }
    if (record.output_stored_bytes > MAX_PRESENTATION_BYTES) {
        return { kind: "unsafe", reason: uiText("command.largeOutput") };
    }
    try {
        const bytes = base64ToArray(data64 ?? "");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const sanitized = sanitizeTerminalText(text);
        if (sanitized == null) {
            return { kind: "unsafe", reason: uiText("command.controlOutput") };
        }
        return { kind: "safe", text: sanitized };
    } catch {
        return { kind: "unsafe", reason: uiText("command.invalidUtf8") };
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

type CommandHistoryProps = {
    blockId: string;
    model: TermViewModel;
};

type OutputState = { loading: boolean; projection?: OutputProjection; data64?: string };

const statusLabel = (record: RecordView) => {
    if (record.state === "running") return "running";
    if (record.success === true) return "success";
    if (record.success === false) return "failed";
    return "unknown";
};

const statusText = (record: RecordView) => {
    if (record.state === "running") return uiText("command.running");
    if (record.success === true) return uiText("command.success");
    if (record.success === false) return uiText("command.failed");
    return uiText("command.unknown");
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
        <article className="command-card" data-command-id={record.id} data-status={statusLabel(record)}>
            <div className="command-card-header">
                <code className="command-card-command">{record.command}</code>
                <span className={`command-card-status command-card-status-${statusLabel(record)}`}>
                    {statusText(record)}
                </span>
            </div>
            <div className="command-card-meta">
                <span className="command-card-meta-primary">{uiText("command.exit", { code: record.exit_code ?? "—" })}</span>
                <span>{record.execution_mode || "unknown"}</span>
                <span>{formatDuration(record)}</span>
                {record.cwd && <span className="command-card-meta-cwd" title={record.cwd}>{record.cwd}</span>}
                <span>{record.output_stored_bytes}/{record.output_total_bytes} {uiText("command.bytes")}{record.output_truncated ? ` · ${uiText("command.truncated")}` : ""}</span>
            </div>
            <div className="command-card-actions">
                <button {...copyButtonProps} aria-label={uiText("command.copy")} title={uiText("command.copy")} onClick={() => onCopy("command")}>
                    <i className="fa-sharp fa-light fa-copy" aria-hidden="true" /> <span>{uiText("command.command")}</span>
                </button>
                <button {...copyButtonProps} aria-label={uiText("command.output")} title={uiText("command.output")} disabled={!canCopyOutput(record)} onClick={() => onCopy("output")}>
                    <i className="fa-sharp fa-light fa-file-lines" aria-hidden="true" /> <span>{uiText("command.outputLabel")}</span>
                </button>
                <button {...copyButtonProps} aria-label={uiText("command.copyAndOutput")} title={uiText("command.copyAndOutput")} disabled={!canCopyOutput(record)} onClick={onCopyAll}>
                    <i className="fa-sharp fa-light fa-clipboard" aria-hidden="true" /> <span>{uiText("command.all")}</span>
                </button>
                <button {...copyButtonProps} aria-label={output?.projection ? uiText("command.hideOutput") : uiText("command.showOutput")} title={output?.projection ? uiText("command.hideOutput") : uiText("command.showOutput")} onClick={onLoadOutput}>
                    <i className={`fa-sharp fa-light ${output?.projection ? "fa-eye-slash" : "fa-eye"}`} aria-hidden="true" /> <span>{output?.projection ? uiText("command.hide") : uiText("command.show")}</span>
                </button>
            </div>
            {output?.loading && <div className="command-card-output-note">{uiText("command.loadingOutput")}</div>}
            {output?.projection?.kind === "safe" && <pre className="command-card-output">{output.projection.text}</pre>}
            {output?.projection?.kind === "unsafe" && <div className="command-card-output-note">{output.projection.reason}</div>}
        </article>
    );
};

export const CommandHistory = ({ blockId, model }: CommandHistoryProps) => {
    const [historyOpen, setHistoryOpen] = React.useState(false);
    const [records, setRecords] = React.useState<RecordView[]>([]);
    const [health, setHealth] = React.useState<HealthView | null>(null);
    const [outputs, setOutputs] = React.useState<Record<string, OutputState>>({});
    const [message, setMessage] = React.useState<string | null>(null);
    const mounted = React.useRef(true);
    const requestEpoch = React.useRef(new HistoryRequestEpoch());
    const refreshGate = React.useRef(new RefreshRequestGate());
    const previousBlockId = React.useRef(blockId);

    const refresh = React.useCallback(async () => {
        const requestToken = refreshGate.current.acquire();
        if (requestToken === null) return;
        const capturedEpoch = requestEpoch.current.capture();
        try {
            const next = await services.CommandJournalService.ListVisibleRecords(blockId);
            if (mounted.current && requestEpoch.current.isCurrent(capturedEpoch)) setRecords(limitVisibleRecords(next ?? []));
        } catch (error) {
            if (mounted.current && requestEpoch.current.isCurrent(capturedEpoch)) setMessage(uiText("command.historyUnavailable", { detail: String(error) }));
        } finally {
            refreshGate.current.release(requestToken);
        }
    }, [blockId]);

    const refreshHealth = React.useCallback(async () => {
        try {
            const next = await services.CommandJournalService.GetHealth();
            if (mounted.current) setHealth(next);
        } catch (error) {
            if (mounted.current) setMessage(uiText("command.persistenceUnavailable", { detail: String(error) }));
        }
    }, []);

    React.useEffect(() => {
        if (previousBlockId.current !== blockId) {
            previousBlockId.current = blockId;
            setRecords([]);
            setOutputs({});
        }
        requestEpoch.current.bump();
        mounted.current = true;
        refreshGate.current.invalidate();
        if (!historyOpen) {
            return () => {
                mounted.current = false;
                refreshGate.current.invalidate();
            };
        }
        void refresh();
        void refreshHealth();
        const interval = window.setInterval(() => void refresh(), 750);
        const healthInterval = window.setInterval(() => void refreshHealth(), 2000);
        return () => {
            mounted.current = false;
            refreshGate.current.invalidate();
            window.clearInterval(interval);
            window.clearInterval(healthInterval);
        };
    }, [blockId, historyOpen, refresh, refreshHealth]);

    const loadOutput = React.useCallback(async (record: RecordView) => {
        const current = outputs[record.id];
        if (current?.projection) {
            setOutputs((old) => ({ ...old, [record.id]: { loading: false } }));
            return;
        }
        if (!canCopyOutput(record)) {
            setOutputs((old) => ({ ...old, [record.id]: { loading: false, projection: { kind: "unsafe", reason: uiText("command.unsafeOutput") } } }));
            return;
        }
        setOutputs((old) => ({ ...old, [record.id]: { loading: true } }));
        try {
            const output = await services.CommandJournalService.GetOutput(record.id);
            const projection = projectOutput(record, output?.data ?? "");
            if (mounted.current) setOutputs((old) => ({ ...old, [record.id]: { loading: false, projection, data64: output?.data } }));
        } catch (error) {
            if (mounted.current) setOutputs((old) => ({ ...old, [record.id]: { loading: false, projection: { kind: "unsafe", reason: uiText("command.outputUnavailable", { detail: String(error) }) } } }));
        }
    }, [outputs]);

    const copyRecord = React.useCallback(async (record: RecordView, kind: "command" | "output" | "all") => {
        if (kind === "all") {
            const result = await copyCommandAndOutput(record);
            setMessage("reason" in result ? result.reason : uiText("command.copiedAndOutput"));
            return;
        }
        let text = record.command;
        if (kind !== "command") {
            if (!canCopyOutput(record)) {
            setMessage(uiText("command.copyDisabled"));
                return;
            }
            const output = await services.CommandJournalService.GetOutput(record.id);
            const projection = projectOutput(record, output?.data ?? "");
            if (projection.kind !== "safe") {
                setMessage(projection.reason);
                return;
            }
            text = projection.text;
        }
        try {
            await navigator.clipboard.writeText(text);
            setMessage(uiText("command.copied", { kind }));
        } catch (error) {
            setMessage(uiText("command.clipboardUnavailable", { detail: String(error) }));
        }
    }, []);

    const clear = React.useCallback(async () => {
        try {
            requestEpoch.current.bump();
            await clearProductHistory(blockId, services.CommandJournalService, () => model.termRef.current?.clearVisualBuffer());
            setOutputs({});
            refreshGate.current.invalidate();
            await refresh();
            setMessage(uiText("command.cleared"));
        } catch (error) {
            setMessage(uiText("command.clearFailed", { detail: String(error) }));
        }
    }, [blockId, model, refresh]);

    return (
        <section className={historyInspectorClass(historyOpen)} aria-label={uiText("command.history")} data-history-open={historyOpen}>
            <div className="command-history-toolbar">
                <span className="command-history-title"><i className="command-history-title-icon fa-sharp fa-light fa-terminal" aria-hidden="true" />{uiText("command.history")}</span>
                {health && <span className={`command-history-health command-history-health-${health.status}`}>
                    <i className="fa-sharp fa-light fa-database" aria-hidden="true" />{health.status}{health.output_complete === false ? ` · ${uiText("command.outputIncomplete")}` : ""}
                </span>}
                <button className="command-history-toggle" type="button" aria-expanded={historyOpen} aria-label={historyOpen ? uiText("command.closeHistory") : uiText("command.openHistory")} title={historyOpen ? uiText("command.closeHistory") : uiText("command.openHistory")} onMouseDown={(event) => event.preventDefault()} onClick={() => setHistoryOpen((open) => !open)}>
                    <i className={historyOpen ? "fa-sharp fa-light fa-eye-slash" : "fa-sharp fa-light fa-clock-rotate-left"} aria-hidden="true" /> <span>{historyOpen ? uiText("command.close") : uiText("command.historyShort")}</span>
                </button>
                <button className="command-history-clear" type="button" aria-label={uiText("terminal.clearVisualHistory")} title={uiText("terminal.clearVisualHistory")} onMouseDown={(event) => event.preventDefault()} onClick={clear}>
                    <i className="fa-sharp fa-light fa-broom" aria-hidden="true" /> <span>{uiText("command.clear")}</span>
                </button>
            </div>
            {message && <div className="command-history-message" role="status" hidden={!historyOpen}>{message}</div>}
            <div className="command-history-list" hidden={!historyOpen}>
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
                {records.length === 0 && <div className="command-history-empty">{uiText("command.empty")}</div>}
            </div>
        </section>
    );
};
