// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Snap Bar: a small trigger zone at the top centre that arms a chooser showing every frozen preset
 * with its real slot geometry.
 *
 * Two properties matter more than the visuals:
 *
 *   1. It exists in the DOM only while an in-app pane drag is in progress. A file dragged in from the
 *      OS never mounts it, so no extra dragover/drop handler can swallow the terminal's file drop.
 *   2. The only thing a drop can do is call the audited atomic apply for the preset and slot under the
 *      pointer. Releasing anywhere else, or cancelling, does nothing at all.
 *
 * The trigger is rendered for the whole drag (it is what the drag model hit-tests against) but takes
 * no pointer events, so the pane's own edge-drop behaviour is untouched everywhere except over the
 * chooser's slots.
 */

import { SnapPreset, SNAP_PRESETS, SnapPreviewNode, toPreviewTree } from "@/layout/lib/snapPresets";
import clsx from "clsx";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDrop } from "react-dnd";
import {
    SnapDropDeps,
    SnapTriggerSize,
    TILE_DRAG_ITEM_TYPE,
    dropOnSnapSlot,
    isPresetApplicable,
    paneBlockIdOfDragItem,
} from "./snapDrag";
import "./snapbar.scss";

export interface SnapTriggerProps {
    /** Measured by the layout so the drag model can hit-test the real element. */
    triggerRef?: React.Ref<HTMLDivElement>;
    /** Current strip size, derived from the workspace size. */
    size: SnapTriggerSize;
    /** True while the pointer is inside the strip, so the target lights up under the drag. */
    hot?: boolean;
}

/**
 * The Snap activation overlay: the visible strip the drag aims at.
 *
 * It is rendered for the whole pane drag and takes no pointer events - the drag model hit-tests its
 * real rectangle - so the panes underneath keep their ordinary drag behaviour until the strip is
 * actually touched.
 */
export function SnapTrigger({ triggerRef, size, hot }: SnapTriggerProps) {
    return (
        <div
            ref={triggerRef}
            className={clsx("snap-trigger", { hot })}
            style={{ width: size.width, height: size.height }}
            data-testid="snap-trigger"
            aria-hidden="true"
            title="Snap Layouts"
        >
            <div className="snap-trigger-grip" />
        </div>
    );
}

export interface SnapBarProps {
    /** Panes currently in the tab; presets that cannot be applied are shown disabled. */
    paneBlockIds: string[];
    /** How many of those panes the transaction may reclaim, so a shrink can be offered when it is safe. */
    reclaimablePaneCount?: number;
    /** Applies the chosen preset through the audited atomic apply. */
    dropDeps: SnapDropDeps;
    /** Called after a drop has been handled, whatever the outcome, so the caller can close the bar. */
    onDropHandled?: () => void;
    /** Attached to the chooser panel root so the drag model can measure it. */
    panelRef?: React.Ref<HTMLDivElement>;
    /** Distance from the top of the workspace to the top of the panel, so the strip stays visible. */
    topOffsetPx?: number;
}

export function SnapBar({
    paneBlockIds,
    reclaimablePaneCount = 0,
    dropDeps,
    onDropHandled,
    panelRef,
    topOffsetPx = 0,
}: SnapBarProps) {
    const paneCount = paneBlockIds.length;

    return (
        <div className="snap-bar-layer">
            <div className="snap-bar-backdrop" />
            <div
                className="snap-bar"
                role="toolbar"
                aria-label="Snap Layouts"
                ref={panelRef}
                style={{ "--snap-bar-top": `${topOffsetPx}px` } as React.CSSProperties}
            >
                {SNAP_PRESETS.map((preset) => (
                    <SnapPresetCard
                        key={preset.id}
                        preset={preset}
                        paneCount={paneCount}
                        reclaimablePaneCount={reclaimablePaneCount}
                        dropDeps={dropDeps}
                        onDropHandled={onDropHandled}
                    />
                ))}
            </div>
        </div>
    );
}

/**
 * Asks the host which panes a shrink could reclaim.
 *
 * The answer only decides whether a smaller preset is offered; the transaction re-decides before it
 * removes anything. Two details matter, and both were wrong before:
 *
 *   - it is re-asked whenever the set of panes changes, because a count computed once (when a tab's
 *     layout mounted, before the panes even had controllers) would otherwise be reused forever and a
 *     preset that is perfectly safe to apply would stay undroppable;
 *   - "not answered yet" is reported as `undefined`, not as zero. A host that cannot answer must not
 *     silently disable every preset that needs a shrink - the transaction is the authority on whether
 *     a shrink is safe, and it refuses without touching anything.
 */
export function useReclaimablePaneCount(dropDeps: SnapDropDeps, paneBlockIds: string[]): number | undefined {
    const [count, setCount] = useState<number | undefined>(undefined);
    const getReclaimablePaneIds = dropDeps.getReclaimablePaneIds;
    // Re-ask whenever the panes themselves change, not just when the provider identity changes.
    const paneKey = paneBlockIds.join("|");

    useEffect(() => {
        let cancelled = false;
        if (getReclaimablePaneIds == null) {
            setCount(undefined);
            return;
        }
        // Unknown until the fresh answer arrives: an async answer must never be mistaken for "none".
        setCount(undefined);
        void getReclaimablePaneIds()
            .then((ids) => {
                if (!cancelled) {
                    setCount(ids?.length ?? 0);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setCount(undefined);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [getReclaimablePaneIds, paneKey]);

    return count;
}

interface SnapPresetCardProps {
    preset: SnapPreset;
    paneCount: number;
    reclaimablePaneCount: number;
    dropDeps: SnapDropDeps;
    onDropHandled?: () => void;
}

function SnapPresetCard({ preset, paneCount, reclaimablePaneCount, dropDeps, onDropHandled }: SnapPresetCardProps) {
    const preview = useMemo(() => toPreviewTree(preset), [preset]);
    const applicable = isPresetApplicable(preset, paneCount, reclaimablePaneCount);
    const shrinks = paneCount > countSlotsOf(preview);
    return (
        <div
            className={clsx("snap-preset", { disabled: !applicable, shrink: applicable && shrinks })}
            data-preset-id={preset.id}
        >
            <div className="snap-preset-preview">
                <SnapPreviewGroup
                    node={preview}
                    preset={preset}
                    enabled={applicable}
                    dropDeps={dropDeps}
                    onDropHandled={onDropHandled}
                />
            </div>
            <div className="snap-preset-label">{preset.label}</div>
        </div>
    );
}

function countSlotsOf(preview: SnapPreviewNode): number {
    if (preview.kind === "slot") {
        return 1;
    }
    return (preview.children ?? []).reduce((sum, child) => sum + countSlotsOf(child), 0);
}

interface SnapPreviewGroupProps {
    node: SnapPreviewNode;
    preset: SnapPreset;
    /** False when the preset cannot be applied: its slots must not accept a drop. */
    enabled: boolean;
    dropDeps: SnapDropDeps;
    onDropHandled?: () => void;
}

/** Renders a preset's template recursively; weights come straight from the frozen template. */
function SnapPreviewGroup({ node, preset, enabled, dropDeps, onDropHandled }: SnapPreviewGroupProps) {
    if (node.kind === "slot") {
        return (
            <SnapSlotZone
                slotId={node.slotId}
                preset={preset}
                weight={node.weight}
                enabled={enabled}
                dropDeps={dropDeps}
                onDropHandled={onDropHandled}
            />
        );
    }
    return (
        <div className={clsx("snap-preview-group", `flex-${node.direction}`)}>
            {node.children.map((child, index) => (
                <SnapPreviewGroup
                    key={child.slotId ?? `${preset.id}-group-${index}`}
                    node={child}
                    preset={preset}
                    enabled={enabled}
                    dropDeps={dropDeps}
                    onDropHandled={onDropHandled}
                />
            ))}
        </div>
    );
}

interface SnapSlotZoneProps {
    slotId: string;
    preset: SnapPreset;
    weight: number;
    /** False when the preset cannot be applied: the slot must not accept a drop. */
    enabled: boolean;
    dropDeps: SnapDropDeps;
    onDropHandled?: () => void;
}

/**
 * One slot of a preset. This is the only element in the app that accepts a pane dropped on the Snap
 * Bar, and its drop runs the audited atomic apply exactly once. A preset that cannot be applied to the
 * current panes does not accept the drop at all, so a pane can never be deleted by an unsafe snap.
 */
function SnapSlotZone({ slotId, preset, weight, enabled, dropDeps, onDropHandled }: SnapSlotZoneProps) {
    const [{ isOver, canDrop }, drop] = useDrop(
        () => ({
            accept: TILE_DRAG_ITEM_TYPE,
            canDrop: () => enabled,
            drop: (item) => {
                const stickyBlockId = paneBlockIdOfDragItem(item);
                if (stickyBlockId == null) {
                    return;
                }
                // The apply reports its own outcome; the drag is already over, so nothing waits on it.
                void dropOnSnapSlot(dropDeps, { preset, slotId, stickyBlockId })
                    .then((outcome) => {
                        if (outcome.status !== "applied") {
                            // A refusal has to be diagnosable: without this, a blocked preset is
                            // invisible outside the UI that greyed it out.
                            console.warn("snap layout preset not applied", {
                                preset: preset.id,
                                slot: slotId,
                                pane: stickyBlockId,
                                outcome,
                            });
                        }
                    })
                    .catch((error) => console.error("snap layout apply failed", error))
                    .finally(() => onDropHandled?.());
            },
            collect: (monitor) => ({
                isOver: monitor.isOver({ shallow: true }),
                canDrop: monitor.canDrop(),
            }),
        }),
        [preset, slotId, dropDeps, enabled]
    );

    const setRef = useCallback(
        (element: HTMLDivElement | null) => {
            drop(element);
        },
        [drop]
    );

    return (
        <div
            ref={setRef}
            className={clsx("snap-slot", { over: isOver && canDrop })}
            style={{ flexGrow: weight, flexBasis: 0 }}
            data-slot-id={slotId}
            data-preset-id={preset.id}
        />
    );
}
