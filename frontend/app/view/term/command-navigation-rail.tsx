// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import * as React from "react";
import { uiText } from "@/util/ui-locale";
import { copyCommandAndOutput } from "./command-copy-all";
import { canCopyRecordOutput } from "./command-copy-all";
import type { CommandAnchorSnapshot, TermWrap } from "./termwrap";
import { adjacentId, reconcileSelection, type RegionSelection } from "./command-region-selection";
import { TerminalClearAction } from "./terminal-clear-action";
import type { TermViewModel } from "./term-model";
import { isKnownAuthority } from "./visual-anchor";
import { Search } from "@/app/element/search";
import { TermStickers } from "./termsticker";

export type CommandAnchor = Readonly<{ commandId: string }>;

export type MatchedCommandAnchor = Readonly<{ commandId: string; record: RecordView }>;

/**
 * The epoch of the live session this Rail serves: the epoch of the newest confirmed anchor.
 * With no anchor there is no current session region, so nothing is navigable - a durable record
 * from an earlier app run is history, not a region of this terminal.
 */
export function currentSessionEpoch(anchors: readonly CommandAnchorSnapshot[]): string | null {
    const last = anchors[anchors.length - 1];
    return last != null && last.sessionEpoch !== "" ? last.sessionEpoch : null;
}

/** The ids a Rail may navigate: anchors that belong to the current live session. */
export function currentSessionAnchorIds(anchors: readonly CommandAnchorSnapshot[]): readonly string[] {
    const epoch = currentSessionEpoch(anchors);
    if (epoch == null) {
        return [];
    }
    return anchors.filter((anchor) => anchor.sessionEpoch === epoch).map((anchor) => anchor.commandId);
}

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

/**
 * The ids the poller should track. A rail with no listed records still tracks its block
 * so the next command is discovered, which is what makes an empty first poll recoverable.
 */
export function trackedIdsForRefresh(ids: readonly string[], blockId: string): readonly string[] {
    if (ids.length > 0) {
        return ids;
    }
    // An empty answer still has to keep the block tracked (otherwise the Rail would never see
    // the next command), but a missing block id tracks nothing.
    return blockId ? [blockId] : [];
}

/** The selection a navigation request produces, independent of any visual anchor. */
export function nextSelection(id: string, ids: readonly string[]): RegionSelection {
    return { selectedCommandId: id, followingLatest: id === ids[ids.length - 1] };
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

function recordsAreSettling(records: readonly RecordView[]): boolean {
    return records.some((record) => record.state === "running" || record.output_state !== "closed");
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
    private tracked: readonly string[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private inFlight = false;
    private pendingRefresh = false;
    private disposed = false;
    private epoch = new RailRequestEpoch();
    /** Rounds spent waiting for a tracked (confirmed) id to become visible. */
    private awaiting = 0;
    private static readonly MaxAwaitingRounds = 20;

    constructor(
        private queryRecords: () => Promise<RecordView[]>,
        private setRecords: (records: RecordView[]) => void,
        private intervalMs = 750,
        private setError?: (error: unknown) => void
    ) {}

    /**
     * Re-runs the query for the current tracked ids. The Rail calls this when a confirmed anchor
     * arrives, so a command executed in this session is discovered without waiting for the timer.
     */
    rearm(): void {
        if (this.disposed) {
            return;
        }
        this.awaiting = 0;
        if (this.inFlight) {
            this.pendingRefresh = true;
            return;
        }
        if (this.tracked.length === 0) {
            return;
        }
        this.stopTimer();
        void this.refresh();
    }

    setTracked(ids: readonly string[]): void {
        this.awaiting = 0;
        this.epoch.bump();
        this.tracked = ids;
        if (ids.length === 0) {
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
        if (this.timer == null && !this.disposed && this.tracked.length > 0) {
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
        if (this.disposed || this.inFlight || this.tracked.length === 0) return;
        this.inFlight = true;
        const capturedEpoch = this.epoch.capture();
        try {
            const next = (await this.queryRecords()) ?? [];
            if (this.disposed || !this.epoch.isCurrent(capturedEpoch)) return;
            this.setRecords(next);
            // A confirmed anchor can arrive before its record is visible. Waiting for it is bounded:
            // without that, a session whose startup records are all settled would stop polling and
            // never see the command the user just ran.
            const awaitingTracked = this.tracked.some((id) => !next.some((record) => record.id === id));
            if (awaitingTracked && this.awaiting < RailRecordPoller.MaxAwaitingRounds) {
                this.awaiting += 1;
                this.ensureTimer();
            } else if (recordsAreSettling(next)) {
                this.ensureTimer();
            } else {
                this.stopTimer();
            }
        } catch (error) {
            if (!this.disposed && this.epoch.isCurrent(capturedEpoch)) {
                this.setError?.(error);
                this.ensureTimer();
            }
        } finally {
            this.inFlight = false;
            if (this.pendingRefresh && !this.disposed && this.tracked.length > 0) {
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

    const pollerRef = React.useRef<RailRecordPoller | null>(null);
    const trackedIdsRef = React.useRef<readonly string[]>([]);
    React.useEffect(() => {
        generation.current++;
        mounted.current = true;
        setAnchors([]); setRecords([]); setMessage(null);
        setSelection({ selectedCommandId: null, followingLatest: true });

    const poller = new RailRecordPoller(
            () => services.CommandJournalService.ListVisibleRecords(blockId),
        setRecords, 750,
            error => setMessage(uiText("command.unavailable", { detail: String(error) }))
        );
        pollerRef.current = poller;
        // The poller tracks the records the rail lists, and the first poll happens
        // immediately so a block with history shows its commands without waiting for an
        // anchor to appear.
        poller.setTracked([blockId]);
        // A confirmed anchor means a command just entered the journal, so the anchor
        // subscription re-arms the poller: without this a rail that already settled (or
        // whose first query was empty) would never query again for the next command.
        const unsubscribe = subscribeCommandAnchors(termWrap, next => {
            setAnchors(next);
            // A confirmed anchor is the causal signal that a command of this session exists: track
            // its exact id and re-arm, so the record is fetched as soon as the journal has it.
            poller.setTracked(trackedIdsForRefresh(currentSessionAnchorIds(next), blockId));
            poller.rearm();
        });
        return () => { mounted.current = false; generation.current++; unsubscribe(); poller.dispose(); pollerRef.current = null; termWrap.setSelectedCommandAnchor(null); };
    }, [blockId, termWrap]);



    // A rail entry needs a confirmed authority, not a lifecycle mode: the
    // authority says which producer owns the command identity. The identity itself is
    // the record - a Global Clear drops the visual markers (and with them the anchors)
    // while the records stay, so the rail must list what the journal knows and use the
    // anchors only to scroll the terminal.
    const sessionEpoch = currentSessionEpoch(anchors);
    const listed =
        sessionEpoch == null
            ? []
            : records.filter(
                  (record) =>
                      record.wave_block_id === blockId &&
                      record.session_epoch === sessionEpoch &&
                      isKnownAuthority(record.authority)
              );
    const entries = listed.map((record) => ({ id: record.id, completed: record.state !== "running" }));
    const reconciled = reconcileSelection(selection, entries);
    const selectedId = reconciled.selectedCommandId;
    const selectedRecord = listed.find((record) => record.id === selectedId);
    const ids = entries.map((entry) => entry.id);
    // Keep the settling window honest: while any listed command is still running or its
    // output has not closed, keep polling; otherwise the poller stops on its own.
    React.useEffect(() => {
        trackedIdsRef.current = ids;
        pollerRef.current?.setTracked(trackedIdsForRefresh(ids, blockId));
    }, [ids.join("\u0000")]);
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
        // The record is the identity: selecting it must not depend on a marker being
        // scrollable. Anchors are best effort, so a cleared buffer still navigates.
        setSelection(nextSelection(id, ids));
        if (!termWrap.scrollToCommandAnchor(id)) setAnchors(termWrap.getCommandAnchorSnapshot());
    };
    const terminalRegion = (commandId: string) => termWrap.getTerminalOutputForCommand(commandId);
        const canCopy = selectedRecord != null && selectedRecord.state !== "running" && canCopyRecordOutput(selectedRecord, terminalRegion);
    const copy = async () => {
        if (!canCopy || copyPending.current) return;
        copyPending.current = true; setCopying(true);
        const epoch = generation.current;
        try {
            const result = await copyCommandAndOutput(selectedRecord, services.CommandJournalService, navigator.clipboard, terminalRegion);
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