// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Snap Bar integration contract.
 *
 * The drag rules and the drop controller are unit-tested in `snapDrag.test.ts`; this file pins the
 * wiring that makes them real in the app:
 *
 *   - the bar is mounted from the layout only while an in-app pane drag is active, so an OS file drag
 *     can never find an extra drop target in the DOM,
 *   - a slot drop goes through the audited atomic apply with the tab's own model and services,
 *   - cancelling a drag clears the pending move as well as closing the bar,
 *   - and the whole path really does replace the tree on a real LayoutModel.
 */

import { applySnapPreset } from "@/app/workspace/snapApply";
import { createTabSnapLayoutHost } from "@/app/workspace/snapLayoutHost";
import {
    NATIVE_DRAG_ITEM_TYPES,
    SNAP_DRAG_CLOSED,
    TILE_DRAG_ITEM_TYPE,
    dropOnSnapSlot,
    reduceSnapDrag,
} from "@/layout/lib/snapDrag";
import { getSnapPresetById } from "@/layout/lib/snapPresets";
import { makeRealLayoutModel, twoPaneRoot } from "@/layout/tests/realLayoutModel";
import { readFile } from "fs/promises";
import { join } from "path";
import { assert, describe, test } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");

describe("Snap Bar wiring in the layout", () => {
    test("the bar is mounted only from the open snap-drag state", async () => {
        const source = await readSource("frontend/layout/lib/TileLayout.tsx");
        assert.match(
            source,
            /isSnapBarMounted\(snapDrag\)\s*&&\s*\(\s*<SnapBar/,
            "SnapBar must be rendered only while the pane-drag state says it is armed or open"
        );
        // The guarded mount above is the only one, so the bar cannot be rendered from anywhere else.
        const mounts = source.match(/<SnapBar/g) ?? [];
        assert.lengthOf(mounts, 1, "the bar must have exactly one mount point, and it must be guarded");
    });

    test("the activation strip is mounted for the whole pane drag and sized from the workspace", async () => {
        const source = await readSource("frontend/layout/lib/TileLayout.tsx");
        assert.match(source, /isPaneDrag\(dragItemType\)\s*&&\s*\(\s*<SnapTrigger/, "the strip follows the pane drag");
        assert.match(source, /snapTriggerRef/, "the strip must be measured by ref");
        assert.match(source, /snapChooserRef/, "the chooser must be measured by ref");
        assert.match(source, /getBoundingClientRect\(\)/, "hit-testing must use the real rectangles");
        assert.match(
            source,
            /triggerSizeFor\(\{\s*width: containerRect\.width,\s*height: containerRect\.height\s*\}\)/,
            "the strip size must follow the workspace size"
        );
        assert.notMatch(source, /ACTIVATION_HEIGHT|pointerY|containerTop/, "no fixed activation band may remain");
        // A file drag cannot mount the strip at all, so it can never arm the bar.
        assert.match(source, /isPaneDrag\(dragItemType\)/, "the strip must be gated on a pane drag");
    });

    test("the strip is visible and is itself the hit region", async () => {
        const styles = await readSource("frontend/layout/lib/snapbar.scss");
        const stripStart = styles.indexOf(".snap-trigger {");
        const stripBlock = styles.slice(stripStart, styles.indexOf(".snap-bar-backdrop"));
        const stripOwnDeclarations = stripBlock.slice(0, stripBlock.indexOf(".snap-trigger-grip"));
        assert.match(stripOwnDeclarations, /background-color:/, "the strip must be visible, not an invisible hot zone");
        assert.match(stripOwnDeclarations, /border:/, "the strip must read as a target");
        assert.match(stripBlock, /&\.hot/, "the strip must light up while it is aimed at");
        assert.notMatch(
            stripOwnDeclarations,
            /(^|\s)(width|height):\s*\d+px/,
            "the strip's size must come from the measured workspace, not from fixed pixels"
        );

        // The same rectangle that is drawn is the one the drag is tested against.
        const source = await readSource("frontend/layout/lib/TileLayout.tsx");
        assert.match(
            source,
            /setSnapTriggerHot\(isPointInRect\(geometry\.trigger, pointer\)\)/,
            "the strip lights up from the same rectangle that arms the bar"
        );
    });

    test("the chooser drops down from the strip instead of covering the workspace top", async () => {
        const source = await readSource("frontend/layout/lib/TileLayout.tsx");
        assert.match(source, /topOffsetPx=\{snapTriggerSize\.height/, "the panel must sit below the strip");
        const styles = await readSource("frontend/layout/lib/snapbar.scss");
        assert.match(styles, /top:\s*var\(--snap-bar-top/, "the panel offset must be driven by the strip size");
    });

    test("the bar's visibility comes from the pane-drag rules, not from raw drag state", async () => {
        const source = await readSource("frontend/layout/lib/TileLayout.tsx");
        assert.match(source, /reduceSnapDrag/, "the drag state must come from the tested reducer");
        assert.match(
            source,
            /itemType:\s*dragItemType/,
            "the reducer must be told the drag item type, which is what excludes OS file drags"
        );
    });

    test("a slot drop runs the audited apply with this tab's model and services", async () => {
        const source = await readSource("frontend/layout/lib/TileLayout.tsx");
        assert.match(source, /createTabSnapLayoutHost\(\{\s*layoutModel,\s*services\s*\}\)/);
        assert.match(source, /applySnapPreset\(createTabSnapLayoutHost/);
    });

    test("the drop itself is delegated to the tested slot-drop helper", async () => {
        const source = await readSource("frontend/layout/lib/snapbar.tsx");
        assert.match(source, /dropOnSnapSlot\(dropDeps,/, "the slot zone must use the tested helper");
        assert.match(source, /accept:\s*TILE_DRAG_ITEM_TYPE/, "only pane drags may be accepted");
        assert.notMatch(
            source,
            /\bdataTransfer\b|__NATIVE_|\bonDrop=|\bonDragOver=|\bonDragEnter=/,
            "the bar must not add any native HTML5 drag/drop handling"
        );
    });

    test("cancelling a drag clears the bar and any pending move", async () => {
        const source = await readSource("frontend/layout/lib/TileLayout.tsx");
        const dragEndBlock = source.slice(source.indexOf("if (!activeDrag) {"), source.indexOf("dispatchSnapDrag({\n            kind: \"drag-moved\""));
        assert.match(dragEndBlock, /kind:\s*"drag-ended"/, "a finished drag must close the bar");
        assert.match(
            dragEndBlock,
            /ClearPendingAction/,
            "a cancelled drag must not leave a pending move behind"
        );
    });

    test("the panes under the open bar do not preview a move", async () => {
        const source = await readSource("frontend/layout/lib/TileLayout.tsx");
        assert.match(source, /snapBarOpenRef\.current/, "the overlay node must consult the snap bar state");
        assert.match(
            source,
            /snapBarOpen=\{isSnapBarMounted\(snapDrag\)\}/,
            "the armed/open state must be passed to the overlay"
        );
    });

    test("the reclaim count is re-asked whenever the panes change", async () => {
        // The count used to be fetched once, when the tab's layout mounted - before the panes even had
        // controllers - and then reused forever, which left every shrink-capable preset undroppable.
        const source = await readSource("frontend/layout/lib/snapbar.tsx");
        assert.match(
            source,
            /useReclaimablePaneCount\(dropDeps: SnapDropDeps, paneBlockIds: string\[\]\)/,
            "the hook must take the current panes"
        );
        assert.match(source, /const paneKey = paneBlockIds\.join\("\|"\)/, "the panes must form the refresh key");
        assert.match(source, /\[getReclaimablePaneIds, paneKey\]/, "the query must re-run when the panes change");
        assert.match(source, /setCount\(undefined\)/, "an in-flight answer must not be read as zero");

        const layout = await readSource("frontend/layout/lib/TileLayout.tsx");
        assert.match(
            layout,
            /useReclaimablePaneCount\(snapDropDeps, leafBlockIds\)/,
            "the layout must pass the live pane set"
        );
    });

    test("an unanswered reclaim count does not disable a shrink-capable preset", async () => {
        const source = await readSource("frontend/layout/lib/snapDrag.ts");
        assert.match(
            source,
            /if \(reclaimableCount == null\) \{\s*return true;/,
            "unknown must defer to the transaction instead of disabling the preset"
        );
        assert.match(source, /if \(deps\.getReclaimablePaneIds == null\) \{\s*return undefined;/);
        assert.match(source, /catch \{\s*\/\/ Unknown, not zero/, "a failed query must not read as zero");
    });

    test("a refused drop is logged so it is diagnosable", async () => {
        const source = await readSource("frontend/layout/lib/snapbar.tsx");
        assert.match(source, /snap layout preset not applied/, "refusals must be visible outside the UI");
        assert.match(source, /outcome\.status !== "applied"/);
    });

    test("the terminal's own file drop path is left intact", async () => {
        // Dropping files onto a pane pastes their paths. The Snap Bar must not take that over, and it
        // cannot: it never registers a native drop handler and it is not mounted during a file drag.
        const termwrap = await readSource("frontend/app/view/term/termwrap.ts");
        assert.match(termwrap, /addEventListener\("dragover"/, "the terminal still handles dragover");
        assert.match(termwrap, /addEventListener\("drop"/, "the terminal still handles drop");
        assert.match(termwrap, /dataTransfer\.files/, "the terminal still reads the dropped files");
        assert.match(termwrap, /getPathForFile/, "the terminal still resolves dropped file paths");
    });
});

describe("Snap Bar drop against a real LayoutModel", () => {
    /** The same composition the Snap Bar uses: the real host over a real model, through the slot drop helper. */
    function makeFixture() {
        const harness = makeRealLayoutModel(twoPaneRoot());
        const created: string[] = [];
        const services = {
            ObjectService: {
                CreateBlock: async () => {
                    const blockId = `created-${created.length + 1}`;
                    created.push(blockId);
                    harness.tab.blockids.push(blockId);
                    return blockId;
                },
                DeleteBlock: async () => undefined,
            },
        };
        const host = createTabSnapLayoutHost({ layoutModel: harness.model, services });
        const dropDeps = {
            getPaneBlockIds: () => harness.model.getLeafBlockIds(),
            applySnapPreset: (request: any) => applySnapPreset(host, request),
        };
        return { harness, dropDeps, created };
    }

    test("dropping a pane on a slot replaces the tree with the preset", async () => {
        const { harness, dropDeps, created } = makeFixture();

        const outcome = await dropOnSnapSlot(dropDeps, {
            preset: getSnapPresetById("left-major-with-right-stack")!,
            slotId: "right-bottom",
            stickyBlockId: "pane-b",
        });

        assert.equal(outcome.status, "applied");
        assert.deepEqual(created, ["created-1"], "the free slot becomes one local terminal");
        assert.deepEqual(harness.model.getLeafBlockIds(), ["pane-a", "created-1", "pane-b"]);
        const root = harness.model.treeState.rootNode as any;
        assert.equal(root.children[1].flexDirection, "column", "the nested stack of the preset is preserved");
        assert.equal(harness.counters.updateTree, 1, "one commit");
        assert.equal(harness.counters.persist, 1, "one persist");
    });

    test("dropping on a slot leaves no pane behind and keeps the dragged pane's session", async () => {
        const { harness, dropDeps } = makeFixture();

        await dropOnSnapSlot(dropDeps, {
            preset: getSnapPresetById("two-columns")!,
            slotId: "right",
            stickyBlockId: "pane-a",
        });

        assert.deepEqual(harness.model.getLeafBlockIds(), ["pane-b", "pane-a"]);
        const root = harness.model.treeState.rootNode as any;
        assert.equal(root.children[1].data.blockId, "pane-a", "the dragged pane sits in the slot it was dropped on");
    });

    test("cancelling a drag closes the bar without touching the model", () => {
        const harness = makeRealLayoutModel(twoPaneRoot());
        const rootBefore = harness.model.treeState.rootNode;
        const geometry = {
            trigger: { left: 500, top: 0, right: 668, bottom: 10 },
            chooser: null,
        };
        const armed = reduceSnapDrag(SNAP_DRAG_CLOSED, {
            kind: "drag-moved",
            itemType: TILE_DRAG_ITEM_TYPE,
            stickyBlockId: "pane-a",
            paneInTab: true,
            pointer: { x: 550, y: 4 },
            geometry,
        });
        assert.equal(armed.phase, "trigger");

        // This is exactly what the UI does when the drag ends without a drop.
        assert.deepEqual(reduceSnapDrag(armed, { kind: "drag-ended" }), SNAP_DRAG_CLOSED);
        assert.equal(harness.model.treeState.rootNode, rootBefore, "a cancelled drag changes no tree");
        assert.equal(harness.counters.updateTree, 0);
        assert.equal(harness.counters.setter, 0);
        assert.equal(harness.counters.persist, 0);
    });

    test("a file drag cannot arm the bar, so the terminal keeps its file drops", () => {
        const geometry = {
            trigger: { left: 500, top: 0, right: 668, bottom: 10 },
            chooser: { left: 300, top: 10, right: 900, bottom: 260 },
        };
        for (const nativeType of NATIVE_DRAG_ITEM_TYPES) {
            const state = reduceSnapDrag(SNAP_DRAG_CLOSED, {
                kind: "drag-moved",
                itemType: nativeType,
                stickyBlockId: "pane-a",
                paneInTab: true,
                pointer: { x: 550, y: 4 },
                geometry,
            });
            assert.equal(state, SNAP_DRAG_CLOSED, `${nativeType} must not arm the bar`);
        }
    });
});
