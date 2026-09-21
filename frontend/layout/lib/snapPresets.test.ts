// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    SNAP_PRESETS,
    SnapTemplate,
    canApplyPreset,
    collectSlots,
    countSlots,
    getDefaultWorkspacePreset,
    getSnapPresetById,
    planSnapAssignment,
    templateWeight,
    toPreviewTree,
} from "@/layout/lib/snapPresets";
import { assert, describe, test } from "vitest";

/** The preset ids frozen for this slice, in Snap Bar order. */
const FROZEN_PRESET_IDS = [
    "two-columns",
    "two-columns-asymmetric",
    "two-columns-asymmetric-reverse",
    "two-rows",
    "three-columns",
    "four-grid",
    "left-major-with-right-stack",
    "right-major-with-left-stack",
];

function walkGroups(node: SnapTemplate): { direction: string; children: SnapTemplate[] }[] {
    if (node.kind === "slot") {
        return [];
    }
    return [{ direction: node.direction, children: node.children }, ...node.children.flatMap(walkGroups)];
}

describe("snap preset template contract", () => {
    test("offers exactly the frozen preset set in stable order", () => {
        assert.deepEqual(
            SNAP_PRESETS.map((preset) => preset.id),
            FROZEN_PRESET_IDS,
            "preset ids and their order are frozen for this slice"
        );
    });

    test("preset ids and slot ids are unique", () => {
        const ids = SNAP_PRESETS.map((preset) => preset.id);
        assert.equal(new Set(ids).size, ids.length);
        for (const preset of SNAP_PRESETS) {
            const slotIds = collectSlots(preset.root).map((slot) => slot.slotId);
            assert.equal(new Set(slotIds).size, slotIds.length, `preset ${preset.id} repeats a slotId`);
        }
    });

    test("every group divides into at least two children and sibling weights total 100", () => {
        for (const preset of SNAP_PRESETS) {
            for (const group of walkGroups(preset.root)) {
                assert.isAtLeast(group.children.length, 2, `preset ${preset.id} group must divide`);
                const total = group.children.reduce(
                    (sum, child) => sum + templateWeight(child, group.children.length),
                    0
                );
                assert.equal(total, 100, `preset ${preset.id} ${group.direction} weights must total 100`);
            }
        }
    });

    test("slot weights are positive and presets stay within four slots", () => {
        for (const preset of SNAP_PRESETS) {
            assert.isAtMost(countSlots(preset), 4, `preset ${preset.id} exceeds the four-slot limit`);
            for (const slot of collectSlots(preset.root)) {
                assert.isAbove(slot.weight, 0, `preset ${preset.id} slot ${slot.slotId} weight`);
                assert.isAtMost(slot.weight, 100);
            }
        }
    });

    test("presets describe nested row/column trees, not rectangles", () => {
        const leftMajor = getSnapPresetById("left-major-with-right-stack")!;
        assert.equal(leftMajor.root.direction, "row");
        const nested = leftMajor.root.children[1];
        assert.equal(nested.kind, "group", "the right side must be a nested group, not a flat cell");
        if (nested.kind === "group") {
            assert.equal(nested.direction, "column");
            assert.lengthOf(nested.children, 2);
        }
        assert.equal(countSlots(leftMajor), 3, "one pane beside a stack is three slots in total");
    });

    test("weights actually encode asymmetric splits", () => {
        const asymmetric = getSnapPresetById("two-columns-asymmetric")!;
        assert.deepEqual(
            collectSlots(asymmetric.root).map((slot) => [slot.slotId, slot.weight]),
            [
                ["left", 33],
                ["right", 67],
            ],
            "1/3-2/3 must live in the weights rather than being left uniform"
        );
        const reverse = getSnapPresetById("two-columns-asymmetric-reverse")!;
        assert.deepEqual(
            collectSlots(reverse.root).map((slot) => slot.weight),
            [67, 33]
        );
    });

    test("exactly one preset is the new-workspace default and it is 50/50 two panes", () => {
        const defaults = SNAP_PRESETS.filter((preset) => preset.defaultWorkspace);
        assert.equal(defaults.length, 1);
        const preset = getDefaultWorkspacePreset();
        assert.equal(preset.id, "two-columns");
        assert.equal(countSlots(preset), 2, "a new workspace starts with exactly two panes");
        assert.deepEqual(
            collectSlots(preset.root).map((slot) => slot.weight),
            [50, 50],
            "the default workspace split is 50/50"
        );
        assert.equal(getSnapPresetById("does-not-exist"), undefined);
    });
});

describe("snap preset preview", () => {
    test("mirrors the template shape and reuses template weights", () => {
        for (const preset of SNAP_PRESETS) {
            const preview = toPreviewTree(preset);
            assert.equal(preview.kind, "group");
            assert.equal(preview.direction, preset.root.direction, `preset ${preset.id} preview direction`);
            assert.lengthOf(preview.children!, preset.root.children.length);
            preview.children!.forEach((child, index) => {
                const source = preset.root.children[index];
                if (source.kind === "slot") {
                    assert.equal(child.kind, "slot");
                    assert.equal(child.slotId, source.slotId);
                    assert.equal(child.weight, source.weight, "preview must not restate a different weight");
                } else {
                    assert.equal(child.kind, "group");
                    assert.equal(child.direction, source.direction);
                }
            });
        }
    });

    test("a nested stack stays nested in the preview", () => {
        const preview = toPreviewTree(getSnapPresetById("left-major-with-right-stack")!);
        const stack = preview.children![1];
        assert.equal(stack.kind, "group");
        assert.equal(stack.direction, "column");
        assert.lengthOf(stack.children!, 2);
    });
});

describe("planSnapAssignment", () => {
    const fourGrid = getSnapPresetById("four-grid")!;

    test("keeps the dragged pane on the slot it was dropped on", () => {
        const plan = planSnapAssignment(fourGrid, { stickySlotId: "bottom-left", paneCount: 4 });
        assert.deepEqual(
            plan!.placements.map((placement) => placement.slotId),
            ["bottom-left", "top-left", "top-right", "bottom-right"]
        );
    });

    test("lists every remaining slot in the preset's stable order", () => {
        // The plan orders all slots rather than a prefix, because the committed tree has to cover
        // the whole preset; the caller decides how many of them need new panes.
        const plan = planSnapAssignment(fourGrid, { stickySlotId: "top-left", paneCount: 3 });
        assert.deepEqual(
            plan!.placements.map((placement) => placement.slotId),
            ["top-left", "top-right", "bottom-left", "bottom-right"]
        );
    });

    test("keeps the dragged pane first even when it is the only pane", () => {
        const plan = planSnapAssignment(fourGrid, { stickySlotId: "top-right", paneCount: 1 });
        const slotIds = plan!.placements.map((placement) => placement.slotId);
        assert.equal(slotIds[0], "top-right", "the dragged pane keeps the slot it was dropped on");
        assert.equal(new Set(slotIds).size, slotIds.length, "every slot is offered exactly once");
        assert.lengthOf(slotIds, 4);
    });

    test("carries each slot's weight so an asymmetric preset applies asymmetrically", () => {
        const asymmetric = getSnapPresetById("two-columns-asymmetric")!;
        const plan = planSnapAssignment(asymmetric, { stickySlotId: "right", paneCount: 2 });
        assert.deepEqual(plan!.placements, [
            { slotId: "right", weight: 67 },
            { slotId: "left", weight: 33 },
        ]);
    });

    test("returns null instead of deleting panes when there are too many", () => {
        assert.isNull(planSnapAssignment(fourGrid, { stickySlotId: "top-left", paneCount: 5 }));
        assert.isNull(
            planSnapAssignment(getSnapPresetById("two-columns")!, { stickySlotId: "left", paneCount: 3 })
        );
    });

    test("rejects an unknown target slot and an empty pane count", () => {
        assert.isNull(planSnapAssignment(fourGrid, { stickySlotId: "nope", paneCount: 1 }));
        assert.isNull(planSnapAssignment(fourGrid, { stickySlotId: "top-left", paneCount: 0 }));
    });

    test("every plan places exactly paneCount panes on distinct slots", () => {
        for (const preset of SNAP_PRESETS) {
            const slots = collectSlots(preset.root);
            for (let paneCount = 1; paneCount <= slots.length; paneCount++) {
                const plan = planSnapAssignment(preset, { stickySlotId: slots[0].slotId, paneCount });
                assert.isNotNull(plan, `${preset.id} panes=${paneCount} should be plannable`);
                assert.lengthOf(plan!.placements, slots.length, "the plan covers every slot");
                const used = plan!.placements.map((placement) => placement.slotId);
                assert.equal(new Set(used).size, slots.length, "a slot must not be offered twice");
                assert.equal(used[0], slots[0].slotId, "dragged pane must keep its slot");
                assert.deepEqual(
                    [...used].sort(),
                    slots.map((slot) => slot.slotId).sort(),
                    "every preset slot must be offered"
                );
                for (const placement of plan!.placements) {
                    const source = slots.find((slot) => slot.slotId === placement.slotId)!;
                    assert.equal(placement.weight, source.weight);
                }
            }
        }
    });
});

describe("canApplyPreset", () => {
    test("allows a pane count up to the slot count", () => {
        const preset = getSnapPresetById("four-grid")!;
        assert.isTrue(canApplyPreset(preset, 1));
        assert.isTrue(canApplyPreset(preset, 4));
    });

    test("disables presets that cannot hold the existing panes", () => {
        assert.isFalse(canApplyPreset(getSnapPresetById("two-columns")!, 3));
        assert.isFalse(canApplyPreset(getSnapPresetById("left-major-with-right-stack")!, 4));
    });
});



