// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Snap Bar drag behaviour.
 *
 * These cover the rules the UI cannot be trusted to enforce on its own: an OS file drag must never arm
 * the bar, the chooser must survive a pointer that moves down to a second row, cancelling must be a
 * no-op, and a slot drop must run exactly the audited atomic apply once - and never for a preset that
 * cannot be applied safely.
 */

import { SnapApplyRequest } from "@/app/workspace/snapApply";
import {
    NATIVE_DRAG_ITEM_TYPES,
    SNAP_DRAG_CLOSED,
    SNAP_REGION_GRACE_PX,
    SNAP_TRIGGER_MAX_HEIGHT_PX,
    SNAP_TRIGGER_MAX_WIDTH_PX,
    SNAP_TRIGGER_MIN_HEIGHT_PX,
    SNAP_TRIGGER_MIN_WIDTH_PX,
    SnapDragGeometry,
    SnapDragUiState,
    TILE_DRAG_ITEM_TYPE,
    dropOnSnapSlot,
    isPaneDrag,
    isPointInRect,
    isPointInSnapRegion,
    isPresetApplicable,
    isSnapBarMounted,
    paneBlockIdOfDragItem,
    reduceSnapDrag,
    triggerSizeFor,
} from "@/layout/lib/snapDrag";
import { SNAP_PRESETS, countSlots, getSnapPresetById } from "@/layout/lib/snapPresets";
import { assert, describe, test, vi } from "vitest";

/** A 1200x800 workspace with the strip at the top centre and the chooser hanging under it. */
const TRIGGER = { left: 516, top: 6, right: 516 + 168, bottom: 6 + 10 };
/** Two rows of presets, dropping down from the strip: the second row is far below it. */
const CHOOSER = { left: 300, top: TRIGGER.bottom + 6, right: 900, bottom: 260 };
const GEOMETRY: SnapDragGeometry = { trigger: TRIGGER, chooser: CHOOSER };
/** A point in the middle of the visible strip. */
const IN_TRIGGER = { x: 600, y: TRIGGER.top + 4 };
/** A point in the chooser's second row - far below the strip, which is what used to close the bar. */
const SECOND_ROW = { x: 600, y: 220 };
/** A point in the layout, well outside both regions. */
const OUTSIDE = { x: 600, y: 600 };

function moved(
    state: SnapDragUiState,
    pointer: { x: number; y: number } | null,
    options: {
        itemType?: unknown;
        stickyBlockId?: string;
        paneInTab?: boolean;
        geometry?: SnapDragGeometry;
    } = {}
): SnapDragUiState {
    return reduceSnapDrag(state, {
        kind: "drag-moved",
        itemType: options.itemType ?? TILE_DRAG_ITEM_TYPE,
        stickyBlockId: "stickyBlockId" in options ? options.stickyBlockId : "pane-a",
        paneInTab: options.paneInTab ?? true,
        pointer,
        geometry: options.geometry ?? GEOMETRY,
    });
}

/** closed -> trigger -> chooser: the whole arming sequence. */
function armed(): SnapDragUiState {
    const trigger = moved(SNAP_DRAG_CLOSED, IN_TRIGGER);
    return moved(trigger, IN_TRIGGER);
}

describe("snap drag: arming the trigger", () => {
    test("a pane dragged into the trigger arms the bar", () => {
        assert.deepEqual(moved(SNAP_DRAG_CLOSED, IN_TRIGGER), { phase: "trigger", stickyBlockId: "pane-a" });
    });

    test("a pane dragged anywhere else does not arm it", () => {
        assert.equal(moved(SNAP_DRAG_CLOSED, OUTSIDE), SNAP_DRAG_CLOSED);
        assert.equal(moved(SNAP_DRAG_CLOSED, SECOND_ROW), SNAP_DRAG_CLOSED);
    });

    test("the trigger is the real element: no trigger means no arming", () => {
        const noTrigger: SnapDragGeometry = { trigger: null, chooser: CHOOSER };
        assert.equal(moved(SNAP_DRAG_CLOSED, IN_TRIGGER, { geometry: noTrigger }), SNAP_DRAG_CLOSED);
    });

    test("the trigger region is a strip, not a band across the top", () => {
        assert.isBelow(SNAP_TRIGGER_MAX_WIDTH_PX, 400, "the strip must be a target, not the whole top edge");
        assert.isAtMost(SNAP_TRIGGER_MAX_HEIGHT_PX, 24);
        // Just outside the strip horizontally: not armed.
        assert.equal(moved(SNAP_DRAG_CLOSED, { x: TRIGGER.left - 40, y: IN_TRIGGER.y }), SNAP_DRAG_CLOSED);
        assert.equal(moved(SNAP_DRAG_CLOSED, { x: TRIGGER.right + 40, y: IN_TRIGGER.y }), SNAP_DRAG_CLOSED);
    });

    test("a drag that never touches the strip changes nothing", () => {
        // Everywhere else in the workspace - including the top corners and the pane edges - the drag
        // behaves exactly as it always did.
        for (const point of [
            { x: 20, y: 10 },
            { x: 1180, y: 10 },
            { x: 20, y: 400 },
            { x: 600, y: 40 },
            { x: 600, y: 790 },
        ]) {
            assert.equal(moved(SNAP_DRAG_CLOSED, point), SNAP_DRAG_CLOSED, `point ${JSON.stringify(point)}`);
        }
    });

    for (const nativeType of NATIVE_DRAG_ITEM_TYPES) {
        test(`a native ${nativeType} drag never arms the bar`, () => {
            assert.isFalse(isPaneDrag(nativeType));
            assert.equal(moved(SNAP_DRAG_CLOSED, IN_TRIGGER, { itemType: nativeType }), SNAP_DRAG_CLOSED);
        });
    }

    test("an unknown item type never arms the bar", () => {
        assert.equal(moved(SNAP_DRAG_CLOSED, IN_TRIGGER, { itemType: "SOMETHING_ELSE" }), SNAP_DRAG_CLOSED);
        // Built inline: the helper's default would hide the missing-type case.
        const missingType = reduceSnapDrag(SNAP_DRAG_CLOSED, {
            kind: "drag-moved",
            itemType: undefined,
            stickyBlockId: "pane-a",
            paneInTab: true,
            pointer: IN_TRIGGER,
            geometry: GEOMETRY,
        });
        assert.equal(missingType, SNAP_DRAG_CLOSED);
    });

    test("a drag item without a block id never arms the bar", () => {
        assert.equal(moved(SNAP_DRAG_CLOSED, IN_TRIGGER, { stickyBlockId: undefined }), SNAP_DRAG_CLOSED);
    });

    test("a pane that does not belong to this tab never arms the bar", () => {
        assert.equal(moved(SNAP_DRAG_CLOSED, IN_TRIGGER, { paneInTab: false }), SNAP_DRAG_CLOSED);
        // ... and it closes an already armed bar.
        assert.equal(moved(armed(), IN_TRIGGER, { paneInTab: false }), SNAP_DRAG_CLOSED);
    });

    test("a move without a pointer position leaves the state untouched", () => {
        const state = moved(SNAP_DRAG_CLOSED, IN_TRIGGER);
        assert.equal(moved(state, null), state);
    });
});

describe("snap drag: the strip follows the workspace", () => {
    test("the strip grows with the workspace and stays a strip", () => {
        const small = triggerSizeFor({ width: 900, height: 600 });
        const medium = triggerSizeFor({ width: 1280, height: 800 });
        const large = triggerSizeFor({ width: 2560, height: 1440 });

        assert.isBelow(small.width, medium.width, "a wider workspace gets a wider strip");
        assert.isBelow(medium.width, large.width);
        assert.isAtLeast(small.height, SNAP_TRIGGER_MIN_HEIGHT_PX);
        assert.isAtMost(large.height, SNAP_TRIGGER_MAX_HEIGHT_PX);
        for (const size of [small, medium, large]) {
            assert.isAtLeast(size.width, SNAP_TRIGGER_MIN_WIDTH_PX);
            assert.isAtMost(size.width, SNAP_TRIGGER_MAX_WIDTH_PX, "the strip must never become a full-width bar");
        }
    });

    test("a workspace smaller than the minimum still gets a usable strip", () => {
        const tiny = triggerSizeFor({ width: 400, height: 300 });
        assert.deepEqual(tiny, { width: SNAP_TRIGGER_MIN_WIDTH_PX, height: SNAP_TRIGGER_MIN_HEIGHT_PX });
    });

    test("an unmeasured workspace falls back to the minimum instead of nothing", () => {
        assert.deepEqual(triggerSizeFor(null), { width: SNAP_TRIGGER_MIN_WIDTH_PX, height: SNAP_TRIGGER_MIN_HEIGHT_PX });
        assert.deepEqual(triggerSizeFor({ width: 0, height: 0 }), {
            width: SNAP_TRIGGER_MIN_WIDTH_PX,
            height: SNAP_TRIGGER_MIN_HEIGHT_PX,
        });
    });

    test("the rendered rectangle is what the drag is tested against", () => {
        // Same numbers the UI puts on the element: aiming at the visible strip is what arms the bar,
        // and a pointer just outside it does nothing.
        const size = triggerSizeFor({ width: 1280, height: 800 });
        const strip = {
            left: 640 - size.width / 2,
            top: 6,
            right: 640 + size.width / 2,
            bottom: 6 + size.height,
        };
        assert.isTrue(isPointInRect(strip, { x: 640, y: strip.top + 1 }), "dead centre on the strip");
        assert.isTrue(isPointInRect(strip, { x: strip.left + 1, y: strip.top + 1 }), "inside its left end");
        assert.isFalse(isPointInRect(strip, { x: strip.left - 8, y: strip.top + 1 }), "just left of it");
        assert.isFalse(isPointInRect(strip, { x: 640, y: strip.bottom + 8 }), "just below it");
    });

    for (const panes of [1, 2, 3, 4]) {
        test(`a ${panes}-pane workspace arms the strip straight from any pane`, () => {
            // The strip sits at the top centre of the workspace, so a drag from any pane reaches it by
            // moving up - no detour downwards first, and no dependence on the pane under the pointer.
            const size = triggerSizeFor({ width: 1280, height: 800 });
            const geometry: SnapDragGeometry = {
                trigger: { left: 640 - size.width / 2, top: 6, right: 640 + size.width / 2, bottom: 6 + size.height },
                chooser: { left: 300, top: 6 + size.height + 6, right: 980, bottom: 280 },
            };
            for (const paneIndex of Array.from({ length: panes }, (_, index) => index)) {
                const stickyBlockId = `pane-${paneIndex + 1}`;
                const armedState = moved(SNAP_DRAG_CLOSED, { x: 640, y: 8 }, { geometry, stickyBlockId });
                assert.equal(armedState.phase, "trigger", `pane ${stickyBlockId} must arm the strip`);
                const openState = moved(armedState, { x: 640, y: 8 }, { geometry, stickyBlockId });
                assert.equal(openState.phase, "chooser", `pane ${stickyBlockId} must open the chooser`);
                assert.equal(openState.stickyBlockId, stickyBlockId);
            }
        });
    }
});

describe("snap drag: the chooser stays open", () => {
    test("the chooser is not mounted until the trigger is reached", () => {
        assert.isFalse(isSnapBarMounted(SNAP_DRAG_CLOSED));
        const trigger = moved(SNAP_DRAG_CLOSED, IN_TRIGGER);
        assert.isTrue(isSnapBarMounted(trigger), "the trigger mounts the chooser");
    });

    test("the trigger state advances to chooser once the panel has been measured", () => {
        const trigger = moved(SNAP_DRAG_CLOSED, IN_TRIGGER);
        assert.equal(trigger.phase, "trigger");
        const chooser = moved(trigger, IN_TRIGGER);
        assert.equal(chooser.phase, "chooser");
    });

    test("moving down to the second row of presets keeps the chooser open", () => {
        const chooser = armed();
        assert.equal(chooser.phase, "chooser");
        // Second row, far below the trigger: the old fixed 96px band would have closed the bar here.
        const stillOpen = moved(chooser, SECOND_ROW);
        assert.equal(stillOpen.phase, "chooser", "the second row must stay reachable");
        assert.equal(stillOpen.stickyBlockId, "pane-a");
    });

    test("the second row is below the trigger, so only the chooser can keep it open", () => {
        assert.isAbove(SECOND_ROW.y, TRIGGER.bottom + SNAP_REGION_GRACE_PX, "the test point must leave the trigger");
        assert.isTrue(isPointInSnapRegion(GEOMETRY, SECOND_ROW));
    });

    test("crossing the gap between the trigger and the chooser does not close the bar", () => {
        const chooser = armed();
        const between = { x: 600, y: (TRIGGER.bottom + CHOOSER.top) / 2 };
        assert.equal(moved(chooser, between).phase, "chooser");
    });

    test("moving sideways inside the second row stays open, and leaving it closes", () => {
        const chooser = armed();
        assert.equal(moved(chooser, { x: CHOOSER.left + 20, y: SECOND_ROW.y }).phase, "chooser");
        assert.equal(
            moved(chooser, { x: CHOOSER.right + SNAP_REGION_GRACE_PX - 2, y: SECOND_ROW.y }).phase,
            "chooser",
            "inside the grace"
        );
        assert.equal(moved(chooser, { x: CHOOSER.right + SNAP_REGION_GRACE_PX + 50, y: SECOND_ROW.y }).phase, "closed");
    });

    test("leaving the region closes the chooser", () => {
        assert.deepEqual(moved(armed(), OUTSIDE), SNAP_DRAG_CLOSED);
    });

    test("a closed bar ignores moves that are not in the trigger", () => {
        const closed = moved(SNAP_DRAG_CLOSED, OUTSIDE);
        assert.equal(closed, SNAP_DRAG_CLOSED);
    });

    test("repeated moves inside the region do not churn the state object", () => {
        const chooser = armed();
        assert.equal(moved(chooser, { x: 700, y: 200 }), chooser, "same object so React skips the render");
    });

    test("a change of dragged pane updates the sticky pane", () => {
        const chooser = armed();
        const other = moved(chooser, SECOND_ROW, { stickyBlockId: "pane-b" });
        assert.equal(other.phase, "chooser");
        assert.equal(other.stickyBlockId, "pane-b");
    });

    test("a small window still keeps both rows reachable in one chooser box", () => {
        // 1000x600 workspace: the strip is narrower than the chooser, and the chooser is clamped inside.
        const smallStrip = triggerSizeFor({ width: 1000, height: 600 });
        const small: SnapDragGeometry = {
            trigger: { left: 500 - smallStrip.width / 2, top: 6, right: 500 + smallStrip.width / 2, bottom: 6 + smallStrip.height },
            chooser: { left: 4, top: 6 + smallStrip.height + 6, right: 996, bottom: 292 },
        };
        const stripPoint = { x: 500, y: 10 };
        const trigger = moved(SNAP_DRAG_CLOSED, stripPoint, { geometry: small });
        const chooser = moved(trigger, stripPoint, { geometry: small });
        assert.equal(chooser.phase, "chooser");
        assert.equal(moved(chooser, { x: 120, y: 250 }, { geometry: small }).phase, "chooser", "row two, left side");
        assert.equal(moved(chooser, { x: 880, y: 280 }, { geometry: small }).phase, "chooser", "row two, right side");
        assert.equal(moved(chooser, { x: 500, y: 400 }, { geometry: small }).phase, "closed", "below the chooser");
    });
});

describe("snap drag: cancelling", () => {
    test("ending a drag closes the bar and changes nothing else", () => {
        assert.deepEqual(reduceSnapDrag(armed(), { kind: "drag-ended" }), SNAP_DRAG_CLOSED);
    });

    test("ending an unarmed drag keeps the same state object", () => {
        assert.equal(reduceSnapDrag(SNAP_DRAG_CLOSED, { kind: "drag-ended" }), SNAP_DRAG_CLOSED);
    });

    test("a handled drop closes the bar", () => {
        assert.deepEqual(reduceSnapDrag(armed(), { kind: "slot-dropped" }), SNAP_DRAG_CLOSED);
    });
});

describe("snap drag: dropping on a slot", () => {
    function deps(paneBlockIds: string[], result: any = { status: "applied" }, reclaimable: string[] = []) {
        const applySnapPreset = vi.fn(async (_request: SnapApplyRequest) => result);
        const getPaneBlockIds = () => [...paneBlockIds];
        const getReclaimablePaneIds = vi.fn(async () => [...reclaimable]);
        return {
            applySnapPreset,
            getReclaimablePaneIds,
            deps: { applySnapPreset, getPaneBlockIds, getReclaimablePaneIds },
        };
    }

    test("runs the audited apply exactly once with the preset, slot and dragged pane", async () => {
        const { deps: dropDeps, applySnapPreset } = deps(["pane-a", "pane-b"]);
        const preset = getSnapPresetById("four-grid")!;
        const outcome = await dropOnSnapSlot(dropDeps, { preset, slotId: "bottom-right", stickyBlockId: "pane-a" });

        assert.equal(applySnapPreset.mock.calls.length, 1, "one apply per drop");
        assert.deepEqual(applySnapPreset.mock.calls[0][0], {
            preset,
            stickySlotId: "bottom-right",
            stickyBlockId: "pane-a",
        });
        assert.equal(outcome.status, "applied");
    });

    test("passes a rejection or failure back to the caller instead of retrying", async () => {
        const rejected = deps(["pane-a"], { status: "rejected", reason: "foreign-block" });
        const preset = getSnapPresetById("two-columns")!;
        assert.equal((await dropOnSnapSlot(rejected.deps, { preset, slotId: "left", stickyBlockId: "pane-a" })).status, "rejected");
        assert.equal(rejected.applySnapPreset.mock.calls.length, 1);

        const failed = deps(["pane-a"], { status: "failed", reason: "commit-failed" });
        assert.equal((await dropOnSnapSlot(failed.deps, { preset, slotId: "left", stickyBlockId: "pane-a" })).status, "failed");
    });

    test("a slot that is not part of the preset never reaches the apply", async () => {
        const { deps: dropDeps, applySnapPreset } = deps(["pane-a", "pane-b"]);
        const outcome = await dropOnSnapSlot(dropDeps, {
            preset: getSnapPresetById("two-columns")!,
            slotId: "top-left",
            stickyBlockId: "pane-a",
        });
        assert.deepEqual(outcome, { status: "skipped", reason: "unknown-slot" });
        assert.equal(applySnapPreset.mock.calls.length, 0);
    });

    test("a preset that cannot be applied never reaches the apply", async () => {
        const { deps: dropDeps, applySnapPreset } = deps(["p1", "p2", "p3", "p4", "p5"]);
        const outcome = await dropOnSnapSlot(dropDeps, {
            preset: getSnapPresetById("four-grid")!,
            slotId: "top-left",
            stickyBlockId: "p1",
        });
        assert.deepEqual(outcome, { status: "skipped", reason: "preset-disabled", paneCount: 5 });
        assert.equal(applySnapPreset.mock.calls.length, 0, "an inapplicable preset must never delete panes");
    });

    test("a shrink is only offered when the host reports reclaimable panes", async () => {
        const notReclaimable = deps(["p1", "p2", "p3"], { status: "applied" }, []);
        const outcome = await dropOnSnapSlot(notReclaimable.deps, {
            preset: getSnapPresetById("two-columns")!,
            slotId: "left",
            stickyBlockId: "p1",
        });
        assert.equal(outcome.status, "skipped");
        assert.equal(notReclaimable.applySnapPreset.mock.calls.length, 0);

        const reclaimable = deps(["p1", "p2", "p3"], { status: "applied" }, ["filler-1"]);
        const shrinkOutcome = await dropOnSnapSlot(reclaimable.deps, {
            preset: getSnapPresetById("two-columns")!,
            slotId: "left",
            stickyBlockId: "p1",
        });
        assert.equal(shrinkOutcome.status, "applied", "two slots for three panes with one reclaimable filler");
        assert.equal(reclaimable.applySnapPreset.mock.calls.length, 1);
    });

    test("an unreadable reclaim answer does not disable the preset: the transaction decides", async () => {
        // The count arrives asynchronously; treating "no answer" as "nothing may be reclaimed" left
        // safe presets undroppable on a real machine. Unknown now means "ask the transaction", which
        // refuses safely if the shrink turns out to be unsafe.
        const applySnapPreset = vi.fn(async (_request: SnapApplyRequest) => appliedResult());
        const outcome = await dropOnSnapSlot(
            {
                applySnapPreset,
                getPaneBlockIds: () => ["p1", "p2", "p3"],
                getReclaimablePaneIds: async () => {
                    throw new Error("runtime unavailable");
                },
            },
            { preset: getSnapPresetById("two-columns")!, slotId: "left", stickyBlockId: "p1" }
        );
        assert.equal(outcome.status, "applied");
        assert.equal(applySnapPreset.mock.calls.length, 1, "the transaction must get the chance to refuse");
    });

    test("a known shortage of reclaimable panes still disables the preset", async () => {
        const applySnapPreset = vi.fn(async (_request: SnapApplyRequest) => appliedResult());
        const outcome = await dropOnSnapSlot(
            {
                applySnapPreset,
                getPaneBlockIds: () => ["p1", "p2", "p3"],
                getReclaimablePaneIds: async () => [],
            },
            { preset: getSnapPresetById("two-columns")!, slotId: "left", stickyBlockId: "p1" }
        );
        assert.deepEqual(outcome, { status: "skipped", reason: "preset-disabled", paneCount: 3 });
        assert.equal(applySnapPreset.mock.calls.length, 0, "a known-unsafe shrink is not attempted");
    });
});

/** A complete successful result, so the mocks satisfy the audited result type. */
function appliedResult() {
    return {
        status: "applied" as const,
        presetId: "two-columns",
        createdBlockIds: [] as string[],
        reclaimedBlockIds: [] as string[],
        paneCount: 2,
    };
}

describe("snap drag: preset applicability", () => {
    test("every preset accepts a pane count up to its slot count and rejects more when nothing may be reclaimed", () => {
        for (const preset of SNAP_PRESETS) {
            const slots = countSlots(preset);
            assert.isTrue(isPresetApplicable(preset, 1, 0), `${preset.id} must accept a single pane`);
            assert.isTrue(isPresetApplicable(preset, slots, 0), `${preset.id} must accept its own slot count`);
            assert.isFalse(
                isPresetApplicable(preset, slots + 1, 0),
                `${preset.id} must reject more panes than slots when no pane may be reclaimed`
            );
        }
    });

    test("an unanswered reclaim count does not disable a preset", () => {
        const twoColumns = getSnapPresetById("two-columns")!;
        // Unknown (undefined) means "ask the transaction", which refuses safely when the shrink is
        // not provable. Reporting unknown as zero is what made shrinking impossible on a real machine.
        assert.isTrue(isPresetApplicable(twoColumns, 4, undefined));
        assert.isTrue(isPresetApplicable(twoColumns, 4, 2));
        assert.isFalse(isPresetApplicable(twoColumns, 4, 1), "a known shortage still disables it");
        assert.isFalse(isPresetApplicable(twoColumns, 4, 0));
    });

    test("a shrink is applicable only when enough panes may be reclaimed", () => {
        const twoColumns = getSnapPresetById("two-columns")!;
        assert.isFalse(isPresetApplicable(twoColumns, 3, 0));
        assert.isTrue(isPresetApplicable(twoColumns, 3, 1), "one safe filler makes the shrink possible");
        assert.isTrue(isPresetApplicable(twoColumns, 4, 2));
        assert.isFalse(isPresetApplicable(twoColumns, 5, 1), "the shrink must close the whole gap");
    });
});

describe("paneBlockIdOfDragItem", () => {
    test("reads the block id from a dragged layout node", () => {
        assert.equal(paneBlockIdOfDragItem({ id: "n1", data: { blockId: "pane-a" } }), "pane-a");
    });

    test("returns undefined for anything that is not a layout node", () => {
        assert.isUndefined(paneBlockIdOfDragItem(undefined));
        assert.isUndefined(paneBlockIdOfDragItem(null));
        assert.isUndefined(paneBlockIdOfDragItem({}));
        assert.isUndefined(paneBlockIdOfDragItem({ data: {} }));
    });
});
