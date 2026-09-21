// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reclaim rules for preset down-sizing.
 *
 * The rule under test is "only an empty, unused, Snap-created local terminal may be removed". Every
 * case here is a reason to refuse, and the default is refusal: a missing runtime status, an unhealthy
 * command journal or a missing block record all end in "not reclaimable".
 */

import {
    SNAP_AUTOCREATED_META_KEY,
    SNAP_TOUCHED_META_KEY,
    SnapPaneFacts,
    SnapReclaimRefusal,
    judgeReclaimablePane,
    planSnapReclaim,
} from "@/app/workspace/snapReclaim";
import { assert, describe, test } from "vitest";

/** The one pane shape that may be reclaimed: an unused Snap-created local terminal. */
function filler(overrides: Partial<SnapPaneFacts> = {}): SnapPaneFacts {
    return {
        blockId: "filler-1",
        meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: true },
        jobId: "",
        runtimeStatus: { shellprocstatus: "running" },
        journal: { healthy: true, recordCount: 0 },
        inTab: true,
        isSticky: false,
        isFocused: false,
        ...overrides,
    };
}

function refusalOf(facts: SnapPaneFacts): SnapReclaimRefusal | undefined {
    const verdict = judgeReclaimablePane(facts);
    return "reason" in verdict ? verdict.reason : undefined;
}

/** The block id of a pane that must be refused, or undefined when it was judged reclaimable. */
function refusedBlockOf(facts: SnapPaneFacts): string | undefined {
    const verdict = judgeReclaimablePane(facts);
    return verdict.reclaimable ? undefined : verdict.blockId;
}

describe("reclaim: the safe shape", () => {
    test("an unused Snap-created local terminal may be reclaimed", () => {
        assert.deepEqual(judgeReclaimablePane(filler()), { blockId: "filler-1", reclaimable: true });
    });

    test("idle shell process states are fine: usage is decided by the journal, not the process", () => {
        assert.isUndefined(refusalOf(filler({ runtimeStatus: { shellprocstatus: "running" } })));
        assert.isUndefined(refusalOf(filler({ runtimeStatus: { shellprocstatus: "done" } })));
        assert.isUndefined(refusalOf(filler({ runtimeStatus: {} })), "a status without a state is not connecting");
    });
});

describe("reclaim: provenance", () => {
    test("a pane without the Snap provenance marker is never reclaimed", () => {
        assert.equal(refusalOf(filler({ meta: { view: "term", controller: "shell" } })), "no-snap-provenance");
    });

    test("looking like a terminal is not provenance", () => {
        // Same view/controller, no marker: exactly the inference the rule forbids.
        assert.equal(
            refusalOf(filler({ meta: { view: "term", controller: "shell", connection: undefined } })),
            "no-snap-provenance"
        );
    });

    test("a marker with the wrong type is not provenance", () => {
        assert.equal(refusalOf(filler({ meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: "true" } })), "no-snap-provenance");
    });

    test("a missing block record is a refusal", () => {
        assert.equal(refusalOf(filler({ meta: null })), "no-snap-provenance");
        assert.equal(refusalOf(filler({ meta: undefined })), "no-snap-provenance");
    });

    test("a pane the user typed into is never reclaimed", () => {
        assert.equal(
            refusalOf(
                filler({
                    meta: {
                        view: "term",
                        controller: "shell",
                        [SNAP_AUTOCREATED_META_KEY]: true,
                        [SNAP_TOUCHED_META_KEY]: true,
                    },
                })
            ),
            "touched-by-user"
        );
    });
});

describe("reclaim: sessions and connections", () => {
    test("an SSH or WSL pane is never reclaimed", () => {
        assert.equal(
            refusalOf(filler({ meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: true, connection: "user@host" } })),
            "remote-connection"
        );
    });

    test("a remote connection reported by the runtime is never reclaimed", () => {
        assert.equal(
            refusalOf(filler({ runtimeStatus: { shellprocstatus: "running", shellprocconnname: "wsl://Ubuntu" } })),
            "remote-connection"
        );
    });

    test("a pane with a job or durable session is never reclaimed", () => {
        assert.equal(refusalOf(filler({ jobId: "job-1" })), "has-job-or-session");
    });

    test("a pane that is not a local terminal is never reclaimed", () => {
        assert.equal(
            refusalOf(filler({ meta: { view: "web", controller: "none", [SNAP_AUTOCREATED_META_KEY]: true } })),
            "not-a-local-terminal"
        );
        assert.equal(
            refusalOf(filler({ meta: { view: "term", controller: "cmd", [SNAP_AUTOCREATED_META_KEY]: true } })),
            "not-a-local-terminal"
        );
    });
});

describe("reclaim: usage", () => {
    test("a pane with command history is never reclaimed", () => {
        assert.equal(refusalOf(filler({ journal: { healthy: true, recordCount: 1 } })), "has-command-history");
    });

    test("an unhealthy or unreadable journal is a refusal, not an assumption", () => {
        assert.equal(refusalOf(filler({ journal: { healthy: false, recordCount: 0 } })), "journal-unavailable");
        assert.equal(refusalOf(filler({ journal: null })), "journal-unavailable");
        assert.equal(refusalOf(filler({ journal: undefined })), "journal-unavailable");
    });

    test("an unknown runtime status is a refusal", () => {
        assert.equal(refusalOf(filler({ runtimeStatus: null })), "runtime-status-unknown");
        assert.equal(refusalOf(filler({ runtimeStatus: undefined })), "runtime-status-unknown");
    });

    test("a pane that is mid-connection is a refusal", () => {
        assert.equal(refusalOf(filler({ runtimeStatus: { shellprocstatus: "init" } })), "runtime-connecting");
        assert.equal(refusalOf(filler({ runtimeStatus: { shellprocstatus: "connecting" } })), "runtime-connecting");
    });
});

describe("reclaim: panes that are in use right now", () => {
    test("the pane being dragged is never reclaimed", () => {
        assert.equal(refusalOf(filler({ isSticky: true })), "sticky-pane");
    });

    test("the focused pane is never reclaimed", () => {
        assert.equal(refusalOf(filler({ isFocused: true })), "focused-pane");
    });

    test("a pane in another mutation is never reclaimed", () => {
        assert.equal(refusalOf(filler({ inOtherMutation: true })), "in-other-mutation");
    });

    test("a pane the tab does not own is never reclaimed", () => {
        assert.equal(refusalOf(filler({ inTab: false })), "not-in-tab");
    });
});

describe("reclaim: planning", () => {
    test("plans exactly the panes that are needed", () => {
        const facts = [filler({ blockId: "a" }), filler({ blockId: "b" }), filler({ blockId: "c" })];
        const planning = planSnapReclaim(facts, 2);
        assert.isTrue(planning.ok);
        if (planning.ok) {
            assert.deepEqual(planning.plan.reclaim, ["a", "b"]);
            assert.deepEqual(planning.plan.candidates, ["a", "b", "c"], "the third stays available, unused");
            assert.isEmpty(planning.plan.refused);
        }
    });

    test("refuses when not enough panes are safe to remove", () => {
        const facts = [
            filler({ blockId: "a" }),
            filler({
                blockId: "ssh",
                meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: true, connection: "h" },
            }),
        ];
        const planning = planSnapReclaim(facts, 2);
        assert.isFalse(planning.ok);
        if (!planning.ok) {
            assert.equal(planning.reason, "insufficient-reclaimable");
            assert.isEmpty(planning.plan.reclaim, "a refusal removes nothing at all");
            assert.deepEqual(planning.plan.candidates, ["a"], "the one safe pane is reported, not removed");
            assert.deepEqual(planning.plan.refused, [{ blockId: "ssh", reason: "remote-connection" }]);
        }
    });

    test("a mixed layout keeps every non-safe pane and reports why", () => {
        const facts = [
            filler({ blockId: "filler-1" }),
            filler({ blockId: "ssh-pane", meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: true, connection: "h" } }),
            filler({ blockId: "used-pane", journal: { healthy: true, recordCount: 3 } }),
            filler({ blockId: "durable-pane", jobId: "job-9" }),
            filler({ blockId: "unknown-pane", runtimeStatus: null }),
            filler({ blockId: "wsl-pane", runtimeStatus: { shellprocconnname: "wsl://Ubuntu" } }),
        ];
        const planning = planSnapReclaim(facts, 2);
        assert.isFalse(planning.ok, "only one pane is safe, so two removals must be refused");
        if (!planning.ok) {
            assert.isEmpty(planning.plan.reclaim);
            assert.deepEqual(planning.plan.candidates, ["filler-1"]);
            assert.deepEqual(
                planning.plan.refused.map((entry) => entry.reason),
                ["remote-connection", "has-command-history", "has-job-or-session", "runtime-status-unknown", "remote-connection"]
            );
        }
    });

    test("needing nothing reclaims nothing", () => {
        const planning = planSnapReclaim([filler({ blockId: "a" })], 0);
        assert.isTrue(planning.ok);
        if (planning.ok) {
            assert.isEmpty(planning.plan.reclaim);
            assert.deepEqual(planning.plan.candidates, ["a"]);
        }
    });
});
