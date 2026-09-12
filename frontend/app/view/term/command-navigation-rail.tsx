// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import * as React from "react";
import { copyCommandAndOutput } from "./command-copy-all";
import { canCopyOutput } from "./command-history";
import type { CommandAnchorSnapshot, TermWrap } from "./termwrap";

export type CommandAnchor = Readonly<{ commandId: string }>;

export type MatchedCommandAnchor = Readonly<{ commandId: string; record: RecordView }>;

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

type CommandNavigationRailProps = {
    blockId: string;
    termWrap: TermWrap;
};

export const CommandNavigationRail = ({ blockId, termWrap }: CommandNavigationRailProps) => {
    const [anchors, setAnchors] = React.useState<readonly CommandAnchorSnapshot[]>([]);
    const [records, setRecords] = React.useState<RecordView[]>([]);
    const [message, setMessage] = React.useState<string | null>(null);
    const requestEpoch = React.useRef(new RailRequestEpoch());

    React.useEffect(() => {
        requestEpoch.current.bump();
        setRecords([]);
        setMessage(null);
        const refreshAnchors = () => setAnchors(termWrap.getCommandAnchorSnapshot());
        refreshAnchors();
        return termWrap.subscribeCommandAnchors(refreshAnchors);
    }, [blockId, termWrap]);

    React.useEffect(() => {
        if (anchors.length === 0) {
            setRecords([]);
            return;
        }
        let cancelled = false;
        const refresh = async () => {
            const capturedEpoch = requestEpoch.current.capture();
            try {
                const next = await services.CommandJournalService.ListVisibleRecords(blockId);
                if (!cancelled && requestEpoch.current.isCurrent(capturedEpoch)) setRecords(next ?? []);
            } catch (error) {
                if (!cancelled && requestEpoch.current.isCurrent(capturedEpoch)) {
                    setMessage(`Commands unavailable: ${String(error)}`);
                }
            }
        };
        void refresh();
        const interval = recordsAreSettling(anchors, records) ? window.setInterval(() => void refresh(), 750) : null;
        return () => {
            cancelled = true;
            if (interval != null) window.clearInterval(interval);
        };
    }, [anchors, blockId, records]);

    const matched = matchConfirmedAnchors(anchors, records);
    const recordsById = new Map(matched.map((entry) => [entry.commandId, entry.record]));
    if (anchors.length === 0) return null;

    return (
        <nav className="command-navigation-rail" aria-label="Confirmed commands">
            {anchors.map((anchor) => {
                const record = recordsById.get(anchor.commandId);
                return (
                    <div className="command-navigation-rail-entry" key={anchor.commandId}>
                        <button
                            className="command-navigation-rail-mark"
                            type="button"
                            aria-label={`Jump to confirmed command ${anchor.commandId}`}
                            title="Jump to confirmed command"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => termWrap.scrollToCommandAnchor(anchor.commandId)}
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
