// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Materializes a Snap Layout preset into a complete LayoutNode tree.
 *
 * Why the whole tree is built here instead of using `InsertAtIndex`: that path appends through
 * `addChildAt`, which inserts intermediate nodes, flattens same-direction children and reverses
 * opposite-direction ones (see the comment at layoutTree.ts "addChildAt (which may flatten nodes)").
 * An index path therefore cannot rebuild a heterogeneous nested preset, and a preset applied pane by
 * pane could be rebalanced into a different shape. Building the finished tree and committing it in
 * one action is both exact and atomic.
 *
 * This module is pure: it takes the preset, the block ids and the slot assignment, and returns
 * nodes. It performs no I/O, so it can be checked directly against the layout model's own
 * `validateNode` and `walkNodes` without a running app.
 */

import { FlexDirection, LayoutNode } from "./types";
import { SnapPreset, SnapSlotTemplate, SnapTemplate, collectSlots, templateWeight } from "./snapPresets";

export interface MaterializeRequest {
    preset: SnapPreset;
    /** Block id to place in each slot. Every slot of the preset must be present. */
    blockIdsBySlot: Record<string, string>;
    /** Slot that will hold the pane the user dragged. Used for focus when it is not given. */
    stickySlotId?: string;
    /** Node id to focus after the tree is committed. Defaults to the sticky slot's node. */
    focusedSlotId?: string;
}

export interface MaterializedTree {
    rootNode: LayoutNode;
    /** Node id of each leaf, keyed by slot id, so callers can focus or address a pane. */
    nodeIdBySlot: Record<string, string>;
    focusedNodeId: string;
}

/** Generates a node id. Mirrors newLayoutNode, which uses crypto.randomUUID(). */
function newNodeId(): string {
    return crypto.randomUUID();
}

/**
 * Builds the complete tree for a preset.
 *
 * Sizes are relative shares: a child's size is its weight as a fraction of the weights of its
 * siblings within the parent's own size, so nested groups keep a correct proportion at every level.
 * The layout model expects sibling sizes to sum to the parent's size, and the root's children to sum
 * to 100.
 */
export function materializeSnapPreset(request: MaterializeRequest): MaterializedTree {
    const nodeIdBySlot: Record<string, string> = {};
    const slots = collectSlots(request.preset.root);
    const missing = slots.filter((slot) => !request.blockIdsBySlot[slot.slotId]);
    if (missing.length > 0) {
        throw new Error(
            `snap preset ${request.preset.id} cannot be materialized: no block for slot(s) ${missing
                .map((slot) => slot.slotId)
                .join(", ")}`
        );
    }

    const rootNode = buildNode(request.preset.root, 100, request.blockIdsBySlot, nodeIdBySlot);
    const focusedSlotId = request.focusedSlotId ?? request.stickySlotId ?? slots[0].slotId;
    const focusedNodeId = nodeIdBySlot[focusedSlotId];
    if (!focusedNodeId) {
        throw new Error(`snap preset ${request.preset.id} has no slot named ${focusedSlotId}`);
    }
    return { rootNode, nodeIdBySlot, focusedNodeId };
}

function buildNode(
    template: SnapTemplate,
    size: number,
    blockIdsBySlot: Record<string, string>,
    nodeIdBySlot: Record<string, string>
): LayoutNode {
    if (template.kind === "slot") {
        return buildLeaf(template, size, blockIdsBySlot, nodeIdBySlot);
    }
    const siblingCount = template.children.length;
    const weights = template.children.map((child) => templateWeight(child, siblingCount));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const children = template.children.map((child, index) =>
        buildNode(child, Math.round((size * weights[index]) / totalWeight), blockIdsBySlot, nodeIdBySlot)
    );
    return {
        id: newNodeId(),
        flexDirection: template.direction === "column" ? FlexDirection.Column : FlexDirection.Row,
        size,
        children,
    };
}

function buildLeaf(
    template: SnapSlotTemplate,
    size: number,
    blockIdsBySlot: Record<string, string>,
    nodeIdBySlot: Record<string, string>
): LayoutNode {
    const data: TabLayoutData = { blockId: blockIdsBySlot[template.slotId] };
    const node: LayoutNode = {
        id: newNodeId(),
        flexDirection: FlexDirection.Row,
        size,
        data,
    };
    nodeIdBySlot[template.slotId] = node.id;
    return node;
}

/**
 * Copies a tree, swapping the block ids named in `substitutions`.
 *
 * Used to put a replaced layout back after a failed down-size: the panes that were already removed are
 * re-created as equivalent empty terminals (that is exactly what a reclaimable pane is), and the
 * restored tree has to point at the new ids. Node ids are kept, so the original focus node still
 * resolves.
 */
export function substituteTreeBlockIds(rootNode: LayoutNode, substitutions: Record<string, string>): LayoutNode {
    const copyNode = (node: LayoutNode): LayoutNode => {
        const copy: LayoutNode = {
            id: node.id,
            flexDirection: node.flexDirection,
            size: node.size,
        };
        if (node.data != null) {
            const blockId = node.data.blockId;
            copy.data = { blockId: substitutions[blockId] ?? blockId };
        }
        if (node.children != null) {
            copy.children = node.children.map(copyNode);
        }
        return copy;
    };
    return copyNode(rootNode);
}
