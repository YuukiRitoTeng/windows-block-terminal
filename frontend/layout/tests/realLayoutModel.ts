// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A real `LayoutModel` with only its runtime edges stubbed.
 *
 * Snap Layout commit tests need to observe what the *production* model does - how many render passes
 * it runs, whether it rebalances, how many store writes and persists it schedules - without an
 * Electron host, a DOM container or a backend. This harness keeps the reducer and the tree state
 * real and replaces only the four edges a test environment cannot provide, recording every call so
 * assertions are made against observed behaviour rather than against re-implemented logic.
 */

import { LayoutModel } from "@/layout/lib/layoutModel";
import { LayoutNode } from "@/layout/lib/types";

export interface ModelCallCounters {
    /** Number of `updateTree` calls, i.e. render-tree passes. */
    updateTree: number;
    /** The `balanceTree` argument of each pass, in order. */
    updateTreeBalance: boolean[];
    /** Number of debounced backend persists scheduled. */
    persist: number;
    /** Number of local tree-state store writes. */
    setter: number;
}

export interface RealModelHarness {
    model: LayoutModel;
    counters: ModelCallCounters;
    /** The root node as seen by each render pass, in order. */
    renderedRoots: LayoutNode[];
    /**
     * The tab record the model reads through its getter. This is the authority for ownership and for
     * orphan cleanup in production, so tests drive it instead of stubbing those code paths.
     */
    tab: { blockids: string[] };
}

export function makeRealLayoutModel(
    initialRootNode: LayoutNode,
    options: { tabBlockIds?: string[] } = {}
): RealModelHarness {
    const counters: ModelCallCounters = { updateTree: 0, updateTreeBalance: [], persist: 0, setter: 0 };
    const renderedRoots: LayoutNode[] = [];
    const model = Object.create(LayoutModel.prototype) as LayoutModel;
    const anyModel = model as any;
    const tab = { blockids: [...(options.tabBlockIds ?? blockIdsOf(initialRootNode))] };
    const tabAtom = { toString: () => "test-tab-atom" };

    anyModel.treeState = { rootNode: initialRootNode, pendingBackendActions: [] };
    anyModel.magnifiedNodeId = undefined;
    anyModel.lastMagnifiedNodeId = undefined;
    anyModel.lastEphemeralNodeId = undefined;
    anyModel.focusedNodeIdStack = [];
    anyModel.snapApplyDepth = 0;
    anyModel.persistDebounceTimer = null;
    anyModel.localTreeStateAtom = {};
    anyModel.tabAtom = tabAtom;
    // The model reads both the tab record and the tree through the same getter, as in production.
    anyModel.getter = (atom: unknown) => (atom === tabAtom ? tab : initialRootNode);
    anyModel.setter = () => {
        counters.setter += 1;
    };
    anyModel.updateTree = (balanceTree = true) => {
        counters.updateTree += 1;
        counters.updateTreeBalance.push(balanceTree);
        renderedRoots.push(anyModel.treeState.rootNode);
    };
    anyModel.persistToBackend = () => {
        counters.persist += 1;
    };
    return { model, counters, renderedRoots, tab };
}

/** Two panes side by side, which is also the shape a new workspace starts in. */
export function twoPaneRoot(): LayoutNode {
    return {
        id: "old-root",
        flexDirection: "row" as any,
        size: 100,
        children: [
            { id: "old-a", flexDirection: "row" as any, size: 50, data: { blockId: "pane-a" } },
            { id: "old-b", flexDirection: "row" as any, size: 50, data: { blockId: "pane-b" } },
        ],
    };
}

/** Every block id placed in the tree, in leaf order. */
export function blockIdsOf(rootNode: LayoutNode): string[] {
    const ids: string[] = [];
    const visit = (node: LayoutNode) => {
        if (node.data != null) {
            ids.push(node.data.blockId);
            return;
        }
        for (const child of node.children ?? []) {
            visit(child);
        }
    };
    visit(rootNode);
    return ids;
}
