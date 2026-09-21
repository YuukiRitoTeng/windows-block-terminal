// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The reclaim rules against the facts a real machine actually produces.
 *
 * These facts were captured from a live installation (AppData DB + app log) after a shrink attempt
 * was refused, so they pin the production shapes the rules must accept:
 *
 *   - a plain local shell reports ShellProcStatus "running" and ShellProcConnName "" (empty),
 *   - `block.jobid` is absent, not an empty string,
 *   - the command journal is healthy and has zero records for a pane nobody typed in,
 *   - the pane the user typed into (or that was marked by mistake) is the focused one.
 */

import {
    SNAP_AUTOCREATED_META_KEY,
    SNAP_TOUCHED_META_KEY,
    SnapPaneFacts,
    judgeReclaimablePane,
    planSnapReclaim,
} from "@/app/workspace/snapReclaim";
import { assert, describe, test } from "vitest";

/** Exactly what `BlockService.GetControllerStatus` reports for a live local shell. */
const LOCAL_RUNNING_STATUS = { shellprocstatus: "running", shellprocconnname: "" };
/** Exactly what `CommandJournalService` reports for a pane with no commands. */
const EMPTY_JOURNAL = { healthy: true, recordCount: 0 };

function realFacts(
    blockId: string,
    options: { focused?: boolean; touched?: boolean; sticky?: boolean } = {}
): SnapPaneFacts {
    return {
        blockId,
        meta: {
            view: "term",
            controller: "shell",
            [SNAP_AUTOCREATED_META_KEY]: true,
            ...(options.touched ? { [SNAP_TOUCHED_META_KEY]: true } : {}),
        },
        // Absent in the real block record.
        jobId: null,
        runtimeStatus: LOCAL_RUNNING_STATUS,
        journal: EMPTY_JOURNAL,
        inTab: true,
        isSticky: options.sticky ?? false,
        isFocused: options.focused ?? false,
    };
}

describe("reclaim rules against real machine facts", () => {
    // The live layout: four Snap-created panes, the first one focused (and marked as touched).
    const liveFacts = [
        realFacts("1729e260-7016-4320-9829-b883c83c92ad", { focused: true, touched: true }),
        realFacts("befda903-89b7-4cd8-96e9-83114414526b"),
        realFacts("501d439f-13dd-4d40-b533-794d8b981f55"),
        realFacts("a35e89f1-c37c-42e9-b968-dbe0488d5ef1"),
    ];

    test("a live local shell pane is reclaimable", () => {
        const verdict = judgeReclaimablePane(realFacts("befda903-89b7-4cd8-96e9-83114414526b"));
        assert.isTrue(verdict.reclaimable, `refused with ${verdict.reason}`);
    });

    test("the real four-pane layout can shrink into a two-slot preset", () => {
        // One pane carries the touched marker; the rest must still be enough for a 4 -> 2 shrink.
        const planning = planSnapReclaim(liveFacts, 2);
        assert.isTrue(planning.ok, "the live layout must be able to shrink");
        if (planning.ok) {
            assert.lengthOf(planning.plan.reclaim, 2);
            assert.notInclude(planning.plan.reclaim, "1729e260-7016-4320-9829-b883c83c92ad");
        }
    });

    test("the focused pane is never reclaimed, and the dragged pane never is either", () => {
        const stickyFacts = liveFacts.map((facts) =>
            facts.blockId === "befda903-89b7-4cd8-96e9-83114414526b" ? { ...facts, isSticky: true } : facts
        );
        const planning = planSnapReclaim(stickyFacts, 2);
        assert.isTrue(planning.ok);
        if (planning.ok) {
            assert.notInclude(planning.plan.reclaim, "befda903-89b7-4cd8-96e9-83114414526b");
            assert.notInclude(planning.plan.reclaim, "1729e260-7016-4320-9829-b883c83c92ad");
            assert.deepEqual(planning.plan.reclaim, [
                "501d439f-13dd-4d40-b533-794d8b981f55",
                "a35e89f1-c37c-42e9-b968-dbe0488d5ef1",
            ]);
        }
    });

    test("a connection name of \"local\" is a local terminal, not a remote one", () => {
        // `IsLocalConnName` accepts "", "local" and "local:*"; only those are local.
        for (const connName of ["", "local", "local:gitbash"]) {
            const verdict = judgeReclaimablePane({
                ...realFacts("local-pane"),
                runtimeStatus: { shellprocstatus: "running", shellprocconnname: connName },
            });
            assert.isTrue(verdict.reclaimable, `connName ${JSON.stringify(connName)} must count as local`);
        }
        for (const connName of ["wsl://Ubuntu", "user@host", "ssh:host"]) {
            const verdict = judgeReclaimablePane({
                ...realFacts("remote-pane"),
                runtimeStatus: { shellprocstatus: "running", shellprocconnname: connName },
            });
            assert.isFalse(verdict.reclaimable, `connName ${JSON.stringify(connName)} must count as remote`);
        }
    });
});
