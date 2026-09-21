// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import * as React from "react";
import { uiText } from "@/util/ui-locale";
import { copyCommandAndOutput } from "./command-copy-all";
import { canCopyOutput } from "./command-history";
import type { CommandAnchorSnapshot, TermWrap } from "./termwrap";
import { adjacentId, reconcileSelection, type RegionSelection } from "./command-region-selection";
import { TerminalClearAction } from "./terminal-clear-action";
import type { TermViewModel } from "./term-model";
import { Search } from "@/app/element/search";
import { TermStickers } from "./termsticker";

export type CommandAnchor = Readonly<{ commandId: string }>;

export type MatchedCommandAnchor = Readonly<{ commandId: string; record: RecordView }>;

export type RelativeNavigationDirection = "previous" | "next";


export class RailRequestEpoch {
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

export function matchConfirmedAnchors(
    anchors: readonly CommandAnchor[],
    records: readonly RecordView[]
): MatchedCommandAnchor[] {
    const recordsById = new Map(records.map((record) => [record.id, record]));
    return anchors.flatMap((anchor) => {
        const record = recordsById.get(anchor.commandId);
        return record == null ? [] : [{ commandId: anchor.commandId, record }];
    });
}

function recordsAreSettling(anchors: readonly CommandAnchor[], records: readonly RecordView[]): boolean {
    const recordsById = new Map(records.map((record) => [record.id, record]));
    return anchors.some((anchor) => {
        const record = recordsById.get(anchor.commandId);
        return record == null || record.state === "running" || record.output_state !== "closed";
    });
}

type CommandAnchorSource = Pick<TermWrap, "getCommandAnchorSnapshot" | "subscribeCommandAnchors">;

export function subscribeCommandAnchors(
    termWrap: CommandAnchorSource,
    listener: (anchors: readonly CommandAnchorSnapshot[]) => void
): () => void {
    const refreshAnchors = () => listener(termWrap.getCommandAnchorSnapshot());
    refreshAnchors();
    return termWrap.subscribeCommandAnchors(refreshAnchors);
}

export class RailRecordPoller {
    private anchors: readonly CommandAnchor[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private inFlight = false;
    private pendingRefresh = false;
    private disposed = false;
    private epoch = new RailRequestEpoch();

    constructor(
        private queryRecords: () => Promise<RecordView[]>,
        private setRecords: (records: RecordView[]) => void,
        private intervalMs = 750,
        private setError?: (error: unknown) => void
    ) {}

    setAnchors(anchors: readonly CommandAnchor[]): void {
        this.epoch.bump();
        this.anchors = anchors;
        if (anchors.length === 0) {
            this.pendingRefresh = false;
            this.stopTimer();
            this.setRecords([]);
            return;
        }
        if (this.inFlight) {
            this.pendingRefresh = true;
            return;
        }
        this.stopTimer();
        void this.refresh();
    }

    dispose(): void {
        this.disposed = true;
        this.epoch.bump();
        this.pendingRefresh = false;
        this.stopTimer();
    }

    private ensureTimer(): void {
        if (this.timer == null && !this.disposed && this.anchors.length > 0) {
            this.timer = setTimeout(() => {
                this.timer = null;
                void this.refresh();
            }, this.intervalMs);
        }
    }

    private stopTimer(): void {
        if (this.timer != null) clearTimeout(this.timer);
        this.timer = null;
    }

    private async refresh(): Promise<void> {
        if (this.disposed || this.inFlight || this.anchors.length === 0) return;
        this.inFlight = true;
        const capturedEpoch = this.epoch.capture();
        try {
            const next = (await this.queryRecords()) ?? [];
            if (this.disposed || !this.epoch.isCurrent(capturedEpoch)) return;
            this.setRecords(next);
            if (recordsAreSettling(this.anchors, next)) this.ensureTimer();
            else this.stopTimer();
        } catch (error) {
            if (!this.disposed && this.epoch.isCurrent(capturedEpoch)) {
                this.setError?.(error);
                this.ensureTimer();
            }
        } finally {
            this.inFlight = false;
            if (this.pendingRefresh && !this.disposed && this.anchors.length > 0) {
                this.pendingRefresh = false;
                void this.refresh();
            }
        }
    }
}

type CommandNavigationRailProps = {
    blockId: string;
    termWrap: TermWrap;
};

export const CommandNavigationRail = ({ blockId, termWrap }: CommandNavigationRailProps) => {
    const [anchors, setAnchors] = React.useState<readonly CommandAnchorSnapshot[]>([]);
    const [records, setRecords] = React.useState<RecordView[]>([]);
    const [selection, setSelection] = React.useState<RegionSelection>({ selectedCommandId: null, followingLatest: true });
    const [message, setMessage] = React.useState<string | null>(null);
    const [copying, setCopying] = React.useState(false);
    const generation = React.useRef(0);
    const copyPending = React.useRef(false);
    const mounted = React.useRef(false);

    React.useEffect(() => {
        generation.current++;
        mounted.current = true;
        setAnchors([]); setRecords([]); setMessage(null);
        setSelection({ selectedCommandId: null, followingLatest: true });
        const poller = new RailRecordPoller(
            () => services.CommandJournalService.ListVisibleRecords(blockId), setRecords, 750,
            error => setMessage(uiText("command.unavailable", { detail: String(error) }))
        );
        const unsubscribe = subscribeCommandAnchors(termWrap, next => { setAnchors(next); poller.setAnchors(next); });
        return () => { mounted.current = false; generation.current++; unsubscribe(); poller.dispose(); termWrap.setSelectedCommandAnchor(null); };
    }, [blockId, termWrap]);

    const matched = matchConfirmedAnchors(anchors, records).filter(entry =>
        entry.record.wave_block_id === blockId && entry.record.execution_mode === "structured");
    const entries = matched.map(entry => ({ id: entry.commandId, completed: entry.record.state !== "running" }));
    const reconciled = reconcileSelection(selection, entries);
    const selectedId = reconciled.selectedCommandId;
    const selectedRecord = matched.find(entry => entry.commandId === selectedId)?.record;
    const ids = matched.map(entry => entry.commandId);
    const previousId = adjacentId(ids, selectedId, "previous");
    const nextId = adjacentId(ids, selectedId, "next");

    React.useEffect(() => {
        setSelection(current => current.selectedCommandId === reconciled.selectedCommandId &&
            current.followingLatest === reconciled.followingLatest ? current : reconciled);
    }, [reconciled.selectedCommandId, reconciled.followingLatest]);
    React.useEffect(() => {
        generation.current++;
        setMessage(null);
        termWrap.setSelectedCommandAnchor(selectedId);
    }, [termWrap, selectedId]);
    React.useEffect(() => {
        if (!message) return;
        const timer = setTimeout(() => setMessage(null), 3000);
        return () => clearTimeout(timer);
    }, [message]);

    const navigate = (id: string | null) => {
        if (id == null) return;
        if (termWrap.scrollToCommandAnchor(id)) {
            setSelection({ selectedCommandId: id, followingLatest: id === ids[ids.length - 1] });
        } else {
            setAnchors(termWrap.getCommandAnchorSnapshot());
        }
    };
    const canCopy = selectedRecord != null && selectedRecord.state !== "running" && canCopyOutput(selectedRecord);
    const copy = async () => {
        if (!canCopy || copyPending.current) return;
        copyPending.current = true; setCopying(true);
        const epoch = generation.current;
        try {
            const result = await copyCommandAndOutput(selectedRecord);
            if (epoch === generation.current) setMessage("reason" in result ? result.reason : uiText("command.copiedAndOutput"));
        } finally {
            copyPending.current = false;
            if (mounted.current) setCopying(false);
        }
    };
    // Reset pending UI on selection changes; the in-flight operation retains its captured identity.
    React.useEffect(() => { setCopying(copyPending.current); }, [selectedId]);

    return (
        <nav className="command-navigation-rail" aria-label={uiText("command.navigation")} data-selected-command-id={selectedId ?? ""}>
            <div className="command-navigation-rail-controls" role="group" aria-label={uiText("command.relativeNavigation")}>
                <button type="button" className="command-navigation-rail-control" disabled={!previousId}
                    aria-label={uiText("command.previous")} title={uiText("command.previous")}
                    onClick={() => navigate(previousId)}>↑</button>
                <span className="command-selection-position" aria-live="polite">{selectedId ? ids.indexOf(selectedId) + 1 : 0}/{ids.length}</span>
                <button type="button" className="command-navigation-rail-control" disabled={!nextId}
                    aria-label={uiText("command.next")} title={uiText("command.next")}
                    onClick={() => navigate(nextId)}>↓</button>
            </div>
            <button type="button" className="command-navigation-rail-copy" disabled={!canCopy || copying}
                aria-label={uiText("command.copyAndOutput")}
                title={canCopy ? uiText("command.copyAndOutput") : uiText("command.selectedUnavailable")}
                onClick={() => void copy()}>⧉</button>
            {message && <span className="command-navigation-rail-message" role="status">{message}</span>}
        </nav>
    );
};

// Shared production composition: TerminalView and the isolated renderer mount this exact JSX.
export const TerminalContentFrame = ({ blockId, model, termWrap, connectElemRef, searchProps, stickerConfig }: {
    blockId: string;
    model: Pick<TermViewModel, "blockId" | "termRef">;
    termWrap: TermWrap | null;
    connectElemRef: React.Ref<HTMLDivElement>;
    searchProps?: React.ComponentProps<typeof Search>;
    stickerConfig?: React.ComponentProps<typeof TermStickers>["config"];
}) => {
    const terminalSearchMaxWidth = React.useCallback(
        (referenceWidth: number) => Math.min(300, Math.max(0, referenceWidth - 12)),
        []
    );
    const terminalSearchClassName = ["terminal-search", searchProps?.className].filter(Boolean).join(" ");

    return (
        <div className="term-content-frame">
            {stickerConfig && <TermStickers config={stickerConfig} />}
            <div className="term-connectelem" ref={connectElemRef} />
            {termWrap != null && <aside className="terminal-action-gutter" aria-label={uiText("terminal.actions")}>
                <TerminalClearAction model={model} />
                <CommandNavigationRail key={blockId} blockId={blockId} termWrap={termWrap} />
            </aside>}
            {searchProps && (
                <Search
                    {...searchProps}
                    className={terminalSearchClassName}
                    maxWidth={terminalSearchMaxWidth}
                />
            )}
        </div>
    );
};
