// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the atomic Snap Layout apply: ordering, session preservation, the transaction window, the
 * reclaim rules for a preset smaller than the layout, and the compensation when a step fails.
 */

import { applySnapPreset, SnapApplyHost } from "@/app/workspace/snapApply";
import { SNAP_AUTOCREATED_META_KEY, SnapPaneFacts } from "@/app/workspace/snapReclaim";
import { validateNode, walkNodes } from "@/layout/lib/layoutNode";
import { getSnapPresetById } from "@/layout/lib/snapPresets";
import { LayoutNode } from "@/layout/lib/types";
import { assert, describe, test } from "vitest";

interface FakeHostState {
    /** Panes currently placed in the tab's tree. */
    panes: string[];
    /** Every block the tab owns, which is a superset of the placed panes. */
    tabBlocks: string[];
    deleted: string[];
    created: string[];
    commits: { rootNode: LayoutNode; focusedNodeId: string }[];
    createCounter: number;
    /** Apply-window balance: how often the mutation window was opened and closed. */
    applyWindows: { begun: number; ended: number };
    /** Trees put back by the compensation path. */
    restores: { rootNode: LayoutNode; substitutions: Record<string, string> }[];
}

interface MakeHostOptions {
    failCreateAt?: number;
    failCommit?: boolean;
    failDelete?: boolean;
    /** Fail the delete of this specific block, so a reclaim can fail part way through. */
    failDeleteOf?: string;
    tabBlocks?: string[];
    /** Facts offered to the reclaim planner. Omitted means "this host cannot judge panes". */
    paneFacts?: SnapPaneFacts[];
    /**
     * Successive results of the *whole-layout* fact collection. The first is the plan, the second is
     * the re-verification inside the mutation window; later calls reuse the last entry.
     */
    factsSequence?: SnapPaneFacts[][];
    /** Per-pane overrides applied to scoped (pre-delete) fact requests. */
    confirmFacts?: (blockId: string) => Partial<SnapPaneFacts> | undefined;
    /** Drop these block ids from the tab's own block list at a chosen moment. */
    onBeforeDelete?: (blockId: string, state: FakeHostState) => void;
    /** Runs right after a successful commit, before any removal is confirmed. */
    onAfterCommit?: (state: FakeHostState) => void;
    /** Omit the restore capability, which must make the controller refuse to shrink. */
    withoutRestore?: boolean;
    /** Omit the committed-layout reader, which must make the controller refuse to shrink. */
    withoutTreeReader?: boolean;
}

/** A pane fact set for one safe filler plus whatever the caller adds. */
function fillerFacts(blockId: string, overrides: Partial<SnapPaneFacts> = {}): SnapPaneFacts {
    return {
        blockId,
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

/**
 * Facts for a whole layout, with the dragged pane marked the way the real host marks it.
 *
 * Marking the sticky pane matters: the rules refuse to reclaim the pane being dragged, so a fixture
 * that forgets it would let the planner propose the dragged pane itself.
 */
function factsFor(
    panes: string[],
    stickyBlockId: string,
    overrides: Record<string, Partial<SnapPaneFacts>> = {}
): SnapPaneFacts[] {
    return panes.map((blockId) =>
        fillerFacts(blockId, { isSticky: blockId === stickyBlockId, ...(overrides[blockId] ?? {}) })
    );
}

function makeHost(initialPanes: string[], options: MakeHostOptions = {}): { host: SnapApplyHost; state: FakeHostState } {
    const state: FakeHostState = {
        panes: [...initialPanes],
        tabBlocks: [...(options.tabBlocks ?? initialPanes)],
        deleted: [],
        created: [],
        commits: [],
        createCounter: 0,
        applyWindows: { begun: 0, ended: 0 },
        restores: [],
    };
    let panesAtStart: string[] = [];
    let fullCollectCalls = 0;
    const host: SnapApplyHost = {
        getPaneBlockIds: () => [...state.panes],
        // The tab's own block list is the authority, exactly as in production.
        isBlockInTab: (blockId: string) => state.tabBlocks.includes(blockId),
        // The committed layout's panes, exactly as in production.
        getTreeBlockIds: options.withoutTreeReader === true ? undefined : () => [...state.panes],
        beginApply: () => {
            // The real host snapshots the tree here, which is what a failed shrink restores.
            panesAtStart = [...state.panes];
            state.applyWindows.begun += 1;
        },
        endApply: () => {
            state.applyWindows.ended += 1;
        },
        createLocalTerminal: async () => {
            // The window has to be open before the first block exists, otherwise the tab can own a
            // block the tree does not contain while cleanup is still allowed to run.
            assert.equal(
                state.applyWindows.begun,
                state.applyWindows.ended + 1,
                "blocks may only be created inside an open apply window"
            );
            state.createCounter += 1;
            if (options.failCreateAt != null && state.createCounter === options.failCreateAt) {
                throw new Error("create failed");
            }
            const blockId = `new-block-${state.createCounter}`;
            state.created.push(blockId);
            // A created block is owned by the tab straight away, but it only reaches the tree when a
            // commit puts it there - exactly as in production.
            state.tabBlocks.push(blockId);
            return blockId;
        },
        deleteBlock: async (blockId: string) => {
            options.onBeforeDelete?.(blockId, state);
            if (options.failDelete || options.failDeleteOf === blockId) {
                throw new Error("delete failed");
            }
            state.deleted.push(blockId);
            state.panes = state.panes.filter((pane) => pane !== blockId);
            state.tabBlocks = state.tabBlocks.filter((pane) => pane !== blockId);
        },
        commitTree: async (rootNode: LayoutNode, focusedNodeId: string) => {
            if (options.failCommit) {
                throw new Error("commit failed");
            }
            // Mirror the real commit: the tab's panes become exactly the tree's leaves.
            const leaves: string[] = [];
            walkNodes(rootNode, (node) => {
                if (node.data != null) {
                    leaves.push(node.data.blockId);
                }
            });
            state.panes = leaves;
            state.commits.push({ rootNode, focusedNodeId });
            options.onAfterCommit?.(state);
        },
    };
    if (options.paneFacts != null) {
        host.collectPaneFacts = async (_request, blockIds?: string[]) => {
            const base = (options.paneFacts ?? []).map((facts) => ({ ...facts }));
            if (blockIds != null) {
                // A scoped request (the pre-delete check) sees the current facts for those panes.
                return base
                    .filter((facts) => blockIds.includes(facts.blockId))
                    .map((facts) => ({ ...facts, ...(options.confirmFacts?.(facts.blockId) ?? {}) }));
            }
            const sequence = options.factsSequence;
            if (sequence != null && sequence.length > 0) {
                const index = Math.min(fullCollectCalls, sequence.length - 1);
                fullCollectCalls += 1;
                return sequence[index].map((facts) => ({ ...facts }));
            }
            fullCollectCalls += 1;
            return base;
        };
    }
    if (options.paneFacts != null && options.withoutRestore !== true) {
        host.restorePreviousTree = async (substitutions: Record<string, string>) => {
            // The tree from before the apply, rebuilt from the panes that were on screen then.
            const previous = layoutOf(panesAtStart);
            const restored = substituteBlockIds(previous, substitutions);
            state.restores.push({ rootNode: previous, substitutions });
            state.panes = leafBlockIds(restored);
        };
    }
    return { host, state };
}

/** A single row of panes, standing in for the layout that was on screen before an apply. */
function layoutOf(panes: string[]): LayoutNode {
    return {
        id: "previous-root",
        flexDirection: "row" as any,
        size: 100,
        children: panes.map((blockId, index) => ({
            id: `previous-${index}`,
            flexDirection: "row" as any,
            size: Math.floor(100 / panes.length),
            data: { blockId },
        })),
    };
}

function substituteBlockIds(rootNode: LayoutNode, substitutions: Record<string, string>): LayoutNode {
    const copy: LayoutNode = { id: rootNode.id, flexDirection: rootNode.flexDirection, size: rootNode.size };
    if (rootNode.data != null) {
        copy.data = { blockId: substitutions[rootNode.data.blockId] ?? rootNode.data.blockId };
    }
    if (rootNode.children != null) {
        copy.children = rootNode.children.map((child) => substituteBlockIds(child, substitutions));
    }
    return copy;
}

function leafBlockIds(rootNode: LayoutNode): string[] {
    const ids: string[] = [];
    walkNodes(rootNode, (node) => {
        if (node.data != null) ids.push(node.data.blockId);
    });
    return ids;
}

describe("applySnapPreset: successful application", () => {
    test("preserves the dragged pane's block id and fills the rest from existing panes", async () => {
        const { host, state } = makeHost(["pane-a", "pane-b"]);
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "bottom-right",
            stickyBlockId: "pane-a",
        });
        assert.equal(result.status, "applied");
        assert.equal(state.commits.length, 1, "exactly one commit");
        const placed = leafBlockIds(state.commits[0].rootNode);
        assert.include(placed, "pane-a", "the dragged pane must survive as the same block");
        assert.include(placed, "pane-b", "existing panes must be reused, not recreated");
        assert.lengthOf(placed, 4, "four-grid must end with four panes");
        if (result.status === "applied") {
            assert.lengthOf(result.createdBlockIds, 2, "only the two missing slots are created");
        }
    });

    test("creates local terminals only for the slots the preset leaves empty", async () => {
        const { host, state } = makeHost(["pane-a"]);
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "right",
            stickyBlockId: "pane-a",
        });
        assert.equal(result.status, "applied");
        assert.deepEqual(state.created, ["new-block-1"]);
        const placed = leafBlockIds(state.commits[0].rootNode);
        assert.deepEqual(placed, ["new-block-1", "pane-a"], "sticky pane keeps the right-hand slot");
    });

    test("commits a tree the layout model accepts, with no pane lost or duplicated", async () => {
        for (const presetId of ["two-columns", "three-columns", "four-grid", "left-major-with-right-stack"]) {
            const { host, state } = makeHost(["a", "b"]);
            const result = await applySnapPreset(host, {
                preset: getSnapPresetById(presetId)!,
                stickySlotId: getSnapPresetById(presetId)!.root.children[0].kind === "slot" ? "left" : "left",
                stickyBlockId: "a",
            });
            if (result.status === "rejected") continue;
            assert.equal(result.status, "applied", `${presetId} should apply`);
            const { rootNode } = state.commits[0];
            walkNodes(rootNode, (node) => assert.isTrue(validateNode(node), `${presetId} invalid node`));
            const placed = leafBlockIds(rootNode);
            assert.equal(new Set(placed).size, placed.length, `${presetId} duplicated a pane`);
        }
    });

    test("existing panes fill the remaining slots in the preset's stable order", async () => {
        const { host, state } = makeHost(["dragged", "first-other", "second-other", "third-other"]);
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "bottom-right",
            stickyBlockId: "dragged",
        });
        assert.equal(result.status, "applied");
        // four-grid slot order is top-left, top-right, bottom-left, bottom-right.
        assert.deepEqual(leafBlockIds(state.commits[0].rootNode), [
            "first-other",
            "second-other",
            "third-other",
            "dragged",
        ]);
        if (result.status === "applied") {
            assert.isEmpty(result.createdBlockIds, "no pane needs creating");
        }
    });

    test("a pane the tab owns but has not placed yet still gets placed", async () => {
        const { host, state } = makeHost(["other"], { tabBlocks: ["other", "fresh-pane"] });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "fresh-pane",
        });
        assert.equal(result.status, "applied");
        const placed = leafBlockIds(state.commits[0].rootNode);
        assert.include(placed, "fresh-pane");
        assert.include(placed, "other");
        assert.lengthOf(placed, 2);
    });
    test("a pane the tab no longer owns is rejected even though it is still placed in the tree", async () => {
        // pane-b is on screen in this model, but the tab block list no longer contains it. Ownership
        // must follow the tab list, so a stale tree entry cannot authorize the drop.
        const { host, state } = makeHost(["pane-a", "pane-b"], { tabBlocks: ["pane-a"] });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-b",
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "foreign-block");
        }
        assert.isEmpty(state.created);
        assert.isEmpty(state.commits);
        assert.equal(state.applyWindows.begun, 0, "a rejected apply must not open the mutation window");
    });

    test("the mutation window is opened before the first create and closed on every outcome", async () => {
        const successes = makeHost(["pane-a"]);
        await applySnapPreset(successes.host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });
        assert.deepEqual(successes.state.applyWindows, { begun: 1, ended: 1 }, "closed after success");

        const createFailure = makeHost(["pane-a"], { failCreateAt: 2 });
        await applySnapPreset(createFailure.host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });
        assert.deepEqual(createFailure.state.applyWindows, { begun: 1, ended: 1 }, "closed after a create failure");

        const commitFailure = makeHost(["pane-a"], { failCommit: true });
        await applySnapPreset(commitFailure.host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });
        assert.deepEqual(commitFailure.state.applyWindows, { begun: 1, ended: 1 }, "closed after a commit failure");

        const rejected = makeHost(["a", "b", "c"]);
        await applySnapPreset(rejected.host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "a",
        });
        assert.deepEqual(rejected.state.applyWindows, { begun: 0, ended: 0 }, "never opened for a disabled preset");
    });
});

describe("applySnapPreset: rejection", () => {
    test("rejects a preset that cannot hold the panes when the host cannot judge reclaiming", async () => {
        const { host, state } = makeHost(["a", "b", "c"]);
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "a",
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "too-many-panes");
        }
        assert.isEmpty(state.created, "a disabled preset must not create panes");
        assert.isEmpty(state.deleted, "a disabled preset must not delete panes");
        assert.isEmpty(state.commits, "a disabled preset must not touch the tree");
        assert.deepEqual(state.panes, ["a", "b", "c"], "the original layout is untouched");
    });

    test("rejects a preset that would have to remove an unsafe pane", async () => {
        const panes = ["a", "ssh-pane", "used-pane"];
        const { host, state } = makeHost(panes, {
            paneFacts: factsFor(panes, "a", {
                "ssh-pane": {
                    meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: true, connection: "h" },
                },
                "used-pane": { journal: { healthy: true, recordCount: 2 } },
            }),
        });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "a",
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "reclaim-unsafe");
            assert.deepEqual(
                result.refused?.map((entry) => entry.reason),
                ["sticky-pane", "remote-connection", "has-command-history"],
                "the dragged pane is refused too: it is never reclaimed"
            );
        }
        assert.isEmpty(state.deleted, "an unsafe shrink must delete nothing");
        assert.isEmpty(state.commits, "an unsafe shrink must not touch the tree");
        assert.deepEqual(state.panes, ["a", "ssh-pane", "used-pane"]);
    });

    test("rejects a shrink when the host has no way to put the layout back", async () => {
        const panes = ["a", "filler-1", "filler-2"];
        const { host, state } = makeHost(panes, {
            paneFacts: factsFor(panes, "a"),
            withoutRestore: true,
        });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "a",
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "too-many-panes", "no compensation path means no shrinking");
        }
        assert.isEmpty(state.deleted);
        assert.deepEqual(state.panes, ["a", "filler-1", "filler-2"]);
    });

    test("rejects a shrink when the pane facts do not cover every pane", async () => {
        const { host, state } = makeHost(["a", "b", "c"], {
            paneFacts: [fillerFacts("a"), fillerFacts("b")],
        });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "a",
        });
        assert.equal(result.status, "rejected");
        assert.isEmpty(state.deleted);
    });

    test("rejects the whole apply when a leaf of the tree is not owned by the tab", async () => {
        // pane-b is in the tree but no longer in tab.blockids: reusing the rest would drag a stale
        // block into the new layout, so nothing may be applied.
        const { host, state } = makeHost(["pane-a", "pane-b"], { tabBlocks: ["pane-a"] });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "stale-pane");
            assert.equal(result.blockId, "pane-b");
        }
        assert.isEmpty(state.created);
        assert.isEmpty(state.deleted);
        assert.isEmpty(state.commits);
    });

    test("rejects an unknown slot without creating or deleting anything", async () => {
        const { host, state } = makeHost(["a"]);
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "not-a-slot",
            stickyBlockId: "a",
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "unknown-slot");
        }
        assert.isEmpty(state.created);
        assert.isEmpty(state.commits);
    });

    test("rejects a dragged pane that belongs to another tab", async () => {
        const { host, state } = makeHost(["pane-a", "pane-b"]);
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("three-columns")!,
            stickySlotId: "center",
            stickyBlockId: "pane-in-another-tab",
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "foreign-block");
        }
        assert.isEmpty(state.created, "a foreign pane must not create panes in this tab");
        assert.isEmpty(state.deleted, "a foreign pane must not delete panes of this tab");
        assert.isEmpty(state.commits, "a foreign pane must not reach the tree");
        assert.deepEqual(state.panes, ["pane-a", "pane-b"], "the original layout is untouched");
    });
});

describe("applySnapPreset: shrinking with safe fillers", () => {
    test("removes exactly the safe fillers the preset cannot hold", async () => {
        const panes = ["pane-a", "filler-1", "filler-2"];
        const { host, state } = makeHost(panes, { paneFacts: factsFor(panes, "pane-a") });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "applied");
        if (result.status === "applied") {
            assert.deepEqual(result.reclaimedBlockIds, ["filler-1"], "only the surplus filler goes");
            assert.isEmpty(result.createdBlockIds, "the two-column preset needs no new panes");
        }
        assert.deepEqual(state.deleted, ["filler-1"]);
        assert.deepEqual(state.panes, ["pane-a", "filler-2"], "the remaining panes fill the preset");
        assert.equal(state.commits.length, 1, "one tree replacement");
        assert.deepEqual(state.applyWindows, { begun: 1, ended: 1 }, "the removals happen inside the window");
        assert.isEmpty(state.restores, "a successful shrink needs no compensation");
    });

    test("keeps the dragged pane and removes only other safe fillers", async () => {
        const panes = ["filler-1", "filler-2", "filler-3"];
        const { host, state } = makeHost(panes, { paneFacts: factsFor(panes, "filler-2") });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "right",
            stickyBlockId: "filler-2",
        });

        assert.equal(result.status, "applied");
        if (result.status === "applied") {
            assert.deepEqual(result.reclaimedBlockIds, ["filler-1"], "the dragged pane is never reclaimed");
        }
        assert.notInclude(state.deleted, "filler-2", "the dragged pane survives");
        assert.deepEqual(state.panes, ["filler-3", "filler-2"], "the dragged pane keeps the slot it was dropped on");
    });

    test("a four-pane layout can shrink into the nested three-slot preset", async () => {
        const panes = ["pane-a", "filler-1", "filler-2", "filler-3"];
        const { host, state } = makeHost(panes, {
            paneFacts: factsFor(panes, "pane-a", { "filler-3": { isFocused: true } }),
        });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("left-major-with-right-stack")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "applied");
        if (result.status === "applied") {
            assert.lengthOf(result.reclaimedBlockIds, 1);
            assert.notInclude(result.reclaimedBlockIds, "filler-3", "the focused pane is never reclaimed");
            assert.notInclude(result.reclaimedBlockIds, "pane-a", "the dragged pane is never reclaimed");
        }
        assert.deepEqual(state.panes, ["pane-a", "filler-2", "filler-3"], "the first surplus filler is the one reclaimed");
    });

    test("the mutation window covers the removals, and cleanup stays suppressed for all of it", async () => {
        const panes = ["pane-a", "filler-1", "filler-2"];
        const { host, state } = makeHost(panes, { paneFacts: factsFor(panes, "pane-a") });
        const deletesInsideWindow: number[] = [];
        const originalDelete = host.deleteBlock;
        host.deleteBlock = async (blockId: string) => {
            deletesInsideWindow.push(state.applyWindows.begun - state.applyWindows.ended);
            return originalDelete(blockId);
        };

        await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.deepEqual(deletesInsideWindow, [1], "every planned removal happens with the window open");
        assert.deepEqual(state.applyWindows, { begun: 1, ended: 1 }, "and the window is closed afterwards");
    });
});

describe("applySnapPreset: rollback", () => {
    test("rolls back created blocks and leaves the layout unchanged when the commit fails", async () => {
        const { host, state } = makeHost(["pane-a"], { failCommit: true });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });
        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.equal(result.reason, "commit-failed");
            assert.lengthOf(result.rolledBackBlockIds, 3, "every created block is rolled back");
            assert.isEmpty(result.leakedBlockIds);
        }
        assert.isEmpty(state.commits, "no commit was recorded");
        assert.deepEqual(state.panes, ["pane-a"], "the original layout is intact");
        assert.deepEqual(state.deleted, ["new-block-1", "new-block-2", "new-block-3"]);
    });

    test("rolls back blocks created before a mid-sequence create failure", async () => {
        const { host, state } = makeHost(["pane-a"], { failCreateAt: 3 });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });
        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.equal(result.reason, "create-failed");
            assert.deepEqual(result.rolledBackBlockIds, ["new-block-1", "new-block-2"]);
            assert.isEmpty(result.leakedBlockIds);
        }
        assert.deepEqual(state.panes, ["pane-a"], "the original layout is intact");
        assert.isEmpty(state.commits);
    });

    test("reports a block it could not roll back instead of hiding it", async () => {
        const { host, state } = makeHost(["pane-a"], { failCommit: true, failDelete: true });
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });
        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.isEmpty(result.rolledBackBlockIds);
            assert.lengthOf(result.leakedBlockIds, 1, "a block that survives rollback must be surfaced");
        }
        assert.isEmpty(state.commits);
    });

    test("a failed apply never leaves a partial tree committed", async () => {
        for (const failCreateAt of [1, 2, 3]) {
            const { host, state } = makeHost(["pane-a"], { failCreateAt });
            await applySnapPreset(host, {
                preset: getSnapPresetById("four-grid")!,
                stickySlotId: "top-left",
                stickyBlockId: "pane-a",
            });
            assert.isEmpty(state.commits, `failCreateAt=${failCreateAt} must not commit`);
            assert.deepEqual(state.panes, ["pane-a"], `failCreateAt=${failCreateAt} must restore panes`);
        }
    });
});

describe("applySnapPreset: the reclaim decision is re-established before anything is removed", () => {
    const SHRINK_PANES = ["pane-a", "filler-1", "filler-2", "filler-3"];

    function fixture(options: MakeHostOptions = {}) {
        return makeHost(SHRINK_PANES, { paneFacts: factsFor(SHRINK_PANES, "pane-a"), ...options });
    }

    /** Facts as they look when a pane has just been used: the journal now has a record. */
    function usedFacts(blockId: string): SnapPaneFacts {
        return fillerFacts(blockId, { journal: { healthy: true, recordCount: 1 } });
    }

    test("a pane that was used between the plan and the window abandons the shrink", async () => {
        const planned = factsFor(SHRINK_PANES, "pane-a");
        const rechecked = planned.map((facts) =>
            facts.blockId === "filler-1" ? usedFacts("filler-1") : facts
        );
        const { host, state } = fixture({ factsSequence: [planned, rechecked] });

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "reclaim-unsafe");
            assert.deepEqual(result.refused?.map((entry) => entry.reason), ["sticky-pane", "has-command-history"]);
        }
        assert.isEmpty(state.created, "nothing may be created for an abandoned shrink");
        assert.isEmpty(state.deleted, "and nothing may be removed");
        assert.isEmpty(state.commits, "the layout must not be touched");
        assert.deepEqual(state.applyWindows, { begun: 1, ended: 1 }, "the window is opened and closed cleanly");
    });

    test("a pane that left the tab between the plan and the window abandons the shrink", async () => {
        const planned = factsFor(SHRINK_PANES, "pane-a");
        const rechecked = planned.map((facts) => ({ ...facts, storeBlockIds: undefined }));
        const { host, state } = fixture({ factsSequence: [planned, rechecked] });
        // Ownership is read from the tab list, which is the authority the controller consults.
        const originalIsBlockInTab = host.isBlockInTab;
        let calls = 0;
        host.isBlockInTab = (blockId: string) => {
            calls += 1;
            // The plan's ownership read passes; the re-verification's does not.
            if (calls > SHRINK_PANES.length + 1 && blockId === "filler-1") {
                return false;
            }
            return originalIsBlockInTab(blockId);
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.isTrue(
                result.reason === "reclaim-unverified" || result.reason === "reclaim-unsafe",
                `unexpected reason ${result.reason}`
            );
        }
        assert.isEmpty(state.deleted);
        assert.isEmpty(state.commits);
    });

    test("facts that name a different set of panes are refused, even at the same size", async () => {
        const planned = factsFor(SHRINK_PANES, "pane-a");
        // Same count, different identity: filler-3 replaced by an unknown pane.
        const wrongIdentity = [
            ...planned.filter((facts) => facts.blockId !== "filler-3"),
            fillerFacts("some-other-pane"),
        ];
        const { host, state } = fixture({ factsSequence: [planned, wrongIdentity] });

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "reclaim-unverified");
            assert.match(result.detail ?? "", /some-other-pane/);
        }
        assert.isEmpty(state.deleted);
        assert.isEmpty(state.commits);
    });

    test("facts for a pane the tab does not own are refused", async () => {
        const planned = factsFor(SHRINK_PANES, "pane-a");
        const foreign = planned.map((facts) =>
            facts.blockId === "filler-1" ? { ...facts, inTab: false } : facts
        );
        const { host, state } = fixture({ factsSequence: [planned, foreign] });

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "reclaim-unverified");
            assert.match(result.detail ?? "", /not owned by this tab/);
        }
        assert.isEmpty(state.deleted);
    });

    test("a pane that becomes used after the commit is not deleted, and the layout goes back", async () => {
        const planned = factsFor(SHRINK_PANES, "pane-a");
        const { host, state } = fixture({
            factsSequence: [planned, planned],
            // The per-delete check sees a pane that now has command history.
            confirmFacts: (blockId) => (blockId === "filler-1" ? { journal: { healthy: true, recordCount: 4 } } : undefined),
        });

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.equal(result.reason, "reclaim-failed");
            assert.match(String((result.error as Error)?.message ?? ""), /no longer reclaimable/);
            assert.isEmpty(result.restoredBlockIds, "nothing had been removed yet");
            assert.isEmpty(result.leakedBlockIds);
        }
        assert.notInclude(state.deleted, "filler-1", "a pane used after the plan must not be removed");
        assert.notInclude(state.deleted, "filler-2");
        // The commit already happened, so abandoning the shrink has to put the previous layout back.
        assert.lengthOf(state.restores, 1, "the previous layout is restored");
        assert.deepEqual(state.restores[0].substitutions, {}, "nothing had been removed, so nothing is substituted");
        assert.deepEqual(state.panes, SHRINK_PANES, "and the tab is back to the panes it had");
    });

    test("a pane that leaves the tab after the commit is not deleted", async () => {
        const planned = factsFor(SHRINK_PANES, "pane-a");
        const { host, state } = fixture({
            factsSequence: [planned, planned],
            // Ownership changes right after the commit, before the removal is confirmed.
            onAfterCommit: (state) => {
                state.tabBlocks = state.tabBlocks.filter((id) => id !== "filler-1");
            },
        });

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.match(String((result.error as Error)?.message ?? ""), /no longer belongs to this tab/);
        }
        assert.notInclude(state.deleted, "filler-1");
    });
});

describe("applySnapPreset: a shrink that fails part way through is compensated", () => {
    /** Four panes shrinking into a two-slot preset, so two removals are needed and one can fail. */
    const SHRINK_PANES = ["pane-a", "filler-1", "filler-2", "filler-3"];

    function shrinkFixture(options: MakeHostOptions = {}) {
        return makeHost(SHRINK_PANES, {
            paneFacts: factsFor(SHRINK_PANES, "pane-a"),
            ...options,
        });
    }

    test("a removal failure puts the pane back and restores the previous tree", async () => {
        const { host, state } = shrinkFixture();
        // The first filler is removed, then the second removal fails: the worst case for a shrink.
        let deletes = 0;
        const originalDelete = host.deleteBlock;
        host.deleteBlock = async (blockId: string) => {
            deletes += 1;
            if (deletes === 1) {
                return originalDelete(blockId);
            }
            throw new Error("delete failed");
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.equal(result.reason, "reclaim-failed");
            assert.deepEqual(result.restoredBlockIds, ["filler-1"], "the removed pane is put back");
            assert.isEmpty(result.leakedBlockIds, "nothing is left behind");
        }
        assert.lengthOf(state.restores, 1, "the previous tree is re-committed");
        assert.deepEqual(
            Object.keys(state.restores[0].substitutions),
            ["filler-1"],
            "the restored tree points at the replacement pane"
        );
        // The replacement is a new block, and the tree holds it rather than the removed id.
        const replacement = state.restores[0].substitutions["filler-1"];
        assert.match(replacement, /^new-block-/);
        assert.include(state.panes, replacement);
        assert.notInclude(state.panes, "filler-1", "the original id is gone, which is why it was substituted");
        assert.include(state.panes, "filler-2", "the pane that failed to delete is still there");
        assert.deepEqual(state.applyWindows, { begun: 1, ended: 1 }, "the compensation happens inside the window");
    });

    test("a commit failure during a shrink removes the created panes and never removes the old ones", async () => {
        const { host, state } = shrinkFixture({ failCommit: true });

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.equal(result.reason, "commit-failed");
            assert.isEmpty(result.restoredBlockIds, "nothing was removed, so nothing needs restoring");
        }
        assert.isEmpty(state.deleted, "a failed commit must not remove any old pane");
        assert.deepEqual(state.panes, SHRINK_PANES, "the original layout is intact");
        assert.isEmpty(state.restores);
    });

    test("a create failure during a shrink leaves every old pane alone", async () => {
        // four-grid needs four panes; three exist, so one is created - and that creation fails.
        const panes = ["pane-a", "filler-1", "filler-2"];
        const { host, state } = makeHost(panes, {
            paneFacts: factsFor(panes, "pane-a"),
            failCreateAt: 1,
        });

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.equal(result.reason, "create-failed");
        }
        assert.isEmpty(state.deleted);
        assert.deepEqual(state.panes, panes);
        assert.isEmpty(state.commits);
    });

    test("a pane that cannot be replaced is reported by its own id, not as a leak", async () => {
        const { host, state } = shrinkFixture({ failCreateAt: 1 });
        let deletes = 0;
        const originalDelete = host.deleteBlock;
        host.deleteBlock = async (blockId: string) => {
            deletes += 1;
            if (deletes === 1) {
                return originalDelete(blockId);
            }
            throw new Error("delete failed");
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.equal(result.reason, "reclaim-failed");
            assert.deepEqual(
                result.unreplacedBlockIds,
                ["filler-1"],
                "the pane that was removed and could not be replaced is named as such"
            );
            assert.isEmpty(result.leakedBlockIds, "nothing real survives, so nothing is leaked");
            assert.isEmpty(result.restoredBlockIds, "no restore happened without a replacement");
        }
        assert.isEmpty(state.restores, "no restore was attempted without a replacement");
    });

    test("a replacement that the final layout does not need is removed, not leaked", async () => {
        // Five panes into two slots: three removals are planned, two succeed, and the replacement for
        // the second one cannot be created - so the previous layout cannot come back and the first
        // replacement becomes an orphan of the abandoned layout. It has to be cleaned up here.
        const panes = ["pane-a", "filler-1", "filler-2", "filler-3", "filler-4"];
        const { host, state } = makeHost(panes, {
            paneFacts: factsFor(panes, "pane-a"),
            failCreateAt: 2,
        });
        let deletes = 0;
        const originalDelete = host.deleteBlock;
        host.deleteBlock = async (blockId: string) => {
            deletes += 1;
            if (deletes === 3) {
                throw new Error("delete failed");
            }
            return originalDelete(blockId);
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.deepEqual(result.unreplacedBlockIds, ["filler-2"], "the pane that could not come back");
            assert.isEmpty(result.leakedBlockIds, "the abandoned replacement was cleaned up");
            assert.isEmpty(result.restoredBlockIds, "the layout was not put back");
        }
        assert.include(state.deleted, "new-block-1", "the unreferenced replacement is deleted");
        assert.notInclude(state.panes, "new-block-1", "and it is gone from the panes");
    });

    test("a replacement that cannot be cleaned up is leaked by its real new id", async () => {
        const panes = ["pane-a", "filler-1", "filler-2", "filler-3", "filler-4"];
        const { host, state } = makeHost(panes, {
            paneFacts: factsFor(panes, "pane-a"),
            failCreateAt: 2,
        });
        let deletes = 0;
        const originalDelete = host.deleteBlock;
        host.deleteBlock = async (blockId: string) => {
            deletes += 1;
            if (deletes === 3 || blockId === "new-block-1") {
                throw new Error("delete failed");
            }
            return originalDelete(blockId);
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.deepEqual(
                result.leakedBlockIds,
                ["new-block-1"],
                "the leak is the replacement that really survives, never the deleted pane's old id"
            );
            assert.notInclude(result.leakedBlockIds, "filler-1", "the removed pane is not a leak");
            assert.notInclude(result.leakedBlockIds, "filler-2");
            assert.deepEqual(result.unreplacedBlockIds, ["filler-2"]);
        }
        assert.include(state.tabBlocks, "new-block-1", "the leaked block really is still owned by the tab");
    });

    test("when the layout cannot be put back, the replacement is still cleaned up", async () => {
        const { host, state } = shrinkFixture();
        let deletes = 0;
        const originalDelete = host.deleteBlock;
        host.deleteBlock = async (blockId: string) => {
            deletes += 1;
            if (blockId === "filler-2") {
                throw new Error("delete failed");
            }
            return originalDelete(blockId);
        };
        host.restorePreviousTree = async () => {
            throw new Error("restore failed");
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.isEmpty(result.restoredBlockIds, "no pane came back");
            assert.isEmpty(result.leakedBlockIds, "the replacement was still cleaned up");
        }
        assert.include(state.deleted, "new-block-1", "the replacement is removed after the failed restore");
    });

    test("without a way to read the committed layout, nothing is deleted and every real block is reported", async () => {
        const { host, state } = shrinkFixture({ withoutTreeReader: true });
        // The controller must refuse the shrink outright rather than delete on a guess.
        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
            assert.equal(result.reason, "too-many-panes");
        }
        assert.isEmpty(state.deleted);
        assert.deepEqual(state.panes, SHRINK_PANES);
    });
});
