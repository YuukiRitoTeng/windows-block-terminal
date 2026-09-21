// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the runtime half of atomic Snap Layout application against the real LayoutModel.
 *
 * The materializer tests show the tree is correct; these tests show the *commit* is. They drive the
 * real `LayoutModel.commitSnapRoot` entry point, with the model's own `updateTree` and
 * `persistToBackend` instrumented, so the guarantees that matter at runtime are observed rather
 * than assumed:
 *
 *   - the replacement tree is committed unchanged (no balanceNode rewrite),
 *   - exactly one store write and one persist per apply,
 *   - focus lands on the requested pane,
 *   - a mid-apply failure leaves the previous tree in place, and a failure that happens *after* the
 *     tree was replaced puts it back,
 *   - the tree's leaves and the tab's panes agree, so orphan cleanup finds nothing to delete,
 *   - the real debounced backend persist writes the committed tree, and a failed commit writes nothing.
 */

import { LayoutModel } from "@/layout/lib/layoutModel";
import { materializeSnapPreset } from "@/layout/lib/snapMaterialize";
import { getSnapPresetById } from "@/layout/lib/snapPresets";
import { validateNode, walkNodes } from "@/layout/lib/layoutNode";
import { LayoutNode } from "@/layout/lib/types";
import { RealModelHarness, blockIdsOf, makeRealLayoutModel, twoPaneRoot } from "@/layout/tests/realLayoutModel";
import { assert, beforeEach, describe, test, vi } from "vitest";

/** The persisted snapshots the real `persistToBackend` debounce would have sent to the backend. */
const persistedSnapshots = vi.hoisted(() => [] as { rootnode: LayoutNode; focusednodeid?: string }[]);
vi.mock("@/app/store/wos", () => ({
    setObjectValue: (waveObj: any) => {
        persistedSnapshots.push({ rootnode: waveObj.rootnode, focusednodeid: waveObj.focusednodeid });
    },
}));

describe("LayoutModel.commitSnapRoot: atomic replacement", () => {
    let harness: RealModelHarness;

    beforeEach(() => {
        harness = makeRealLayoutModel(twoPaneRoot());
    });

    test("commits the materialized preset shape without rebalancing it", () => {
        const preset = getSnapPresetById("left-major-with-right-stack")!;
        const { rootNode, focusedNodeId, nodeIdBySlot } = materializeSnapPreset({
            preset,
            blockIdsBySlot: { left: "pane-a", "right-top": "pane-b", "right-bottom": "new-c" },
        });
        harness.model.commitSnapRoot(rootNode, focusedNodeId);

        assert.equal(harness.counters.updateTree, 1, "exactly one render-tree pass");
        assert.deepEqual(harness.counters.updateTreeBalance, [false], "the pass must skip balanceNode");
        assert.equal(harness.renderedRoots[0], rootNode, "the committed tree is the materialized tree");
        // The nested stack must survive untouched: balanceNode would flatten or re-wrap it.
        assert.equal(rootNode.children![1].flexDirection, "column");
        assert.deepEqual(blockIdsOf(rootNode), ["pane-a", "pane-b", "new-c"]);
        assert.equal(harness.model.getLeafBlockIds().length, 3);
        assert.equal(nodeIdBySlot["right-bottom"], rootNode.children![1].children![1].id);
    });

    test("produces exactly one store write and one persist for the whole apply", () => {
        const preset = getSnapPresetById("four-grid")!;
        const { rootNode, focusedNodeId } = materializeSnapPreset({
            preset,
            blockIdsBySlot: { "top-left": "a", "top-right": "b", "bottom-left": "c", "bottom-right": "d" },
        });
        harness.model.commitSnapRoot(rootNode, focusedNodeId);

        // `setter` counts the model's own store writes; the render pass is stubbed, so the derived
        // leafs/leafOrder/additionalProps atoms are out of scope and this is the tree-state write.
        assert.equal(harness.counters.setter, 1, "one tree-state write");
        assert.equal(harness.counters.persist, 1, "one debounced persist schedule");
        assert.equal(harness.counters.updateTree, 1, "one render-tree pass");
    });

    test("sets focus to the requested pane and keeps the tree valid", () => {
        const preset = getSnapPresetById("four-grid")!;
        const { rootNode, focusedNodeId, nodeIdBySlot } = materializeSnapPreset({
            preset,
            blockIdsBySlot: { "top-left": "a", "top-right": "b", "bottom-left": "c", "bottom-right": "d" },
            stickySlotId: "bottom-right",
        });
        harness.model.commitSnapRoot(rootNode, focusedNodeId);

        assert.equal(harness.model.treeState.focusedNodeId, nodeIdBySlot["bottom-right"]);
        walkNodes(rootNode, (node) => assert.isTrue(validateNode(node), "committed node must be valid"));
    });

    test("a commit without an explicit focus lands on the first pane of the new tree", () => {
        const preset = getSnapPresetById("left-major-with-right-stack")!;
        const { rootNode, nodeIdBySlot } = materializeSnapPreset({
            preset,
            blockIdsBySlot: { left: "pane-a", "right-top": "pane-b", "right-bottom": "new-c" },
        });
        // The replacement never reuses the previous node ids, so carrying the previous focus over
        // would leave it pointing at a node that no longer exists.
        harness.model.commitSnapRoot(rootNode);

        assert.equal(harness.model.treeState.focusedNodeId, nodeIdBySlot["left"]);
        walkNodes(rootNode, (node) => assert.isTrue(validateNode(node), "committed node must be valid"));
    });

    test("a bare clear still empties the tree and drops focus", () => {
        // The replacement variant must not change the meaning of an ordinary clear.
        harness.model.treeReducer({ type: "clear" } as any, false);
        assert.isUndefined(harness.model.treeState.rootNode);
        assert.isUndefined(harness.model.treeState.focusedNodeId);
    });

    test("the tab's panes equal the tree leaves after commit, so orphan cleanup finds nothing", () => {
        const preset = getSnapPresetById("three-columns")!;
        const { rootNode, focusedNodeId } = materializeSnapPreset({
            preset,
            blockIdsBySlot: { left: "pane-a", center: "pane-b", right: "pane-c" },
        });
        const panesBefore = harness.model.getLeafBlockIds();
        harness.model.commitSnapRoot(rootNode, focusedNodeId);

        const leaves = harness.model.getLeafBlockIds();
        assert.deepEqual(leaves, ["pane-a", "pane-b", "pane-c"]);
        // Nothing that existed before survived outside the tree, so cleanupOrphanedBlocks has no
        // block to delete: the commit is a single tree swap, not a create-then-insert sequence.
        const orphans = panesBefore.filter((blockId) => !leaves.includes(blockId));
        assert.isEmpty(orphans, "no pane may be left outside the committed tree");
    });

    test("a failure before commit leaves the previous tree exactly as it was", () => {
        const before = harness.model.getLeafBlockIds();
        const beforeRoot = harness.model.treeState.rootNode;
        // Materialization fails when a slot has no block, which is the shape of a create failure.
        assert.throws(
            () =>
                materializeSnapPreset({
                    preset: getSnapPresetById("four-grid")!,
                    blockIdsBySlot: { "top-left": "pane-a" },
                }),
            /no block for slot/
        );
        assert.equal(harness.model.treeState.rootNode, beforeRoot, "the previous tree is untouched");
        assert.deepEqual(harness.model.getLeafBlockIds(), before);
        assert.equal(harness.counters.persist, 0, "a failed apply must not persist");
        assert.equal(harness.counters.updateTree, 0, "a failed apply must not re-render");
    });

    describe("a commit that fails after the tree was already replaced rolls itself back", () => {
        // The reducer mutates the tree first and only then renders, writes the store and persists.
        // Each of those three steps is a place where the commit can die with the new tree already
        // installed, which is the case the apply layer cannot fix on its own: it only knows about the
        // blocks it created, not about the tree it replaced.
        const failingSteps = [
            { name: "render", breakStep: (h: RealModelHarness) => (h.model as any).updateTree },
            { name: "store write", breakStep: (h: RealModelHarness) => (h.model as any).setter },
            { name: "persist", breakStep: (h: RealModelHarness) => (h.model as any).persistToBackend },
        ];

        for (const step of failingSteps) {
            test(`a ${step.name} failure restores the previous root, focus and magnification`, () => {
                const preset = getSnapPresetById("left-major-with-right-stack")!;
                const { rootNode, focusedNodeId } = materializeSnapPreset({
                    preset,
                    blockIdsBySlot: { left: "pane-a", "right-top": "new-c", "right-bottom": "pane-b" },
                });
                const previousRoot = harness.model.treeState.rootNode;
                // Give the old tree a focus, a magnification and a leaf order so their restoration is
                // observable: clearTree wipes all three as part of installing the replacement.
                harness.model.treeState.focusedNodeId = "old-a";
                harness.model.treeState.magnifiedNodeId = "old-b";
                harness.model.treeState.leafOrder = [{ nodeid: "old-a", blockid: "pane-a" }];
                const previousLeafOrder = harness.model.treeState.leafOrder;
                (harness.model as any).magnifiedNodeId = "old-b";

                const original = step.breakStep(harness);
                let calls = 0;
                let rootAtFailure: LayoutNode;
                const exploding = () => {
                    calls += 1;
                    // The tree is already the replacement at this point: that is exactly the partial
                    // mutation the commit has to be able to undo.
                    rootAtFailure = harness.model.treeState.rootNode;
                    throw new Error(`${step.name} failed`);
                };
                // Only the first call fails: the rollback repair pass must still be able to run.
                const replacement = (...args: any[]) => (calls === 0 ? exploding() : original.apply(harness.model, args));
                if (step.name === "render") (harness.model as any).updateTree = replacement;
                if (step.name === "store write") (harness.model as any).setter = replacement;
                if (step.name === "persist") (harness.model as any).persistToBackend = replacement;

                assert.throws(() => harness.model.commitSnapRoot(rootNode, focusedNodeId), new RegExp(`${step.name} failed`));

                assert.equal(rootAtFailure, rootNode, "the failure must happen after the tree was replaced");
                assert.equal(harness.model.treeState.rootNode, previousRoot, "previous root restored");
                assert.equal(harness.model.treeState.leafOrder, previousLeafOrder, "previous leaf order restored");
                assert.equal(harness.model.treeState.focusedNodeId, "old-a", "previous focus restored");
                assert.equal(harness.model.treeState.magnifiedNodeId, "old-b", "previous magnification restored");
                assert.equal((harness.model as any).magnifiedNodeId, "old-b");
                assert.deepEqual(harness.model.getLeafBlockIds(), ["pane-a", "pane-b"], "old panes are back");
            });
        }

        test("the repair pass runs updateTree(false) and does not mask the original error", () => {
            const { rootNode, focusedNodeId } = materializeSnapPreset({
                preset: getSnapPresetById("two-rows")!,
                blockIdsBySlot: { top: "pane-a", bottom: "new-c" },
            });
            harness.counters.updateTreeBalance.length = 0;
            const realSetter = (harness.model as any).setter;
            let setterCalls = 0;
            (harness.model as any).setter = (...args: any[]) => {
                setterCalls += 1;
                if (setterCalls === 1) throw new Error("store write failed");
                return realSetter.apply(harness.model, args);
            };

            assert.throws(() => harness.model.commitSnapRoot(rootNode, focusedNodeId), /store write failed/);
            // The failed commit's render pass plus the repair pass, neither of which may rebalance.
            assert.deepEqual(harness.counters.updateTreeBalance, [false, false]);
        });
    });

    test("every frozen preset commits unchanged on the real model", () => {
        for (const preset of ["two-columns", "two-rows", "three-columns", "four-grid"] as const) {
            const model = makeRealLayoutModel(twoPaneRoot());
            const blockIdsBySlot: Record<string, string> = {};
            if (preset === "two-columns") Object.assign(blockIdsBySlot, { left: "a", right: "b" });
            if (preset === "two-rows") Object.assign(blockIdsBySlot, { top: "a", bottom: "b" });
            if (preset === "three-columns") Object.assign(blockIdsBySlot, { left: "a", center: "b", right: "c" });
            if (preset === "four-grid")
                Object.assign(blockIdsBySlot, { "top-left": "a", "top-right": "b", "bottom-left": "c", "bottom-right": "d" });
            const { rootNode, focusedNodeId } = materializeSnapPreset({
                preset: getSnapPresetById(preset)!,
                blockIdsBySlot,
            });
            const shapeBefore = JSON.stringify(rootNode);
            model.model.commitSnapRoot(rootNode, focusedNodeId);
            assert.equal(JSON.stringify(model.model.treeState.rootNode), shapeBefore, `${preset} was rewritten`);
            assert.equal(model.counters.persist, 1, `${preset} must persist once`);
        }
    });

    describe("the real debounced backend persist", () => {
        /** Swaps the harness's persist stub for the real debounce, wired to a fake wave object. */
        function useRealPersist(harness: RealModelHarness): { waveObj: any } {
            const waveObj: any = {};
            const waveObjectAtom = { toString: () => "test-wave-object-atom" };
            const baseGetter = (harness.model as any).getter;
            (harness.model as any).waveObjectAtom = waveObjectAtom;
            (harness.model as any).getter = (atom: unknown) =>
                atom === waveObjectAtom ? waveObj : baseGetter(atom);
            (harness.model as any).persistToBackend = (LayoutModel.prototype as any).persistToBackend.bind(
                harness.model
            );
            return { waveObj };
        }

        test("a successful commit persists the replacement tree exactly once", async () => {
            vi.useFakeTimers();
            persistedSnapshots.length = 0;
            const local = makeRealLayoutModel(twoPaneRoot());
            const { waveObj } = useRealPersist(local);
            const { rootNode, focusedNodeId, nodeIdBySlot } = materializeSnapPreset({
                preset: getSnapPresetById("two-rows")!,
                blockIdsBySlot: { top: "pane-a", bottom: "created-1" },
            });

            local.model.commitSnapRoot(rootNode, focusedNodeId);
            await vi.advanceTimersByTimeAsync(200);
            vi.useRealTimers();

            assert.lengthOf(persistedSnapshots, 1, "one debounced write for the whole commit");
            assert.equal(persistedSnapshots[0].rootnode, rootNode, "the backend sees the preset tree");
            assert.equal(persistedSnapshots[0].focusednodeid, nodeIdBySlot["top"]);
            assert.equal(waveObj.rootnode, rootNode, "the wave object carries the committed tree");
        });

        test("a failed commit never hands the replacement tree to the backend", async () => {
            vi.useFakeTimers();
            persistedSnapshots.length = 0;
            const local = makeRealLayoutModel(twoPaneRoot());
            const { waveObj } = useRealPersist(local);
            const previousRoot = local.model.treeState.rootNode;
            // The store write fails after the tree was already replaced. It runs before the persist in
            // the same pass, so this commit must not have scheduled anything at all.
            let setterCalls = 0;
            const realSetter = (local.model as any).setter;
            (local.model as any).setter = (...args: any[]) => {
                setterCalls += 1;
                if (setterCalls === 1) throw new Error("store write failed");
                return realSetter.apply(local.model, args);
            };
            const { rootNode, focusedNodeId } = materializeSnapPreset({
                preset: getSnapPresetById("four-grid")!,
                blockIdsBySlot: { "top-left": "pane-a", "top-right": "pane-b", "bottom-left": "c", "bottom-right": "d" },
            });

            assert.throws(() => local.model.commitSnapRoot(rootNode, focusedNodeId), /store write failed/);
            await vi.advanceTimersByTimeAsync(200);
            vi.useRealTimers();

            assert.isEmpty(persistedSnapshots, "a failed commit must not persist");
            assert.equal(waveObj.rootnode, undefined, "the backend object was never handed a tree");
            assert.equal(local.model.treeState.rootNode, previousRoot, "and the model kept its old tree");
        });
    });
});
