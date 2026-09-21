// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getSettingsKeyAtom } from "@/app/store/global";
import { createTabSnapLayoutHost } from "@/app/workspace/snapLayoutHost";
import { applySnapPreset } from "@/app/workspace/snapApply";
import * as services from "@/app/store/services";
import clsx from "clsx";
import { toPng } from "html-to-image";
import { Atom, useAtomValue, useSetAtom } from "jotai";
import React, {
    CSSProperties,
    ReactNode,
    Suspense,
    memo,
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import { DropTargetMonitor, XYCoord, useDrag, useDragLayer, useDrop } from "react-dnd";
import { debounce, throttle } from "throttle-debounce";
import { useDevicePixelRatio } from "use-device-pixel-ratio";
import { LayoutModel } from "./layoutModel";
import { useNodeModel, useTileLayout } from "./layoutModelHooks";
import { SnapBar, SnapTrigger, useReclaimablePaneCount } from "./snapbar";
import {
    SNAP_DRAG_CLOSED,
    SnapDragGeometry,
    SnapRect,
    SnapTriggerSize,
    TILE_DRAG_ITEM_TYPE,
    isPaneDrag,
    isPointInRect,
    isSnapBarMounted,
    paneBlockIdOfDragItem,
    reduceSnapDrag,
    triggerSizeFor,
} from "./snapDrag";
import { collectReclaimablePaneIds, isPaneInTab } from "@/app/workspace/snapLayoutHost";
import "./tilelayout.scss";
import {
    LayoutNode,
    LayoutTreeActionType,
    LayoutTreeComputeMoveNodeAction,
    ResizeHandleProps,
    TileLayoutContents,
} from "./types";
import { determineDropDirection } from "./utils";

const tileItemType = TILE_DRAG_ITEM_TYPE;

/** Distance from the top of the workspace to the activation strip, matching `snapbar.scss`. */
const SNAP_TRIGGER_TOP_PX = 6;
/** Gap between the strip and the chooser panel below it. */
const SNAP_CHOOSER_GAP_PX = 6;

export interface TileLayoutProps {
    /**
     * The atom containing the layout tree state.
     */
    tabAtom: Atom<Tab>;

    /**
     * callbacks and information about the contents (or styling) of the TileLayout or contents
     */
    contents: TileLayoutContents;

    /**
     * A callback for getting the cursor point in reference to the current window. This removes Electron as a runtime dependency, allowing for better integration with Storybook.
     * @returns The cursor position relative to the current window.
     */
    getCursorPoint?: () => Point;
}

const DragPreviewWidth = 300;
const DragPreviewHeight = 300;

function TileLayoutComponent({ tabAtom, contents, getCursorPoint }: TileLayoutProps) {
    const layoutModel = useTileLayout(tabAtom, contents);
    const overlayTransform = useAtomValue(layoutModel.overlayTransform);
    const setActiveDrag = useSetAtom(layoutModel.activeDrag);
    const setReady = useSetAtom(layoutModel.ready);
    const isResizing = useAtomValue(layoutModel.isResizing);
    const leafs = useAtomValue(layoutModel.leafs);

    const { activeDrag, dragClientOffset, dragItemType, dragItem } = useDragLayer((monitor) => ({
        activeDrag: monitor.isDragging(),
        dragClientOffset: monitor.getClientOffset(),
        dragItemType: monitor.getItemType(),
        dragItem: monitor.getItem(),
    }));

    useEffect(() => {
        const activeTileDrag = activeDrag && dragItemType == tileItemType;
        setActiveDrag(activeTileDrag);
    }, [activeDrag, dragItemType]);

    /**
     * Snap Bar state. It follows the Windows 11 shape: a visible strip sits at the top centre of the
     * workspace for the whole pane drag, touching it arms the bar, and only then does the chooser drop
     * down from it. Both regions are measured from the real elements - the strip's rendered rectangle
     * *is* the hit region - so the chooser stays open while the pointer is anywhere inside it,
     * including the second row, and closes only when the pointer genuinely leaves.
     */
    const [snapDrag, dispatchSnapDrag] = useReducer(reduceSnapDrag, SNAP_DRAG_CLOSED);
    const snapTriggerRef = useRef<HTMLDivElement>(null);
    const snapChooserRef = useRef<HTMLDivElement>(null);
    const [snapTriggerSize, setSnapTriggerSize] = useState<SnapTriggerSize>(() => triggerSizeFor(null));
    const [snapTriggerHot, setSnapTriggerHot] = useState(false);

    const measureSnapGeometry = useCallback((): SnapDragGeometry => {
        const rectOf = (element: HTMLElement | null): SnapRect | null => {
            const rect = element?.getBoundingClientRect();
            if (rect == null || (rect.width === 0 && rect.height === 0)) {
                return null;
            }
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        };
        return { trigger: rectOf(snapTriggerRef.current), chooser: rectOf(snapChooserRef.current) };
    }, []);

    useEffect(() => {
        if (!activeDrag) {
            dispatchSnapDrag({ kind: "drag-ended" });
            setSnapTriggerHot(false);
            // A cancelled drag must leave no pending move behind, or the layout keeps showing a
            // placeholder for an operation the user abandoned.
            layoutModel.treeReducer({ type: LayoutTreeActionType.ClearPendingAction });
            return;
        }
        // The strip follows the workspace it sits in, and the rectangle measured below is the one that
        // was rendered, so aiming at the visible strip is exactly what arms the bar.
        const containerRect = layoutModel.displayContainerRef.current?.getBoundingClientRect();
        if (containerRect != null) {
            setSnapTriggerSize(triggerSizeFor({ width: containerRect.width, height: containerRect.height }));
        }
        const geometry = measureSnapGeometry();
        const pointer = dragClientOffset == null ? null : { x: dragClientOffset.x, y: dragClientOffset.y };
        setSnapTriggerHot(isPointInRect(geometry.trigger, pointer));
        dispatchSnapDrag({
            kind: "drag-moved",
            itemType: dragItemType,
            stickyBlockId: paneBlockIdOfDragItem(dragItem),
            paneInTab: isPaneInTab(layoutModel, paneBlockIdOfDragItem(dragItem)),
            pointer,
            geometry,
        });
    }, [activeDrag, dragItemType, dragItem, dragClientOffset]);

    // While the bar is open the pane below it must not compute a move preview: the drop the user is
    // aiming at is a snap slot, not an edge of the pane underneath.
    useEffect(() => {
        if (isSnapBarMounted(snapDrag)) {
            layoutModel.treeReducer({ type: LayoutTreeActionType.ClearPendingAction });
        }
    }, [snapDrag.phase]);

    /** Panes in this tab; a preset that cannot be applied to them is offered disabled. */
    const leafBlockIds = useMemo(
        () => leafs.map((leaf) => leaf.data?.blockId).filter((blockId) => blockId != null),
        [leafs]
    );

    const snapDropDeps = useMemo(
        () => ({
            getPaneBlockIds: () => layoutModel.getLeafBlockIds(),
            applySnapPreset: (request) => applySnapPreset(createTabSnapLayoutHost({ layoutModel, services }), request),
            getReclaimablePaneIds: () => collectReclaimablePaneIds(layoutModel),
        }),
        [layoutModel]
    );

    const handleSnapDropHandled = useCallback(() => {
        dispatchSnapDrag({ kind: "slot-dropped" });
    }, []);

    /** How many panes a shrink could reclaim; decides whether a smaller preset is offered at all. */
    const reclaimablePaneCount = useReclaimablePaneCount(snapDropDeps, leafBlockIds);

    const checkForCursorBounds = useCallback(
        debounce(100, (dragClientOffset: XYCoord) => {
            const cursorPoint = dragClientOffset ?? getCursorPoint?.();
            if (cursorPoint && layoutModel.displayContainerRef?.current) {
                const displayContainerRect = layoutModel.displayContainerRef.current.getBoundingClientRect();
                const normalizedX = cursorPoint.x - displayContainerRect.x;
                const normalizedY = cursorPoint.y - displayContainerRect.y;
                if (
                    normalizedX <= 0 ||
                    normalizedX >= displayContainerRect.width ||
                    normalizedY <= 0 ||
                    normalizedY >= displayContainerRect.height
                ) {
                    layoutModel.treeReducer({ type: LayoutTreeActionType.ClearPendingAction });
                }
            }
        }),
        [getCursorPoint]
    );

    // Effect to detect when the cursor leaves the TileLayout hit trap so we can remove any placeholders. This cannot be done using pointer capture
    // because that conflicts with the DnD layer.
    useEffect(() => checkForCursorBounds(dragClientOffset), [dragClientOffset]);

    // Ensure that we don't see any jostling in the layout when we're rendering it the first time.
    // `animate` will be disabled until after the transforms have all applied the first time.
    const [animate, setAnimate] = useState(false);
    useEffect(() => {
        setTimeout(() => {
            setAnimate(true);
            setReady(true);
        }, 50);
    }, []);

    const gapSizePx = useAtomValue(layoutModel.gapSizePx);
    const animationTimeS = useAtomValue(layoutModel.animationTimeS);
    const tileStyle = useMemo(
        () =>
            ({
                "--gap-size-px": `${gapSizePx}px`,
                "--animation-time-s": `${animationTimeS}s`,
            }) as CSSProperties,
        [gapSizePx, animationTimeS]
    );

    return (
        <Suspense>
            <div
                className={clsx("tile-layout", contents.className, { animate: animate && !isResizing })}
                style={tileStyle}
            >
                <div key="display" ref={layoutModel.displayContainerRef} className="display-container">
                    <ResizeHandleWrapper layoutModel={layoutModel} />
                    <DisplayNodesWrapper layoutModel={layoutModel} />
                    <NodeBackdrops layoutModel={layoutModel} />
                </div>
                <Placeholder key="placeholder" layoutModel={layoutModel} style={{ top: 10000, ...overlayTransform }} />
                <OverlayNodeWrapper layoutModel={layoutModel} snapBarOpen={isSnapBarMounted(snapDrag)} />
                {isPaneDrag(dragItemType) && (
                    <SnapTrigger
                        key="snaptrigger"
                        triggerRef={snapTriggerRef}
                        size={snapTriggerSize}
                        hot={snapTriggerHot}
                    />
                )}
                {isSnapBarMounted(snapDrag) && (
                    <SnapBar
                        key="snapbar"
                        paneBlockIds={leafBlockIds}
                        reclaimablePaneCount={reclaimablePaneCount}
                        dropDeps={snapDropDeps}
                        onDropHandled={handleSnapDropHandled}
                        panelRef={snapChooserRef}
                        topOffsetPx={snapTriggerSize.height + SNAP_TRIGGER_TOP_PX + SNAP_CHOOSER_GAP_PX}
                    />
                )}
            </div>
        </Suspense>
    );
}
export const TileLayout = memo(TileLayoutComponent) as typeof TileLayoutComponent;

function NodeBackdrops({ layoutModel }: { layoutModel: LayoutModel }) {
    const [blockBlurAtom] = useState(() => getSettingsKeyAtom("window:magnifiedblockblursecondarypx"));
    const blockBlur = useAtomValue(blockBlurAtom);
    const ephemeralNode = useAtomValue(layoutModel.ephemeralNode);
    const magnifiedNodeId = useAtomValue(layoutModel.magnifiedNodeIdAtom);

    const [showMagnifiedBackdrop, setShowMagnifiedBackdrop] = useState(!!ephemeralNode);
    const [showEphemeralBackdrop, setShowEphemeralBackdrop] = useState(!!magnifiedNodeId);

    const debouncedSetMagnifyBackdrop = useCallback(
        debounce(100, () => setShowMagnifiedBackdrop(true)),
        []
    );

    useEffect(() => {
        if (magnifiedNodeId && !showMagnifiedBackdrop) {
            debouncedSetMagnifyBackdrop();
        }
        if (!magnifiedNodeId) {
            setShowMagnifiedBackdrop(false);
        }
        if (ephemeralNode && !showEphemeralBackdrop) {
            setShowEphemeralBackdrop(true);
        }
        if (!ephemeralNode) {
            setShowEphemeralBackdrop(false);
        }
    }, [ephemeralNode, magnifiedNodeId]);

    const blockBlurStr = `${blockBlur}px`;

    return (
        <>
            {showMagnifiedBackdrop && (
                <div
                    className="magnified-node-backdrop"
                    onClick={() => {
                        layoutModel.magnifyNodeToggle(magnifiedNodeId);
                    }}
                    style={{ "--block-blur": blockBlurStr } as CSSProperties}
                />
            )}
            {showEphemeralBackdrop && (
                <div
                    className="ephemeral-node-backdrop"
                    onClick={() => {
                        layoutModel.closeNode(ephemeralNode?.id);
                    }}
                    style={{ "--block-blur": blockBlurStr } as CSSProperties}
                />
            )}
        </>
    );
}

interface DisplayNodesWrapperProps {
    /**
     * The layout tree state.
     */
    layoutModel: LayoutModel;
}

const DisplayNodesWrapper = ({ layoutModel }: DisplayNodesWrapperProps) => {
    const leafs = useAtomValue(layoutModel.leafs);

    return useMemo(
        () =>
            leafs.map((node) => {
                return <DisplayNode key={node.id} layoutModel={layoutModel} node={node} />;
            }),
        [leafs]
    );
};

interface DisplayNodeProps {
    layoutModel: LayoutModel;
    /**
     * The leaf node object, containing the data needed to display the leaf contents to the user.
     */
    node: LayoutNode;
}

/**
 * The draggable and displayable portion of a leaf node in a layout tree.
 */
const DisplayNode = ({ layoutModel, node }: DisplayNodeProps) => {
    const nodeModel = useNodeModel(layoutModel, node);
    const tileNodeRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const addlProps = useAtomValue(nodeModel.additionalProps);
    const devicePixelRatio = useDevicePixelRatio();
    const isEphemeral = useAtomValue(nodeModel.isEphemeral);
    const isMagnified = useAtomValue(nodeModel.isMagnified);

    const [{ isDragging }, drag, dragPreview] = useDrag(
        () => ({
            type: tileItemType,
            canDrag: () => !(isEphemeral || isMagnified),
            item: () => node,
            collect: (monitor) => ({
                isDragging: monitor.isDragging(),
            }),
        }),
        [node, addlProps, isEphemeral, isMagnified]
    );

    const [previewElementGeneration, setPreviewElementGeneration] = useState(0);
    const previewElement = useMemo(() => {
        setPreviewElementGeneration(previewElementGeneration + 1);
        return (
            <div key="preview" className="tile-preview-container">
                <div
                    className="tile-preview"
                    ref={previewRef}
                    style={{
                        width: DragPreviewWidth,
                        height: DragPreviewHeight,
                        transform: `scale(${1 / devicePixelRatio})`,
                    }}
                >
                    {layoutModel.renderPreview?.(nodeModel)}
                </div>
            </div>
        );
    }, [devicePixelRatio, nodeModel]);

    const [previewImage, setPreviewImage] = useState<HTMLImageElement>(null);
    const [previewImageGeneration, setPreviewImageGeneration] = useState(0);
    const generatePreviewImage = useCallback(() => {
        const offsetX = (DragPreviewWidth * devicePixelRatio - DragPreviewWidth) / 2 + 10;
        const offsetY = (DragPreviewHeight * devicePixelRatio - DragPreviewHeight) / 2 + 10;
        if (previewImage !== null && previewElementGeneration === previewImageGeneration) {
            dragPreview(previewImage, { offsetY, offsetX });
        } else if (previewRef.current) {
            setPreviewImageGeneration(previewElementGeneration);
            toPng(previewRef.current).then((url) => {
                const img = new Image();
                img.src = url;
                setPreviewImage(img);
                dragPreview(img, { offsetY, offsetX });
            });
        }
    }, [
        dragPreview,
        previewRef.current,
        previewElementGeneration,
        previewImageGeneration,
        previewImage,
        devicePixelRatio,
    ]);

    const leafContent = useMemo(() => {
        return (
            <div key="leaf" className="tile-leaf">
                {layoutModel.renderContent(nodeModel)}
            </div>
        );
    }, [nodeModel]);

    // Register the display node as a draggable item
    useEffect(() => {
        drag(nodeModel.dragHandleRef);
    }, [drag, nodeModel.dragHandleRef.current]);

    return (
        <div
            className={clsx("tile-node", {
                dragging: isDragging,
            })}
            key={node.id}
            ref={tileNodeRef}
            id={node.id}
            style={addlProps?.transform}
            onPointerEnter={generatePreviewImage}
            onPointerOver={(event) => event.stopPropagation()}
        >
            {leafContent}
            {previewElement}
        </div>
    );
};

interface OverlayNodeWrapperProps {
    layoutModel: LayoutModel;
    /** True while the Snap Bar is open: the panes below it must not preview a move. */
    snapBarOpen: boolean;
}

const OverlayNodeWrapper = memo(({ layoutModel, snapBarOpen }: OverlayNodeWrapperProps) => {
    const leafs = useAtomValue(layoutModel.leafs);
    const overlayTransform = useAtomValue(layoutModel.overlayTransform);

    const overlayNodes = useMemo(
        () =>
            leafs.map((node) => {
                return <OverlayNode key={node.id} layoutModel={layoutModel} node={node} snapBarOpen={snapBarOpen} />;
            }),
        [leafs, snapBarOpen]
    );

    return (
        <div key="overlay" className="overlay-container" style={{ top: 10000, ...overlayTransform }}>
            {overlayNodes}
        </div>
    );
});

interface OverlayNodeProps {
    /**
     * The layout tree state.
     */
    layoutModel: LayoutModel;
    node: LayoutNode;
    /** True while the Snap Bar is open: the panes below it must not preview a move. */
    snapBarOpen: boolean;
}

/**
 * An overlay representing the true flexbox layout of the LayoutTreeState. This holds the drop targets for moving around nodes and is used to calculate the
 * dimensions of the corresponding DisplayNode for each LayoutTreeState leaf.
 */
const OverlayNode = memo(({ node, layoutModel, snapBarOpen }: OverlayNodeProps) => {
    const nodeModel = useNodeModel(layoutModel, node);
    const additionalProps = useAtomValue(nodeModel.additionalProps);
    const overlayRef = useRef<HTMLDivElement>(null);
    const snapBarOpenRef = useRef(snapBarOpen);
    snapBarOpenRef.current = snapBarOpen;

    const [, drop] = useDrop(
        () => ({
            accept: tileItemType,
            canDrop: (_, monitor) => {
                const dragItem = monitor.getItem<LayoutNode>();
                if (monitor.isOver({ shallow: true }) && dragItem.id !== node.id) {
                    return true;
                }
                return false;
            },
            drop: (_, monitor) => {
                if (!monitor.didDrop()) {
                    layoutModel.onDrop();
                }
            },
            hover: throttle(50, (_, monitor: DropTargetMonitor<unknown, unknown>) => {
                if (monitor.isOver({ shallow: true })) {
                    if (snapBarOpenRef.current) {
                        // The pointer is aiming at a snap slot, not at this pane's edge.
                        layoutModel.treeReducer({
                            type: LayoutTreeActionType.ClearPendingAction,
                        });
                    } else if (monitor.canDrop() && layoutModel.displayContainerRef?.current && additionalProps?.rect) {
                        const dragItem = monitor.getItem<LayoutNode>();
                        // console.log("computing operation", layoutNode, dragItem, additionalProps.rect);
                        const offset = monitor.getClientOffset();
                        const containerRect = layoutModel.displayContainerRef.current.getBoundingClientRect();
                        offset.x -= containerRect.x;
                        offset.y -= containerRect.y;
                        layoutModel.treeReducer({
                            type: LayoutTreeActionType.ComputeMove,
                            nodeId: node.id,
                            nodeToMoveId: dragItem.id,
                            direction: determineDropDirection(additionalProps.rect, offset),
                        } as LayoutTreeComputeMoveNodeAction);
                    } else {
                        layoutModel.treeReducer({
                            type: LayoutTreeActionType.ClearPendingAction,
                        });
                    }
                }
            }),
        }),
        [node.id, additionalProps?.rect, layoutModel.displayContainerRef, layoutModel.onDrop, layoutModel.treeReducer]
    );

    // Register the overlay node as a drop target
    useEffect(() => {
        drop(overlayRef);
    }, []);

    return <div ref={overlayRef} className="overlay-node" id={node.id} style={additionalProps?.transform} />;
});

interface ResizeHandleWrapperProps {
    layoutModel: LayoutModel;
}

const ResizeHandleWrapper = memo(({ layoutModel }: ResizeHandleWrapperProps) => {
    const resizeHandles = useAtomValue(layoutModel.resizeHandles) as Atom<ResizeHandleProps>[];

    return resizeHandles.map((resizeHandleAtom, i) => (
        <ResizeHandle key={`resize-handle-${i}`} layoutModel={layoutModel} resizeHandleAtom={resizeHandleAtom} />
    ));
});

interface ResizeHandleComponentProps {
    resizeHandleAtom: Atom<ResizeHandleProps>;
    layoutModel: LayoutModel;
}

const ResizeHandle = memo(({ resizeHandleAtom, layoutModel }: ResizeHandleComponentProps) => {
    const resizeHandleProps = useAtomValue(resizeHandleAtom);
    const resizeHandleRef = useRef<HTMLDivElement>(null);

    // The pointer currently captured, or undefined.
    const [trackingPointer, setTrackingPointer] = useState<number>(undefined);

    // Calculates the new size of the two nodes on either side of the handle, based on the position of the cursor
    const handlePointerMove = useCallback(
        throttle(10, (event: React.PointerEvent<HTMLDivElement>) => {
            if (trackingPointer === event.pointerId) {
                const { clientX, clientY } = event;
                layoutModel.onResizeMove(resizeHandleProps, clientX, clientY);
            }
        }),
        [trackingPointer, layoutModel.onResizeMove, resizeHandleProps]
    );

    // We want to use pointer capture so the operation continues even if the pointer leaves the bounds of the handle
    function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
        resizeHandleRef.current?.setPointerCapture(event.pointerId);
    }

    // This indicates that we're ready to start tracking the resize operation via the pointer
    function onPointerCapture(event: React.PointerEvent<HTMLDivElement>) {
        setTrackingPointer(event.pointerId);
    }

    // We want to wait a bit before committing the pending resize operation in case some events haven't arrived yet.
    const onPointerRelease = useCallback(
        debounce(30, (event: React.PointerEvent<HTMLDivElement>) => {
            setTrackingPointer(undefined);
            layoutModel.onResizeEnd();
        }),
        [layoutModel]
    );

    return (
        <div
            ref={resizeHandleRef}
            className={clsx("resize-handle", `flex-${resizeHandleProps.flexDirection}`)}
            onPointerDown={onPointerDown}
            onGotPointerCapture={onPointerCapture}
            onLostPointerCapture={onPointerRelease}
            style={resizeHandleProps.transform}
            onPointerMove={handlePointerMove}
        >
            <div className="line" />
        </div>
    );
});

interface PlaceholderProps {
    /**
     * The layout tree state.
     */
    layoutModel: LayoutModel;
    /**
     * Any styling to apply to the placeholder container div.
     */
    style: React.CSSProperties;
}

/**
 * An overlay to preview pending actions on the layout tree.
 */
const Placeholder = memo(({ layoutModel, style }: PlaceholderProps) => {
    const [placeholderOverlay, setPlaceholderOverlay] = useState<ReactNode>(null);
    const placeholderTransform = useAtomValue(layoutModel.placeholderTransform);

    useEffect(() => {
        if (placeholderTransform) {
            setPlaceholderOverlay(<div className="placeholder" style={placeholderTransform} />);
        } else {
            setPlaceholderOverlay(null);
        }
    }, [placeholderTransform]);

    return (
        <div className="placeholder-container" style={style}>
            {placeholderOverlay}
        </div>
    );
});
