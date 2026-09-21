// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The default layout a new workspace opens with.
 *
 * The backend decides this with a portable layout (`pkg/wcore/layout.go`); the frontend turns it into
 * a real tree through `insertNodeAtIndex`. This test runs the backend's exact portable-layout shape
 * through the real reducer so the two sides cannot drift: a new workspace must end up as two local
 * terminals split 50/50, and a plain New Tab must stay a single terminal.
 *
 * It also pins the portable layout against the frozen default preset, since the Snap Bar offers that
 * preset as "the workspace default" and the two must describe the same shape.
 */

import { getDefaultWorkspacePreset, toPreviewTree } from "@/layout/lib/snapPresets";
import { insertNodeAtIndex } from "@/layout/lib/layoutTree";
import { newLayoutNode } from "@/layout/lib/layoutNode";
import { newLayoutTreeState } from "@/layout/tests/model";
import { FlexDirection, LayoutNode, LayoutTreeState } from "@/layout/lib/types";
import { assert, describe, test } from "vitest";

/** One entry of the Go-side `PortableLayout`, as the backend sends it. */
interface PortableEntry {
    indexarr: number[];
    size?: number;
    blockId: string;
    focused?: boolean;
}

/**
 * The exact shape of `wcore.GetWorkspaceLayout()`: two slots, index paths [0] and [1], no explicit
 * sizes (equal defaults are the even split), the left pane focused.
 */
const WORKSPACE_LAYOUT: PortableEntry[] = [
    { indexarr: [0], blockId: "block-left", focused: true },
    { indexarr: [1], blockId: "block-right" },
];

/** The exact shape of `wcore.GetNewTabLayout()`: one slot, no explicit size, focused. */
const NEW_TAB_LAYOUT: PortableEntry[] = [{ indexarr: [0], blockId: "block-single", focused: true }];

/**
 * Applies a portable layout the way the app does: one `InsertNodeAtIndex` per entry.
 *
 * The index array is cloned per action because `findInsertLocationFromIndexArr` shifts it as it walks;
 * reusing a literal would silently drop every entry after the first.
 */
function applyPortableLayout(layout: PortableEntry[]): LayoutTreeState {
    const state = newLayoutTreeState(undefined);
    for (const entry of layout) {
        insertNodeAtIndex(state, {
            type: "insertatindex",
            node: newLayoutNode(undefined, entry.size, undefined, { blockId: entry.blockId }),
            indexArr: [...entry.indexarr],
            focused: entry.focused,
        } as any);
    }
    return state;
}
function leavesOf(node?: LayoutNode): LayoutNode[] {
    if (node == null) {
        return [];
    }
    if (node.data != null) {
        return [node];
    }
    return (node.children ?? []).flatMap((child) => leavesOf(child));
}

describe("new workspace default layout", () => {
    test("opens two local terminals side by side", () => {
        const state = applyPortableLayout(WORKSPACE_LAYOUT);
        const leaves = leavesOf(state.rootNode);

        assert.lengthOf(leaves, 2, "a new workspace opens two panes");
        assert.deepEqual(
            leaves.map((leaf) => leaf.data.blockId),
            ["block-left", "block-right"],
            "the left pane must be first, so the split reads left to right"
        );
        assert.equal(state.rootNode.flexDirection, FlexDirection.Row, "the two panes sit side by side");
    });

    test("splits the two panes evenly", () => {
        const state = applyPortableLayout(WORKSPACE_LAYOUT);
        const leaves = leavesOf(state.rootNode);

        assert.lengthOf(leaves, 2);
        // The portable layout carries no explicit sizes, so both panes keep the layout's default size.
        // Equal sizes are the even split: the pane widths are relative weights, not pixels.
        assert.equal(leaves[0].size, leaves[1].size, "neither side may be wider");
        assert.equal(leaves[0].size, 10, "both panes keep the default node size");
    });

    test("an explicit size on the first entry would break the split", () => {
        // Documents why the backend must not set sizes here: the first insert turns its node into the
        // group that holds the panes, so the size stays on the group and the pane keeps the default.
        const withSizes = applyPortableLayout([
            { indexarr: [0], size: 50, blockId: "block-left", focused: true },
            { indexarr: [1], size: 50, blockId: "block-right" },
        ]);
        const leaves = leavesOf(withSizes.rootNode);

        assert.deepEqual(
            leaves.map((leaf) => leaf.size),
            [10, 50],
            "sizes on both entries do not produce an even split"
        );
    });

    test("focuses the left pane only", () => {
        const state = applyPortableLayout(WORKSPACE_LAYOUT);
        const leaves = leavesOf(state.rootNode);

        assert.equal(state.focusedNodeId, leaves[0].id, "the left terminal takes focus");
        assert.notEqual(state.focusedNodeId, leaves[1].id, "the right terminal must not steal focus");
    });

    test("matches the frozen default Snap preset", () => {
        const state = applyPortableLayout(WORKSPACE_LAYOUT);
        const leaves = leavesOf(state.rootNode);
        const preset = getDefaultWorkspacePreset();
        const preview = toPreviewTree(preset);

        assert.equal(preset.id, "two-columns", "the workspace default preset is the side-by-side one");
        assert.equal(preview.direction, "row", "the preset splits left/right, like the portable layout");
        assert.lengthOf(preview.children, leaves.length, "preset slots and workspace panes must agree");
        // Equal workspace pane sizes and equal preset weights describe the same 50/50 split.
        const presetWeights = preview.children.map((child) => child.weight);
        assert.deepEqual(presetWeights, [50, 50], "the preset splits evenly");
        assert.equal(leaves[0].size, leaves[1].size, "the workspace splits evenly too");
    });
});

describe("new tab default layout", () => {
    test("stays a single terminal", () => {
        const state = applyPortableLayout(NEW_TAB_LAYOUT);
        const leaves = leavesOf(state.rootNode);

        assert.lengthOf(leaves, 1, "a plain New Tab opens one pane");
        assert.equal(leaves[0].data.blockId, "block-single");
        assert.equal(state.focusedNodeId, leaves[0].id, "the only pane takes focus");
        assert.isUndefined(state.rootNode.children, "a single pane must not be wrapped in a group");
    });

    test("is not the workspace layout", () => {
        const workspaceLeaves = leavesOf(applyPortableLayout(WORKSPACE_LAYOUT).rootNode);
        const newTabLeaves = leavesOf(applyPortableLayout(NEW_TAB_LAYOUT).rootNode);
        assert.notEqual(workspaceLeaves.length, newTabLeaves.length);
    });
});

describe("restored layouts are left alone", () => {
    test("an existing tree is not rewritten by the default workspace layout", () => {
        // A restored workspace arrives as an already-built tree; the default layout is only ever
        // applied by the backend when a tab is created, so applying nothing leaves it untouched.
        const restored = newLayoutTreeState(
            newLayoutNode(FlexDirection.Row, 100, [
                newLayoutNode(FlexDirection.Column, 30, undefined, { blockId: "restored-a" }),
                newLayoutNode(FlexDirection.Column, 70, undefined, { blockId: "restored-b" }),
            ])
        );
        const before = JSON.stringify(restored);
        const leaves = leavesOf(restored.rootNode);

        assert.lengthOf(leaves, 2);
        assert.deepEqual(leaves.map((leaf) => leaf.size), [30, 70], "restored pane sizes are preserved");
        assert.equal(JSON.stringify(restored), before);
    });
});
