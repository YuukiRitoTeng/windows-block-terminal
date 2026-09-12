// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import * as React from "react";
import { copyCommandAndOutput } from "./command-copy-all";
import { canCopyOutput } from "./command-history";
import type { CommandAnchorSnapshot, TermWrap } from "./termwrap";

export type CommandAnchor = Readonly<{ commandId: string }>;

export type MatchedCommandAnchor = Readonly<{ commandId: string; record: RecordView }>;

export type RelativeNavigationDirection = "previous" | "next";

/** Selects an adjacent position using only the confirmed snapshot order. */
export function getRelativeAnchorIndex(
    anchorCount: number,
    activeIndex: number,
    direction: RelativeNavigationDirection
): number {
    if (anchorCount <= 0) return -1;
    if (!Number.isInteger(activeIndex) || activeIndex < 0) {
        return direction === "next" ? 0 : anchorCount - 1;
    }
    const currentIndex = Math.min(activeIndex, anchorCount - 1);
    return direction === "next"
        ? (currentIndex + 1) % anchorCount
        : (currentIndex - 1 + anchorCount) % anchorCount;
}

/** Keeps an active mark valid when the confirmed anchor snapshot changes. */
export function reconcileActiveAnchorIndex(
    previousAnchors: readonly CommandAnchorSnapshot[],
    nextAnchors: readonly CommandAnchorSnapshot[],
    activeIndex: number
): number {
    if (nextAnchors.length === 0) return -1;
    const sameSnapshot =
        previousAnchors.length === nextAnchors.length &&
        previousAnchors.every((anchor, index) => anchor.commandId === nextAnchors[index]?.commandId);
    if (sameSnapshot) {
        if (!Number.isInteger(activeIndex) || activeIndex < 0) return -1;
        return Math.min(activeIndex, nextAnchors.length - 1);
    }
    const previouslyActive = Number.isInteger(activeIndex) ? previousAnchors[activeIndex] : undefined;
    if (previouslyActive == null) return -1;
    return nextAnchors.findIndex((anchor) => anchor.commandId === previouslyActive.commandId);
}

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
    const [message, setMessage] = React.useState<string | null>(null);
    const [activeAnchorIndex, setActiveAnchorIndex] = React.useState(-1);
    const previousAnchorsRef = React.useRef<readonly CommandAnchorSnapshot[]>([]);

    React.useEffect(() => {
        setAnchors([]);
        setRecords([]);
        setMessage(null);
        setActiveAnchorIndex(-1);
        previousAnchorsRef.current = [];
        const poller = new RailRecordPoller(
            () => services.CommandJournalService.ListVisibleRecords(blockId),
            setRecords,
            750,
            (error) => setMessage(`Commands unavailable: ${String(error)}`)
        );
        const unsubscribe = subscribeCommandAnchors(termWrap, (nextAnchors) => {
            setAnchors(nextAnchors);
            poller.setAnchors(nextAnchors);
        });
        return () => {
            unsubscribe();
            poller.dispose();
        };
    }, [blockId, termWrap]);

    React.useEffect(() => {
        const previousAnchors = previousAnchorsRef.current;
        previousAnchorsRef.current = anchors;
        setActiveAnchorIndex((current) => reconcileActiveAnchorIndex(previousAnchors, anchors, current));
    }, [anchors]);

    const matched = matchConfirmedAnchors(anchors, records);
    const recordsById = new Map(matched.map((entry) => [entry.commandId, entry.record]));

    const scrollToAnchor = React.useCallback(
        (index: number) => {
            const target = anchors[index];
            if (target == null) return false;
            const didScroll = termWrap.scrollToCommandAnchor(target.commandId);
            if (didScroll) {
                setActiveAnchorIndex(index);
            }
            return didScroll;
        },
        [anchors, termWrap]
    );

    const navigateRelative = React.useCallback(
        (direction: RelativeNavigationDirection) => {
            const targetIndex = getRelativeAnchorIndex(anchors.length, activeAnchorIndex, direction);
            if (targetIndex < 0) return;
            scrollToAnchor(targetIndex);
        },
        [activeAnchorIndex, anchors.length, scrollToAnchor]
    );

    if (anchors.length === 0) return null;

    return (
        <nav className="command-navigation-rail" aria-label="Confirmed command navigation">
            <div className="command-navigation-rail-controls" role="group" aria-label="Relative command navigation">
                <button
                    className="command-navigation-rail-control"
                    type="button"
                    aria-label="Previous confirmed command"
                    title="Previous confirmed command"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigateRelative("previous")}
                >
                    Prev
                </button>
                <button
                    className="command-navigation-rail-control"
                    type="button"
                    aria-label="Next confirmed command"
                    title="Next confirmed command"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigateRelative("next")}
                >
                    Next
                </button>
            </div>
            {anchors.map((anchor, index) => {
                const record = recordsById.get(anchor.commandId);
                return (
                    <div className="command-navigation-rail-entry" key={anchor.commandId}>
                        <button
                            className={`command-navigation-rail-mark${activeAnchorIndex === index ? " is-active" : ""}`}
                            type="button"
                            aria-label={`Jump to confirmed command ${anchor.commandId}`}
                            title="Jump to confirmed command"
                            aria-current={activeAnchorIndex === index ? "true" : undefined}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                                scrollToAnchor(index);
                            }}
                        />
                        {record != null && (
                            <button
                                className="command-navigation-rail-copy"
                                type="button"
                                aria-label="Copy command and output"
                                title="Copy command and output"
                                disabled={!canCopyOutput(record)}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                    void copyCommandAndOutput(record).then((result) => {
                                        setMessage("reason" in result ? result.reason : "Copied command and output.");
                                    });
                                }}
                            >
                                All
                            </button>
                        )}
                    </div>
                );
            })}
            {message != null && (
                <span className="command-navigation-rail-message" role="status">
                    {message}
                </span>
            )}
        </nav>
    );
};
