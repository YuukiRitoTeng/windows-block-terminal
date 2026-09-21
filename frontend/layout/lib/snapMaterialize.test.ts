// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the Snap Layout materializer against the layout model's real node contract.
 *
 * These tests deliberately drive the model's own `validateNode`, `walkNodes` and `balanceNode`
 * rather than re-implementing their rules, because the point of the materializer is to produce trees
 * the live layout accepts unchanged.
 */

import { balanceNode, validateNode, walkNodes } from "@/layout/lib/layoutNode";
import { materializeSnapPreset } from "@/layout/lib/snapMaterialize";
import { SNAP_PRESETS, collectSlots, countSlots, getSnapPresetById } from "@/layout/lib/snapPresets";
import { FlexDirection, LayoutNode } from "@/layout/lib/types";
import { assert, describe, test } from "vitest";

function blockIdsFor(presetId: string): Record<string, string> {
    const preset = getSnapPresetById(presetId)!;
    const map: Record<string, string> = {};
    for (const slot of collectSlots(preset.root)) {
        map[slot.slotId] = `block-${presetId}-${slot.slotId}`;
    }
    return map;
}

function materialize(presetId: string, stickySlotId?: string) {
    const preset = getSnapPresetById(presetId)!;
    return materializeSnapPreset({
        preset,
        blockIdsBySlot: blockIdsFor(presetId),
        stickySlotId,
    });
}

function collectNodes(rootNode: LayoutNode): LayoutNode[] {
    const nodes: LayoutNode[] = [];
    walkNodes(rootNode, (node) => nodes.push(node));
    return nodes;
}

function leaves(rootNode: LayoutNode): LayoutNode[] {
    return collectNodes(rootNode).filter((node) => node.data != null);
}

function groups(rootNode: LayoutNode): LayoutNode[] {
    return collectNodes(rootNode).filter((node) => node.children != null);
}

describe("materializeSnapPreset: real layout contract", () => {
    test("every frozen preset materializes into a tree validateNode accepts", () => {
        for (const preset of SNAP_PRESETS) {
            const { rootNode } = materialize(preset.id);
            for (const node of collectNodes(rootNode)) {
                assert.isTrue(validateNode(node), `preset ${preset.id} produced an invalid node`);
            }
        }
    });

    test("every leaf carries data and no children, and every group carries children and no data", () => {
        for (const preset of SNAP_PRESETS) {
            const { rootNode } = materialize(preset.id);
            for (const node of collectNodes(rootNode)) {
                if (node.children != null) {
                    assert.isUndefined(node.data, `preset ${preset.id} group node must not carry data`);
                    assert.isAbove(node.children.length, 0, "groups must not be empty");
                } else {
                    assert.isDefined(node.data, `preset ${preset.id} leaf must carry data`);
                    assert.isDefined(node.data!.blockId);
                }
            }
        }
    });

    test("the materialized tree places exactly the preset's slots, one pane each", () => {
        for (const preset of SNAP_PRESETS) {
            const { rootNode, nodeIdBySlot } = materialize(preset.id);
            const leafNodes = leaves(rootNode);
            assert.lengthOf(leafNodes, countSlots(preset), `preset ${preset.id} leaf count`);
            const blockIds = leafNodes.map((node) => node.data!.blockId);
            assert.equal(new Set(blockIds).size, blockIds.length, "a block must not appear twice");
            assert.equal(Object.keys(nodeIdBySlot).length, countSlots(preset));
            for (const [slotId, nodeId] of Object.entries(nodeIdBySlot)) {
                const placed = leafNodes.find((node) => node.id === nodeId);
                assert.isDefined(placed, `slot ${slotId} must map to a real node`);
                assert.equal(placed!.data!.blockId, `block-${preset.id}-${slotId}`);
            }
        }
    });

    test("the materialized tree survives balanceNode unchanged", () => {
        // balanceNode minimises nested single-child nodes and fixes flex order. If a preset needed
        // rebalancing, the tree committed at apply time would not be the tree the preset describes.
        for (const preset of SNAP_PRESETS) {
            const { rootNode, nodeIdBySlot } = materialize(preset.id);
            const balanced = balanceNode(rootNode);
            assert.equal(
                leaves(balanced).length,
                countSlots(preset),
                `preset ${preset.id} changed shape under balanceNode`
            );
            assert.equal(balanced.flexDirection, rootNode.flexDirection, `preset ${preset.id} root direction`);
            assert.deepEqual(
                Object.keys(nodeIdBySlot).sort(),
                collectSlots(preset.root)
                    .map((slot) => slot.slotId)
                    .sort()
            );
        }
    });

    test("each group's child sizes sum to the group's own size", () => {
        for (const preset of SNAP_PRESETS) {
            const { rootNode } = materialize(preset.id);
            for (const group of groups(rootNode)) {
                const sum = group.children!.reduce((total, child) => total + child.size, 0);
                assert.equal(sum, group.size, `preset ${preset.id} children must fill their parent`);
            }
            const rootSum = rootNode.children!.reduce((total, child) => total + child.size, 0);
            assert.equal(rootSum, 100, `preset ${preset.id} root children must fill 100`);
        }
    });

    test("asymmetric presets keep their proportions in the node sizes", () => {
        const { rootNode } = materialize("two-columns-asymmetric");
        const sizes = rootNode.children!.map((child) => child.size);
        assert.deepEqual(sizes, [33, 67]);
        const leftMajor = materialize("left-major-with-right-stack").rootNode;
        assert.equal(leftMajor.children![0].size, 50, "the large pane keeps half the width");
        assert.equal(leftMajor.children![1].size, 50, "the stack takes the other half");
    });

    test("nested stacks become column groups, not flat cells", () => {
        const { rootNode } = materialize("left-major-with-right-stack");
        const stack = rootNode.children![1];
        assert.equal(stack.flexDirection, FlexDirection.Column);
        assert.lengthOf(stack.children!, 2);
        assert.isUndefined(stack.data, "the stack itself is not a pane");
        const rightMajor = materialize("right-major-with-left-stack").rootNode;
        assert.equal(rightMajor.children![0].flexDirection, FlexDirection.Column);
        assert.equal(rightMajor.children![1].flexDirection, FlexDirection.Row);
    });

    test("four-grid nests a column of two rows", () => {
        const { rootNode } = materialize("four-grid");
        assert.equal(rootNode.flexDirection, FlexDirection.Column);
        assert.lengthOf(rootNode.children!, 2);
        for (const row of rootNode.children!) {
            assert.equal(row.flexDirection, FlexDirection.Row);
            assert.lengthOf(row.children!, 2);
        }
    });

    test("sizes stay relative at nested levels", () => {
        // The stack is half the width, so each of its panes is half of that half.
        const { rootNode } = materialize("left-major-with-right-stack");
        const stack = rootNode.children![1];
        const stackChildren = stack.children!.reduce((sum, child) => sum + child.size, 0);
        assert.equal(stackChildren, stack.size, "nested children fill their group");
        assert.equal(stackChildren, 50, "the stack's children share the stack's own half");
    });

    test("focus defaults to the sticky pane and can be overridden", () => {
        const sticky = materialize("four-grid", "bottom-right");
        assert.equal(sticky.focusedNodeId, sticky.nodeIdBySlot["bottom-right"]);
        const preset = getSnapPresetById("four-grid")!;
        const overridden = materializeSnapPreset({
            preset,
            blockIdsBySlot: blockIdsFor("four-grid"),
            stickySlotId: "top-left",
            focusedSlotId: "bottom-left",
        });
        assert.equal(overridden.focusedNodeId, overridden.nodeIdBySlot["bottom-left"]);
    });

    test("every node gets a distinct id", () => {
        for (const preset of SNAP_PRESETS) {
            const ids = collectNodes(materialize(preset.id).rootNode).map((node) => node.id);
            assert.equal(new Set(ids).size, ids.length, `preset ${preset.id} reused a node id`);
        }
    });

    test("a preset missing a block for one of its slots is rejected", () => {
        const preset = getSnapPresetById("four-grid")!;
        const partial = blockIdsFor("four-grid");
        delete partial["bottom-right"];
        assert.throws(
            () => materializeSnapPreset({ preset, blockIdsBySlot: partial }),
            /no block for slot/,
            "materializing with an unfilled slot must fail loudly rather than build a hole"
        );
    });

    test("an unknown focus slot is rejected", () => {
        const preset = getSnapPresetById("four-grid")!;
        assert.throws(
            () =>
                materializeSnapPreset({
                    preset,
                    blockIdsBySlot: blockIdsFor("four-grid"),
                    focusedSlotId: "not-a-slot",
                }),
            /no slot named/
        );
    });
});
