// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Snap Bar drag model.
 *
 * The pieces that decide *whether* the bar is shown and *what* a drop does are kept here, free of
 * React and react-dnd, so they can be tested directly.
 *
 * The bar follows the Windows 11 shape: a visible strip appears at the top centre of the workspace
 * while a pane is dragged, and touching that strip arms the bar and drops the chooser down from it.
 * Once the chooser is up it stays up while the pointer is anywhere in the region the strip and the
 * chooser actually occupy - measured from their real rectangles, not from a fixed band - so moving
 * down to a second row of presets no longer closes it.
 *
 * The other rules:
 *
 *   - a native file/URL drag never arms or opens the bar, so terminal file drops are untouched,
 *   - only a pane this tab owns can arm it,
 *   - a drag that never touches the strip behaves exactly as it always did,
 *   - releasing anywhere but a slot - including cancelling with Escape - is a no-op,
 *   - a slot drop runs the audited atomic `applySnapPreset`, and a preset that cannot be applied
 *     safely is not droppable at all.
 */

import { SnapApplyRequest, SnapApplyResult } from "@/app/workspace/snapApply";
import { SnapPreset, canApplyPreset, collectSlots } from "@/layout/lib/snapPresets";
import type { LayoutNode } from "@/layout/lib/types";

/**
 * The react-dnd item type used for layout pane drags.
 *
 * This is the *only* type the Snap Bar reacts to. react-dnd's HTML5 backend also reports drags that
 * start outside the app (a file from Explorer, a URL) with its own `__NATIVE_*` types, so comparing
 * against this constant is what keeps the Snap Bar out of the terminal's file drop path.
 */
export const TILE_DRAG_ITEM_TYPE = "TILE_ITEM";

/** react-dnd's item types for drags that originated outside the app. Listed for documentation/tests. */
export const NATIVE_DRAG_ITEM_TYPES = ["__NATIVE_FILE__", "__NATIVE_URL__", "__NATIVE_TEXT__"] as const;

/** True only for an in-app pane drag. */
export function isPaneDrag(itemType: unknown): boolean {
    return itemType === TILE_DRAG_ITEM_TYPE;
}

/**
 * The Snap activation overlay.
 *
 * Windows 11 shows a small strip at the top of the screen while a window is dragged; the strip is the
 * thing you aim at, and the layout chooser drops down from it. The same shape is used here, with two
 * properties that matter:
 *
 *   - the strip is *visible* and it *is* the hit region: the rectangle the drag is tested against is
 *     the rectangle that was rendered, so there is no separate invisible hot zone to find;
 *   - its size follows the workspace it sits in: a share of the container's width and height, clamped
 *     so it stays a strip - wide enough to aim at, never a bar across the top.
 */
export const SNAP_TRIGGER_MIN_WIDTH_PX = 120;
export const SNAP_TRIGGER_MAX_WIDTH_PX = 260;
export const SNAP_TRIGGER_WIDTH_RATIO = 0.16;
export const SNAP_TRIGGER_MIN_HEIGHT_PX = 8;
export const SNAP_TRIGGER_MAX_HEIGHT_PX = 16;
export const SNAP_TRIGGER_HEIGHT_RATIO = 0.012;

export interface SnapTriggerSize {
    width: number;
    height: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * The trigger strip's size for a workspace of this size.
 *
 * Guards against a workspace that has not been measured yet by falling back to the minimum strip.
 */
export function triggerSizeFor(container: { width: number; height: number } | null | undefined): SnapTriggerSize {
    if (container == null || container.width <= 0 || container.height <= 0) {
        return { width: SNAP_TRIGGER_MIN_WIDTH_PX, height: SNAP_TRIGGER_MIN_HEIGHT_PX };
    }
    return {
        width: clamp(Math.round(container.width * SNAP_TRIGGER_WIDTH_RATIO), SNAP_TRIGGER_MIN_WIDTH_PX, SNAP_TRIGGER_MAX_WIDTH_PX),
        height: clamp(
            Math.round(container.height * SNAP_TRIGGER_HEIGHT_RATIO),
            SNAP_TRIGGER_MIN_HEIGHT_PX,
            SNAP_TRIGGER_MAX_HEIGHT_PX
        ),
    };
}
/** How far outside the trigger/chooser region the pointer may stray before the bar closes. */
export const SNAP_REGION_GRACE_PX = 12;

export interface SnapRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/**
 * The regions the bar occupies right now, in client (viewport) coordinates.
 *
 * `trigger` is mounted for the whole duration of a pane drag; `chooser` only exists once the trigger
 * has armed it. Both are `null` when the corresponding element is not in the DOM.
 */
export interface SnapDragGeometry {
    trigger: SnapRect | null;
    chooser: SnapRect | null;
}

export type SnapDragPhase = "closed" | "trigger" | "chooser";

export interface SnapDragUiState {
    phase: SnapDragPhase;
    /** Block id of the pane being dragged; only meaningful when the bar is armed. */
    stickyBlockId?: string;
}

export const SNAP_DRAG_CLOSED: SnapDragUiState = { phase: "closed" };

/** The bar is armed once the trigger is reached; the chooser is mounted from then on. */
export function isSnapBarMounted(state: SnapDragUiState): boolean {
    return state.phase !== "closed";
}

export type SnapDragEvent =
    | {
          kind: "drag-moved";
          /** `monitor.getItemType()` from react-dnd. */
          itemType: unknown;
          /** Block id of the dragged pane, if the drag item is a layout node. */
          stickyBlockId?: string;
          /** Whether the dragged pane belongs to this tab; foreign panes cannot arm the bar. */
          paneInTab: boolean;
          /** Pointer position in client coordinates, or null when react-dnd has not reported one. */
          pointer?: { x: number; y: number } | null;
          /** Measured rectangles of the bar's own elements. */
          geometry: SnapDragGeometry;
      }
    | { kind: "drag-ended" }
    | { kind: "slot-dropped" };

export function isPointInRect(rect: SnapRect | null | undefined, point: { x: number; y: number }, gracePx = 0): boolean {
    if (rect == null || point == null) {
        return false;
    }
    return (
        point.x >= rect.left - gracePx &&
        point.x <= rect.right + gracePx &&
        point.y >= rect.top - gracePx &&
        point.y <= rect.bottom + gracePx
    );
}

/**
 * Whether the pointer is inside the region the bar occupies, including the space between the trigger
 * and the chooser.
 *
 * With both elements on screen this is the bounding box of the two, which is exactly the trigger, the
 * chooser, and the strip joining them - so the bar does not flicker shut while the pointer crosses
 * from one to the other, and it survives a move down to the second row of presets.
 */
export function isPointInSnapRegion(
    geometry: SnapDragGeometry,
    point: { x: number; y: number } | null | undefined,
    gracePx = SNAP_REGION_GRACE_PX
): boolean {
    if (point == null) {
        return false;
    }
    const { trigger, chooser } = geometry;
    if (trigger == null && chooser == null) {
        return false;
    }
    if (trigger != null && chooser != null) {
        return isPointInRect(
            {
                left: Math.min(trigger.left, chooser.left),
                top: Math.min(trigger.top, chooser.top),
                right: Math.max(trigger.right, chooser.right),
                bottom: Math.max(trigger.bottom, chooser.bottom),
            },
            point,
            gracePx
        );
    }
    return isPointInRect(trigger ?? chooser, point, gracePx);
}

/**
 * Applies one drag event to the bar's state.
 *
 * Returns the *same object* when nothing changed, so React can skip the re-render: this runs on every
 * pointer move during a drag.
 */
export function reduceSnapDrag(state: SnapDragUiState, event: SnapDragEvent): SnapDragUiState {
    if (event.kind !== "drag-moved") {
        // Drag over (dropped or cancelled): the bar closes and nothing else changes.
        return state.phase === "closed" ? state : SNAP_DRAG_CLOSED;
    }

    // Anything that is not an in-app pane drag this tab owns - most importantly a file dragged in
    // from the OS - never arms the bar.
    if (!isPaneDrag(event.itemType) || event.stickyBlockId == null || !event.paneInTab) {
        return state.phase === "closed" ? state : SNAP_DRAG_CLOSED;
    }
    const pointer = event.pointer;
    if (pointer == null) {
        return state;
    }

    if (state.phase === "closed") {
        if (isPointInRect(event.geometry.trigger, pointer)) {
            return { phase: "trigger", stickyBlockId: event.stickyBlockId };
        }
        return state;
    }

    // Armed or open: the bar closes only when the pointer genuinely leaves its region.
    if (!isPointInSnapRegion(event.geometry, pointer)) {
        return SNAP_DRAG_CLOSED;
    }
    if (state.phase === "trigger" && event.geometry.chooser != null) {
        // The chooser has been measured, so the pointer's position is now judged against it.
        return { phase: "chooser", stickyBlockId: event.stickyBlockId };
    }
    if (state.stickyBlockId !== event.stickyBlockId) {
        return { ...state, stickyBlockId: event.stickyBlockId };
    }
    return state;
}

/** Reads the block id out of a react-dnd drag item, when it is a layout node. */
export function paneBlockIdOfDragItem(item: unknown): string | undefined {
    const node = item as LayoutNode | undefined;
    return node?.data?.blockId;
}

export interface SnapDropRequest {
    preset: SnapPreset;
    /** Slot the pane was dropped on. */
    slotId: string;
    stickyBlockId: string;
}

export type SnapDropOutcome =
    | { status: "skipped"; reason: "preset-disabled"; paneCount: number }
    | { status: "skipped"; reason: "unknown-slot" }
    | { status: "applied" | "rejected" | "failed"; result: SnapApplyResult };

export interface SnapDropDeps {
    /** Pane block ids currently in this tab, used both for the capacity check and by the apply. */
    getPaneBlockIds: () => string[];
    /**
     * The audited atomic apply, taken as-is. Called at most once per drop, with the slot the user
     * dropped on already translated into the apply's own `stickySlotId` field.
     */
    applySnapPreset: (request: SnapApplyRequest) => Promise<SnapApplyResult>;
    /**
     * Panes the transaction may reclaim if a preset has fewer slots than the tab has panes.
     *
     * Optional: without it a preset that would need to remove a pane is treated as not applicable, so
     * the bar cannot offer a shrink that the transaction would refuse.
     */
    getReclaimablePaneIds?: () => Promise<string[]>;
}

/**
 * Handles a pane dropped on a preset slot.
 *
 * Guards run before the apply: the slot has to belong to the preset, and the preset has to be
 * applicable to the panes that exist right now. The capacity guard is repeated here on purpose - the
 * bar also disables those presets visually, but the pane count can change between render and drop.
 * An unanswered reclaim count is passed through as unknown rather than as zero, so a safe shrink is
 * not refused on the strength of a query that has not come back yet; the transaction still refuses
 * anything it cannot prove.
 */
export async function dropOnSnapSlot(deps: SnapDropDeps, request: SnapDropRequest): Promise<SnapDropOutcome> {
    const slotExists = collectSlots(request.preset.root).some((slot) => slot.slotId === request.slotId);
    if (!slotExists) {
        return { status: "skipped", reason: "unknown-slot" };
    }
    const paneCount = deps.getPaneBlockIds().length;
    const reclaimable = await countReclaimablePanes(deps);
    if (!isPresetApplicable(request.preset, paneCount, reclaimable)) {
        return { status: "skipped", reason: "preset-disabled", paneCount };
    }
    const result = await deps.applySnapPreset({
        preset: request.preset,
        stickySlotId: request.slotId,
        stickyBlockId: request.stickyBlockId,
    });
    return { status: result.status, result };
}

async function countReclaimablePanes(deps: SnapDropDeps): Promise<number | undefined> {
    if (deps.getReclaimablePaneIds == null) {
        return undefined;
    }
    try {
        return (await deps.getReclaimablePaneIds()).length;
    } catch {
        // Unknown, not zero: the transaction decides, and it refuses without touching anything.
        return undefined;
    }
}

/**
 * Whether a preset can be applied to the panes that exist.
 *
 * A preset that fits is always applicable. A preset that would have to shrink is applicable when the
 * host reports enough reclaimable panes - and also while the host has not answered yet
 * (`reclaimableCount` undefined), because the answer arrives asynchronously and treating "no answer"
 * as "nothing may be reclaimed" left safe presets undroppable. The transaction is the authority: it
 * re-collects the facts, re-verifies them and refuses without touching anything if a shrink is unsafe,
 * so offering the preset early can never cost a pane.
 */
export function isPresetApplicable(preset: SnapPreset, paneCount: number, reclaimableCount?: number): boolean {
    if (canApplyPreset(preset, paneCount)) {
        return true;
    }
    if (reclaimableCount == null) {
        return true;
    }
    return paneCount - reclaimableCount <= collectSlots(preset.root).length;
}
