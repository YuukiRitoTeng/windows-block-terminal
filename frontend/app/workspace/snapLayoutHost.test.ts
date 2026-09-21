// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end Snap Layout application against the real runtime wiring.
 *
 * The controller tests use a fake host, which proves the ordering but not that the production host
 * actually behaves that way. These tests therefore build the *real* host
 * (`createSnapLayoutHost` / `createTabSnapLayoutHost` -> real `LayoutModel` + a recording
 * ObjectService), run the real `applySnapPreset` against it, and observe the real model's render
 * passes, store writes and persists. What is being proven:
 *
 *   - create-block -> whole-tree replacement -> orphan check yields no intermediate state,
 *   - orphan cleanup firing *inside* the create window cannot delete a pane the apply is about to
 *     place, and is fully restored once the apply settles,
 *   - a dragged pane keeps its block id (and therefore its PTY/SSH/WSL session),
 *   - ownership is decided by the tab's own block list, with no way to fall back to the tree,
 *   - a commit failure or a mid-create failure rolls the created blocks back and leaves the
 *     previous tree byte-for-byte in place, so nothing was ever partially applied.
 */

import { applySnapPreset } from "@/app/workspace/snapApply";
import {
    collectReclaimablePaneIds,
    createSnapLayoutHost,
    createTabSnapLayoutHost,
    SnapPaneFactProviders,
} from "@/app/workspace/snapLayoutHost";
import { SNAP_AUTOCREATED_META_KEY } from "@/app/workspace/snapReclaim";
import { getSnapPresetById } from "@/layout/lib/snapPresets";
import { RealModelHarness, blockIdsOf, makeRealLayoutModel, twoPaneRoot } from "@/layout/tests/realLayoutModel";
import { LayoutNode } from "@/layout/lib/types";
import { assert, beforeEach, describe, test } from "vitest";

/** Records what the apply logic asked the backend to do, and can be told to fail. */
class RecordingObjectService {
    created: string[] = [];
    createdBlockDefs: BlockDef[] = [];
    deleted: string[] = [];
    /** 1-based call number that should reject, or undefined for a service that never fails. */
    failCreateOnCall?: number;
    failDelete = false;
    /** Runs after a block was created, before the id is handed to the apply: the cleanup race window. */
    afterCreate?: (blockId: string) => Promise<void>;
    private calls = 0;

    async CreateBlock(blockDef: BlockDef, _rtOpts?: RuntimeOpts): Promise<string> {
        this.calls += 1;
        if (this.failCreateOnCall === this.calls) {
            throw new Error(`create failed on call ${this.calls}`);
        }
        const blockId = `created-${this.calls}`;
        this.created.push(blockId);
        this.createdBlockDefs.push(blockDef);
        await this.afterCreate?.(blockId);
        return blockId;
    }

    async DeleteBlock(blockId: string): Promise<void> {
        if (this.failDelete) {
            throw new Error("delete failed");
        }
        this.deleted.push(blockId);
    }
}

interface Fixture {
    harness: RealModelHarness;
    services: RecordingObjectService;
    host: ReturnType<typeof createSnapLayoutHost>;
    factProviders?: SnapPaneFactProviders;
}

/** Builds the production host over the real model, with ownership read from the tab record. */
function makeFixture(
    options: {
        tabBlockIds?: string[];
        useTabAuthority?: boolean;
        rootNode?: LayoutNode;
        factProviders?: SnapPaneFactProviders;
    } = {}
): Fixture {
    const harness = makeRealLayoutModel(options.rootNode ?? twoPaneRoot(), { tabBlockIds: options.tabBlockIds });
    const services = new RecordingObjectService();
    const host =
        options.useTabAuthority === true
            ? createTabSnapLayoutHost({
                  layoutModel: harness.model,
                  services: { ObjectService: services },
                  factProviders: options.factProviders,
              })
            : createSnapLayoutHost({
                  layoutModel: harness.model,
                  services: { ObjectService: services },
                  getTabBlockIds: () => harness.tab.blockids,
                  factProviders: options.factProviders,
              });
    return { harness, services, host, factProviders: options.factProviders };
}

/**
 * Fact providers for panes that are plain terminals that nothing may reclaim.
 *
 * Injected so a test never depends on the real runtime: without them the host would ask the backend
 * for controller status and command history, which is exactly right in the app and unavailable here.
 */
function unreclaimableFacts(blockIds: string[]): SnapPaneFactProviders {
    return {
        getBlockRecord: (blockId: string) =>
            blockIds.includes(blockId) ? { meta: { view: "term", controller: "shell" }, jobId: "" } : undefined,
        getRuntimeStatus: async () => ({ shellprocstatus: "running" }),
        getJournalUsage: async () => ({ healthy: true, recordCount: 0 }),
        getFocusedBlockId: () => undefined,
    };
}

/** Five panes side by side, the maximum a layout node may hold, and one more than any preset fits. */
function fivePaneRoot(): LayoutNode {
    return fivePaneRootNamed(["p1", "p2", "p3", "p4", "p5"]);
}

/** A five-pane row over the given block ids. */
function fivePaneRootNamed(blockIds: string[]): LayoutNode {
    return {
        id: "old-root",
        flexDirection: "row" as any,
        size: 100,
        children: blockIds.map((blockId) => ({
            id: `old-${blockId}`,
            flexDirection: "row" as any,
            size: 20,
            data: { blockId },
        })),
    };
}

describe("Snap Layout apply on the real LayoutModel", () => {
    let fixture: Fixture;

    beforeEach(() => {
        fixture = makeFixture();
    });

    test("four-grid over two panes creates two terminals and commits in one observable step", async () => {
        const { harness, services, host } = fixture;
        const previousRoot = harness.model.treeState.rootNode;

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "applied");
        assert.deepEqual(services.created, ["created-1", "created-2"], "only the shortfall is created");
        assert.isEmpty(services.deleted, "a successful apply deletes nothing");

        // Slot order decides reuse: the dragged pane keeps its slot, the other existing pane takes
        // the next slot, and the two remaining slots become local terminals.
        const leaves = harness.model.getLeafBlockIds();
        assert.deepEqual(leaves, ["pane-a", "pane-b", "created-1", "created-2"]);

        // The whole apply is exactly one render pass, one tree-state write and one persist.
        assert.equal(harness.counters.updateTree, 1, "one render pass for the entire apply");
        assert.deepEqual(harness.counters.updateTreeBalance, [false], "the preset must not be rebalanced");
        assert.equal(harness.counters.setter, 1, "one tree-state store write for the entire apply");
        assert.equal(harness.counters.persist, 1, "one persist for the entire apply");
        assert.equal(harness.renderedRoots[0], harness.model.treeState.rootNode);

        // Nothing that existed before is left outside the tree, so no pane and no freshly created
        // block can be orphaned by the commit.
        const placed = new Set(leaves);
        const orphans = [...blockIdsOf(previousRoot), ...services.created].filter((id) => !placed.has(id));
        assert.isEmpty(orphans, "no pane may be left outside the committed tree");
    });

    test("nothing is observable between creating the blocks and committing the tree", async () => {
        const { harness, services, host } = fixture;
        const previousRoot = harness.model.treeState.rootNode;

        // Observe the model at the moment the last block has been created: the tree, focus, store
        // and persist must all still be untouched, because the replacement is a single action.
        const realCreate = services.CreateBlock.bind(services);
        services.CreateBlock = async (blockDef: BlockDef, rtOpts?: RuntimeOpts) => {
            const created = await realCreate(blockDef, rtOpts);
            assert.equal(harness.model.treeState.rootNode, previousRoot, "tree changed before commit");
            assert.equal(harness.counters.updateTree, 0, "an intermediate tree was rendered");
            assert.equal(harness.counters.setter, 0, "an intermediate tree state was written to the store");
            assert.equal(harness.counters.persist, 0, "an intermediate tree was persisted");
            assert.isUndefined(harness.model.treeState.focusedNodeId, "focus changed before commit");
            return created;
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("three-columns")!,
            stickySlotId: "center",
            stickyBlockId: "pane-b",
        });

        assert.equal(result.status, "applied");
        assert.deepEqual(services.created, ["created-1"], "one slot needed a new terminal");
        assert.equal(harness.counters.updateTree, 1, "exactly one render pass in total");
        assert.equal(harness.counters.persist, 1, "exactly one persist in total");
        assert.deepEqual(harness.model.getLeafBlockIds(), ["pane-a", "pane-b", "created-1"]);
    });

    test("orphan cleanup, driven through the real listener, finds nothing after the apply", async () => {
        const { harness, services, host } = fixture;
        const deletedByCleanup: string[] = [];
        // cleanupOrphanedBlocks reads the tab's block list through the model's getter and reports
        // every orphan through onNodeDelete. Both are the real production edges, so this is the
        // production orphan check rather than a re-implementation of it.
        harness.model.onNodeDelete = async ({ blockId }) => {
            deletedByCleanup.push(blockId);
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });
        assert.equal(result.status, "applied");
        // The tab listener learns about the newly created blocks, exactly as CreateBlock would tell it.
        harness.tab.blockids.push(...services.created);
        await (harness.model as any).cleanupOrphanedBlocks();
        assert.isEmpty(deletedByCleanup, "the committed tree already covers every pane the tab owns");

        // The check has teeth: a block the tab owns but no slot of the committed tree holds is
        // still reported, which is what an intermediate tree would have produced.
        harness.tab.blockids.push("truly-orphaned");
        await (harness.model as any).cleanupOrphanedBlocks();
        assert.deepEqual(deletedByCleanup, ["truly-orphaned"]);
    });

    test("orphan cleanup firing inside the create window cannot delete a pane the apply is about to place", async () => {
        const { harness, services, host } = fixture;
        const deletedByCleanup: string[] = [];
        harness.model.onNodeDelete = async ({ blockId }) => {
            deletedByCleanup.push(blockId);
        };
        const cleanupRunsInsideTheWindow: string[] = [];

        // The tab learns about a new block from a backend event that can arrive before the create call
        // even returns, so this fires at the worst possible moment: the tab owns a block the model's
        // tree does not contain yet. Without the apply bracket, cleanup would delete it here.
        services.afterCreate = async (blockId: string) => {
            harness.tab.blockids.push(blockId);
            assert.isTrue(harness.model.isSnapApplyInFlight(), "the apply window must be open while creating");
            cleanupRunsInsideTheWindow.push(blockId);
            await (harness.model as any).cleanupOrphanedBlocks();
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "applied");
        assert.deepEqual(cleanupRunsInsideTheWindow, ["created-1", "created-2"], "cleanup ran mid-apply");
        assert.isEmpty(deletedByCleanup, "a block the apply is about to place must not be deleted");
        assert.isFalse(harness.model.isSnapApplyInFlight(), "the window must be closed once the apply settles");
        assert.deepEqual(harness.model.getLeafBlockIds(), ["pane-a", "pane-b", "created-1", "created-2"]);

        // The bracket must not disable cleanup: a genuine orphan is still reported afterwards.
        harness.tab.blockids.push("truly-orphaned");
        await (harness.model as any).cleanupOrphanedBlocks();
        assert.deepEqual(deletedByCleanup, ["truly-orphaned"]);
    });

    test("the apply window is closed again when the apply fails", async () => {
        const { harness, services, host } = fixture;
        services.failCreateOnCall = 2;

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        assert.isFalse(harness.model.isSnapApplyInFlight(), "a failed apply must not leave the lock held");
    });

    test("the dragged pane keeps its block id, so its terminal session survives", async () => {
        const { harness, services, host } = fixture;

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("left-major-with-right-stack")!,
            stickySlotId: "right-bottom",
            stickyBlockId: "pane-b",
        });

        assert.equal(result.status, "applied");
        assert.isEmpty(services.deleted, "the dragged pane must never be deleted and recreated");
        assert.deepEqual(services.created, ["created-1"], "the remaining slot becomes a local terminal");

        // The dragged pane sits in the slot it was dropped on, under its original block id.
        const root = harness.model.treeState.rootNode as LayoutNode;
        const rightStack = root.children![1];
        assert.equal(rightStack.flexDirection, "column", "the nested stack is preserved, not flattened");
        assert.equal(rightStack.children![1].data.blockId, "pane-b");
        assert.equal(harness.model.treeState.focusedNodeId, rightStack.children![1].id, "focus follows the drop");
        assert.include(harness.model.getLeafBlockIds(), "pane-b");
    });

    test("a pane that does not belong to the tab is rejected before anything happens", async () => {
        const { harness, services, host } = fixture;
        const previousRoot = harness.model.treeState.rootNode;

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-from-another-tab",
        });

        assert.equal(result.status, "rejected");
        assert.equal((result as any).reason, "foreign-block");
        assert.isEmpty(services.created, "a foreign pane must not trigger block creation");
        assert.isEmpty(services.deleted);
        assert.equal(harness.counters.updateTree, 0);
        assert.equal(harness.counters.persist, 0);
        assert.equal(harness.model.treeState.rootNode, previousRoot, "the tree is untouched");
    });

    test("ownership is read from the tab record: an off-screen pane the tab owns is a valid drop source", async () => {
        // pane-offscreen is not in the tree, so it can only be accepted if ownership comes from the
        // tab record. This host is built by the production factory, which has no other source.
        const offscreen = makeFixture({
            tabBlockIds: ["pane-a", "pane-b", "pane-offscreen"],
            useTabAuthority: true,
        });

        const result = await applySnapPreset(offscreen.host, {
            preset: getSnapPresetById("three-columns")!,
            stickySlotId: "right",
            stickyBlockId: "pane-offscreen",
        });

        assert.equal(result.status, "applied");
        assert.isEmpty(offscreen.services.created, "every pane the tab owns is placed, so none is created");
        // Both on-screen panes survive and the off-screen one takes the slot it was dropped on.
        assert.deepEqual(offscreen.harness.model.getLeafBlockIds(), ["pane-a", "pane-b", "pane-offscreen"]);
    });

    test("a pane the tab no longer owns is rejected even though the tree still shows it", async () => {
        // The tab record has moved on (pane-b now belongs to another tab) while this model's tree is
        // stale. Ownership must follow the tab record, so the stale tree entry is not enough.
        const stale = makeFixture({ tabBlockIds: ["pane-a"], useTabAuthority: true });
        const previousRoot = stale.harness.model.treeState.rootNode;

        const result = await applySnapPreset(stale.host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "right",
            stickyBlockId: "pane-b",
        });

        assert.equal(result.status, "rejected");
        assert.equal((result as any).reason, "foreign-block");
        assert.isEmpty(stale.services.created);
        assert.isEmpty(stale.services.deleted);
        assert.equal(stale.harness.counters.updateTree, 0, "a rejected apply must not touch the tree");
        assert.equal(stale.harness.model.treeState.rootNode, previousRoot);
    });

    test("a stale leaf anywhere in the tree stops the whole apply", async () => {
        // pane-b is on screen but no longer in the tab's block list. Reusing the rest of the panes
        // would carry a block the tab does not own into the new layout, so nothing may be applied.
        const stale = makeFixture({ tabBlockIds: ["pane-a"] });
        const previousRoot = stale.harness.model.treeState.rootNode;

        const result = await applySnapPreset(stale.host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "rejected");
        assert.equal((result as any).reason, "stale-pane");
        assert.equal((result as any).blockId, "pane-b");
        assert.isEmpty(stale.services.created);
        assert.isEmpty(stale.services.deleted);
        assert.equal(stale.harness.model.treeState.rootNode, previousRoot);
        assert.equal(stale.harness.counters.persist, 0);
    });

    test("a commit failure rolls the created blocks back and keeps the previous tree", async () => {
        const { harness, services, host } = fixture;
        const previousRoot = harness.model.treeState.rootNode;
        const previousShape = JSON.stringify(previousRoot);
        // The real commit throws before it touches the tree, which is what a failed reducer action
        // or a rejected backend call looks like from the controller's point of view.
        (harness.model as any).commitSnapRoot = () => {
            throw new Error("commit boom");
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        assert.equal((result as any).reason, "commit-failed");
        assert.deepEqual((result as any).rolledBackBlockIds, ["created-1", "created-2"]);
        assert.isEmpty((result as any).leakedBlockIds, "every created block was rolled back");
        assert.deepEqual(services.deleted, ["created-1", "created-2"]);
        assert.equal(JSON.stringify(harness.model.treeState.rootNode), previousShape, "previous tree intact");
        assert.equal(harness.counters.updateTree, 0, "a failed apply renders nothing");
        assert.equal(harness.counters.persist, 0, "a failed apply persists nothing");
        assert.isFalse(harness.model.isSnapApplyInFlight(), "the apply window must be closed again");
    });

    test("a commit that dies after replacing the tree leaves nothing half applied", async () => {
        const { harness, services, host } = fixture;
        const previousShape = JSON.stringify(harness.model.treeState.rootNode);
        // The store write happens after the reducer already installed the replacement tree, so the
        // commit fails with the new tree in place - the case the apply layer cannot repair on its own.
        const realSetter = (harness.model as any).setter;
        let setterCalls = 0;
        (harness.model as any).setter = (...args: any[]) => {
            setterCalls += 1;
            if (setterCalls === 1) throw new Error("store write failed");
            return realSetter.apply(harness.model, args);
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        assert.equal((result as any).reason, "commit-failed");
        assert.deepEqual(services.deleted, ["created-1", "created-2"], "created blocks are rolled back");
        assert.equal(JSON.stringify(harness.model.treeState.rootNode), previousShape, "old tree is back");
        assert.deepEqual(harness.model.getLeafBlockIds(), ["pane-a", "pane-b"]);
        assert.isFalse(harness.model.isSnapApplyInFlight(), "the apply window must be closed again");
    });

    test("a failure while creating the second terminal rolls the first one back", async () => {
        const { harness, services, host } = fixture;
        const previousShape = JSON.stringify(harness.model.treeState.rootNode);
        services.failCreateOnCall = 2;

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        assert.equal((result as any).reason, "create-failed");
        assert.deepEqual(services.created, ["created-1"], "only the first create succeeded");
        assert.deepEqual((result as any).rolledBackBlockIds, ["created-1"]);
        assert.deepEqual(services.deleted, ["created-1"]);
        assert.equal(JSON.stringify(harness.model.treeState.rootNode), previousShape, "previous tree intact");
        assert.equal(harness.counters.updateTree, 0, "no tree was ever committed");
        assert.equal(harness.counters.persist, 0);
    });

    test("more panes than slots disables the preset instead of deleting panes", async () => {
        const five = makeFixture({
            rootNode: fivePaneRoot(),
            useTabAuthority: true,
            factProviders: unreclaimableFacts(["p1", "p2", "p3", "p4", "p5"]),
        });
        const previousShape = JSON.stringify(five.harness.model.treeState.rootNode);

        const result = await applySnapPreset(five.host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "p1",
        });

        assert.equal(result.status, "rejected");
        assert.equal((result as any).reason, "reclaim-unsafe", "panes nobody may reclaim cannot be dropped");
        assert.isEmpty(five.services.created);
        assert.isEmpty(five.services.deleted, "no pane may be deleted by a rejected preset");
        assert.equal(JSON.stringify(five.harness.model.treeState.rootNode), previousShape);
        assert.equal(five.harness.counters.persist, 0);
    });

    test("a five-pane layout shrinks into a four-slot preset only for a proven-empty filler", async () => {
        const panes = ["p1", "p2", "p3", "p4", "filler"];
        const five = makeFixture({
            rootNode: fivePaneRoot(),
            useTabAuthority: true,
            factProviders: {
                ...unreclaimableFacts(panes),
                // Only the last pane carries the Snap provenance marker and is untouched.
                getBlockRecord: (blockId: string) => ({
                    meta: {
                        view: "term",
                        controller: "shell",
                        ...(blockId === "filler" ? { [SNAP_AUTOCREATED_META_KEY]: true } : {}),
                    },
                    jobId: "",
                }),
            },
        });
        // fivePaneRoot uses p1..p5; rename the last pane so the filler is addressable.
        five.harness.tab.blockids = [...panes];
        five.harness.model.treeState.rootNode = fivePaneRootNamed(panes);

        const result = await applySnapPreset(five.host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "p1",
        });

        assert.equal(result.status, "applied");
        if (result.status === "applied") {
            assert.deepEqual(result.reclaimedBlockIds, ["filler"], "only the proven-empty filler is removed");
        }
        assert.deepEqual(five.services.deleted, ["filler"]);
        assert.notInclude(five.harness.model.getLeafBlockIds(), "filler");
        assert.lengthOf(five.harness.model.getLeafBlockIds(), 4);
    });

    test("a pane that becomes used between the plan and the window is never removed", async () => {
        // Three panes, two slots, one pane to reclaim. The journal starts empty and reports a command
        // from the second collection onwards - which is the one taken inside the mutation window.
        const panes = ["pane-a", "filler-1", "filler-2"];
        let journalCalls = 0;
        const shrink = makeFixture({
            rootNode: fivePaneRootNamed(panes),
            tabBlockIds: panes,
            useTabAuthority: true,
            factProviders: {
                ...unreclaimableFacts(panes),
                getBlockRecord: (blockId: string) => ({
                    meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: true },
                    jobId: "",
                }),
                getJournalUsage: async (blockId: string) => {
                    journalCalls += 1;
                    const used = journalCalls > panes.length && blockId === "filler-1";
                    return { healthy: true, recordCount: used ? 1 : 0 };
                },
            },
        });

        const result = await applySnapPreset(shrink.host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "rejected");
        assert.equal((result as any).reason, "reclaim-unsafe");
        assert.isEmpty(shrink.services.created, "an abandoned shrink creates nothing");
        assert.isEmpty(shrink.services.deleted, "and removes nothing");
        assert.equal(shrink.harness.counters.updateTree, 0, "the layout is never touched");
        assert.equal(shrink.harness.counters.persist, 0);
        assert.isFalse(shrink.harness.model.isSnapApplyInFlight(), "the window is closed again");
    });

    test("a pane that leaves the tab right after the commit is never removed", async () => {
        const panes = ["pane-a", "filler-1", "filler-2"];
        const shrink = makeFixture({
            rootNode: fivePaneRootNamed(panes),
            tabBlockIds: panes,
            useTabAuthority: true,
            factProviders: {
                ...unreclaimableFacts(panes),
                getBlockRecord: () => ({
                    meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: true },
                    jobId: "",
                }),
            },
        });
        // The tab drops the pane from its block list the moment the tree is committed.
        const realCommit = shrink.harness.model.commitSnapRoot.bind(shrink.harness.model);
        (shrink.harness.model as any).commitSnapRoot = (rootNode: LayoutNode, focusedNodeId?: string) => {
            realCommit(rootNode, focusedNodeId);
            shrink.harness.tab.blockids = shrink.harness.tab.blockids.filter((id) => id !== "filler-1");
        };

        const result = await applySnapPreset(shrink.host, {
            preset: getSnapPresetById("two-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        assert.equal((result as any).reason, "reclaim-failed");
        assert.notInclude(shrink.services.deleted, "filler-1", "a pane the tab no longer owns is not removed");
        assert.deepEqual(
            shrink.harness.model.getLeafBlockIds(),
            panes,
            "the previous layout is put back instead"
        );
        assert.isFalse(shrink.harness.model.isSnapApplyInFlight());
    });

    test("the advisory reclaim list uses real tab ownership", async () => {
        const panes = ["pane-a", "filler-1"];
        const fixture = makeFixture({
            rootNode: fivePaneRootNamed(panes),
            tabBlockIds: ["pane-a"],
            useTabAuthority: true,
            factProviders: {
                ...unreclaimableFacts(panes),
                getBlockRecord: () => ({
                    meta: { view: "term", controller: "shell", [SNAP_AUTOCREATED_META_KEY]: true },
                    jobId: "",
                }),
            },
        });

        const reclaimable = await collectReclaimablePaneIds(fixture.harness.model, fixture.factProviders);

        assert.notInclude(
            reclaimable,
            "filler-1",
            "a pane the tab does not own is never offered for reclaiming, however empty it looks"
        );
        assert.include(reclaimable, "pane-a", "the pane the tab does own is offered");
    });

    test("the created Local Terminal is a shell-backed terminal block", async () => {        const { services, host } = fixture;
        await applySnapPreset(host, {
            preset: getSnapPresetById("three-columns")!,
            stickySlotId: "left",
            stickyBlockId: "pane-a",
        });
        assert.equal(services.createdBlockDefs.length, 1);
        assert.equal(services.createdBlockDefs[0].meta.view, "term");
        assert.equal(services.createdBlockDefs[0].meta.controller, "shell");
    });

    test("a leaked block is reported instead of being silently dropped", async () => {
        const { services, host, harness } = fixture;
        services.failDelete = true;
        (harness.model as any).commitSnapRoot = () => {
            throw new Error("commit boom");
        };

        const result = await applySnapPreset(host, {
            preset: getSnapPresetById("four-grid")!,
            stickySlotId: "top-left",
            stickyBlockId: "pane-a",
        });

        assert.equal(result.status, "failed");
        assert.isEmpty((result as any).rolledBackBlockIds);
        assert.deepEqual((result as any).leakedBlockIds, ["created-1", "created-2"], "undeletable blocks surface");
    });
});
