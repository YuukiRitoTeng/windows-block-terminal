// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Snap Layout presets.
 *
 * A preset is a recursive tree template, not a rectangular grid. The layout tree is a nested
 * row/column structure, so "one large pane beside two stacked panes" is expressed as a Row whose
 * second child is a nested Column - which is exactly what splitHorizontal followed by
 * splitVertical produces. Expressing presets as a rectangle silently drops those layouts.
 *
 * Weights live on sibling relationships (`weight` within a group) and nowhere else. The Snap Bar
 * glyph and the materialized LayoutNode tree are both derived from this one template, so a preset
 * cannot describe geometry its own preview does not show.
 *
 * Slot order is the stable fill order used when panes are assigned to slots and is frozen: the
 * backend addresses slots by this order.
 */

export interface SnapGroupTemplate {
    kind: "group";
    /** Flex direction of this group, matching the layout model's FlexDirection values. */
    direction: "row" | "column";
    /**
     * Share of this group's parent along the parent's direction. Omitted means "split evenly with my
     * siblings", which is the common case; a value is only needed when a nested group is asymmetric
     * against its siblings. Holding the weight on the group itself keeps the split expressible for
     * groups and slots alike instead of leaving nested groups permanently equal.
     */
    weight?: number;
    children: SnapTemplate[];
}

export interface SnapSlotTemplate {
    kind: "slot";
    /** Stable slot identity, unique within a preset. */
    slotId: string;
    /** Layout weight among this slot's siblings. Sibling weights sum to 100. */
    weight: number;
}

export type SnapTemplate = SnapGroupTemplate | SnapSlotTemplate;

export interface SnapPreset {
    id: string;
    label: string;
    root: SnapGroupTemplate;
    /** True when this preset is the default layout for a brand-new workspace. */
    defaultWorkspace?: boolean;
}

function group(direction: "row" | "column", ...children: SnapTemplate[]): SnapGroupTemplate {
    return { kind: "group", direction, children };
}

function slot(slotId: string, weight: number): SnapSlotTemplate {
    return { kind: "slot", slotId, weight };
}

/** The share a template takes of its parent, defaulting to an even split among siblings. */
export function templateWeight(node: SnapTemplate, siblingCount: number): number {
    if (node.kind === "slot") {
        return node.weight;
    }
    return node.weight ?? Math.floor(100 / Math.max(siblingCount, 1));
}

/**
 * The frozen preset set for this slice. Every entry is directly expressible by the existing nested
 * row/column layout tree; none requires a new grid-spanning model.
 *
 * Deliberately absent from this slice: row/col span data, a user-editable layout editor,
 * overlapping or floating panes, cross-tab or cross-window dragging, and presets beyond four slots.
 */
export const SNAP_PRESETS: SnapPreset[] = [
    {
        id: "two-columns",
        label: "左右",
        defaultWorkspace: true,
        root: group("row", slot("left", 50), slot("right", 50)),
    },
    {
        id: "two-columns-asymmetric",
        label: "左窄右宽",
        root: group("row", slot("left", 33), slot("right", 67)),
    },
    {
        id: "two-columns-asymmetric-reverse",
        label: "左宽右窄",
        root: group("row", slot("left", 67), slot("right", 33)),
    },
    {
        id: "two-rows",
        label: "上下",
        root: group("column", slot("top", 50), slot("bottom", 50)),
    },
    {
        id: "three-columns",
        label: "三等栏",
        root: group("row", slot("left", 34), slot("center", 33), slot("right", 33)),
    },
    {
        id: "four-grid",
        label: "四宫格",
        root: group(
            "column",
            group("row", slot("top-left", 50), slot("top-right", 50)),
            group("row", slot("bottom-left", 50), slot("bottom-right", 50))
        ),
    },
    {
        id: "left-major-with-right-stack",
        label: "左大右上下",
        root: group("row", slot("left", 50), group("column", slot("right-top", 50), slot("right-bottom", 50))),
    },
    {
        id: "right-major-with-left-stack",
        label: "右大左上下",
        root: group("row", group("column", slot("left-top", 50), slot("left-bottom", 50)), slot("right", 50)),
    },
];

/** The preset used for a brand-new workspace. */
export function getDefaultWorkspacePreset(): SnapPreset {
    return SNAP_PRESETS.find((preset) => preset.defaultWorkspace) ?? SNAP_PRESETS[0];
}

export function getSnapPresetById(id: string): SnapPreset | undefined {
    return SNAP_PRESETS.find((preset) => preset.id === id);
}

/** Every slot of a template, in the stable fill order (depth-first, child order preserved). */
export function collectSlots(node: SnapTemplate): SnapSlotTemplate[] {
    if (node.kind === "slot") {
        return [node];
    }
    return node.children.flatMap((child) => collectSlots(child));
}

/** Total number of panes a preset places. */
export function countSlots(preset: SnapPreset): number {
    return collectSlots(preset.root).length;
}

/**
 * A preview node mirrors the template shape, so the Snap Bar can render nested groups recursively
 * without re-deriving geometry. Weights are copied from the template, never recomputed.
 */
export interface SnapPreviewNode {
    kind: "group" | "slot";
    direction: "row" | "column";
    /** Relative weight among siblings. */
    weight: number;
    /** Present only for slots. */
    slotId?: string;
    children?: SnapPreviewNode[];
}

export function toPreviewTree(preset: SnapPreset): SnapPreviewNode {
    return projectNode(preset.root, 100);
}

function projectNode(node: SnapTemplate, weight: number): SnapPreviewNode {
    if (node.kind === "slot") {
        return { kind: "slot", direction: "row", weight: node.weight, slotId: node.slotId };
    }
    const siblingCount = node.children.length;
    return {
        kind: "group",
        direction: node.direction,
        weight,
        children: node.children.map((child) => projectNode(child, templateWeight(child, siblingCount))),
    };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export interface SnapAssignmentRequest {
    /** Stable slot id the dragged pane was dropped on. */
    stickySlotId: string;
    /** Total number of panes to place, i.e. existing panes plus panes that must be created. */
    paneCount: number;
}

export interface SnapPlacement {
    slotId: string;
    /** Layout weight for this slot among its siblings. */
    weight: number;
}

export interface SnapPlan {
    /**
     * Slots to fill, in priority order: index 0 is where the dragged pane goes, the rest follow the
     * preset's stable slot order.
     */
    placements: SnapPlacement[];
}

/**
 * Orders a preset's slots for a drop.
 *
 * The dragged pane keeps the slot it was dropped on; every other pane fills the remaining slots in
 * the preset's stable slot order. The plan deliberately does not report how many panes must be
 * created: that depends on how many panes the caller can actually reuse, and deriving it here would
 * require the caller to duplicate the same bookkeeping. The caller counts the slots it cannot fill.
 *
 * Returns null when the preset cannot be applied, including when the pane count exceeds the slot
 * count, because filling it would require deleting an existing pane.
 */
export function planSnapAssignment(preset: SnapPreset, request: SnapAssignmentRequest): SnapPlan | null {
    const slots = collectSlots(preset.root);
    if (request.paneCount < 1 || request.paneCount > slots.length) {
        return null;
    }
    const stickyIndex = slots.findIndex((s) => s.slotId === request.stickySlotId);
    if (stickyIndex < 0) {
        return null;
    }
    const ordered = [slots[stickyIndex], ...slots.filter((_, index) => index !== stickyIndex)];
    // The full ordered slot list is returned, not a prefix: the caller must fill every slot for the
    // committed tree to cover the preset, so truncating here would only make it re-derive the rest.
    const placements = ordered.map((s) => ({ slotId: s.slotId, weight: s.weight }));
    return { placements };
}

/** True when the preset can hold the existing panes without deleting any of them. */
export function canApplyPreset(preset: SnapPreset, paneCount: number): boolean {
    return paneCount <= countSlots(preset);
}
