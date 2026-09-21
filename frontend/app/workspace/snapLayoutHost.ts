// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Binds Snap Layout application to the live runtime: the tab's real LayoutModel and ObjectService.
 *
 * Keeping this adapter separate from `applySnapPreset` is deliberate. The apply logic stays pure and
 * testable, while every runtime dependency (block creation, block deletion, the atomic tree commit,
 * the cleanup bracket, the pane facts that decide what may be reclaimed) is injected here, so the
 * production wiring is a single reviewable place.
 */

import { SnapApplyHost, SnapApplyRequest } from "@/app/workspace/snapApply";
import { SNAP_AUTOCREATED_META_KEY, SnapPaneFacts, judgeReclaimablePane } from "@/app/workspace/snapReclaim";
import { globalStore, WOS } from "@/app/store/global";
import * as services from "@/app/store/services";
import type { LayoutModel } from "@/layout/index";
import { substituteTreeBlockIds } from "@/layout/lib/snapMaterialize";
import type { LayoutNode } from "@/layout/lib/types";

/** Block definition for the Local Terminal that fills an empty preset slot. */
export function localTerminalBlockDef(): BlockDef {
    return {
        // The provenance key is not in the typed meta list, but the backend stores meta verbatim.
        meta: {
            view: "term",
            controller: "shell",
            // Explicit provenance: only a terminal created here may ever be reclaimed by a preset that
            // has fewer slots than the tab has panes.
            [SNAP_AUTOCREATED_META_KEY]: true,
        } as MetaType,
    };
}

/** Facts the host gathers per pane before a shrink is allowed. Injected so tests can drive them. */
export interface SnapPaneFactProviders {
    /** The block record: meta plus the job id that proves a job/session was attached. */
    getBlockRecord?: (blockId: string) => { meta?: Record<string, any> | null; jobId?: string | null } | undefined;
    /** Authoritative controller runtime status for the block. */
    getRuntimeStatus?: (
        blockId: string
    ) => Promise<{ shellprocstatus?: string; shellprocconnname?: string } | undefined>;
    /** Command journal usage: whether the journal is healthy, and how many commands the block has. */
    getJournalUsage?: (blockId: string) => Promise<{ healthy: boolean; recordCount: number } | undefined>;
    /** The pane that currently has focus, which may never be reclaimed. */
    getFocusedBlockId?: () => string | undefined;
}

export interface SnapLayoutHostDeps {
    layoutModel: LayoutModel;
    /** Services for creating and deleting blocks. */
    services: {
        ObjectService: {
            CreateBlock(blockDef: BlockDef, rtOpts?: RuntimeOpts): Promise<string>;
            DeleteBlock(blockId: string): Promise<void>;
        };
    };
    /**
     * Block ids the current tab owns. Required, and intentionally has no default: ownership has to
     * come from the tab record, never from the layout tree, because a stale tree would let a block
     * belonging to another tab (or one this tab no longer owns) pass the ownership check.
     *
     * Use `createTabSnapLayoutHost` to get the authoritative implementation, which reads the tab the
     * model is already bound to.
     */
    getTabBlockIds: () => string[];
    /** Overrides for the pane fact providers. Production defaults read the real runtime. */
    factProviders?: SnapPaneFactProviders;
}

/** The block record, read from the object store the layout is already subscribed to. */
function defaultBlockRecord(blockId: string): { meta?: Record<string, any> | null; jobId?: string | null } {
    const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
    const block = globalStore.get(blockAtom) as Block | undefined;
    return { meta: block?.meta ?? null, jobId: block?.jobid ?? null };
}

/** Controller runtime status: the authoritative statement of what the block's shell is doing. */
async function defaultRuntimeStatus(
    blockId: string
): Promise<{ shellprocstatus?: string; shellprocconnname?: string } | undefined> {
    try {
        const status = await services.BlockService.GetControllerStatus(blockId);
        if (status == null) {
            return undefined;
        }
        return { shellprocstatus: status.shellprocstatus, shellprocconnname: status.shellprocconnname };
    } catch {
        // Unknown is not "idle": a failed lookup must refuse the reclaim.
        return undefined;
    }
}

/** Command journal usage. An unhealthy journal is reported as unhealthy, never as "no commands". */
async function defaultJournalUsage(blockId: string): Promise<{ healthy: boolean; recordCount: number } | undefined> {
    try {
        const health = await services.CommandJournalService.GetHealth();
        const healthy = health?.status === "available";
        if (!healthy) {
            return { healthy: false, recordCount: 0 };
        }
        const records = await services.CommandJournalService.ListVisibleRecords(blockId);
        return { healthy: true, recordCount: (records ?? []).length };
    } catch {
        return undefined;
    }
}

/**
 * Creates the production host for a tab.
 *
 * `getPaneBlockIds` is the panes the tree currently shows (what an apply can reuse on screen), while
 * ownership checks go through the injected tab block list, so a block dragged in from another tab is
 * rejected rather than written into this layout.
 */
export function createSnapLayoutHost(deps: SnapLayoutHostDeps): SnapApplyHost {
    const { layoutModel, services: injectedServices, getTabBlockIds, factProviders } = deps;
    const providers: Required<SnapPaneFactProviders> = {
        getBlockRecord: factProviders?.getBlockRecord ?? defaultBlockRecord,
        getRuntimeStatus: factProviders?.getRuntimeStatus ?? defaultRuntimeStatus,
        getJournalUsage: factProviders?.getJournalUsage ?? defaultJournalUsage,
        getFocusedBlockId: factProviders?.getFocusedBlockId ?? (() => layoutModel.getFocusedBlockId()),
    };
    // Snapshot of the tree as it was when the apply started, so a failed shrink can be undone.
    let previousTree: { rootNode: LayoutNode; focusedNodeId?: string } | null = null;

    return {
        getPaneBlockIds: () => layoutModel.getLeafBlockIds(),
        isBlockInTab: (blockId: string) => getTabBlockIds().includes(blockId),
        createLocalTerminal: () =>
            injectedServices.ObjectService.CreateBlock(localTerminalBlockDef(), {
                termsize: { rows: 25, cols: 80 },
            }),
        deleteBlock: (blockId: string) => injectedServices.ObjectService.DeleteBlock(blockId),
        commitTree: async (rootNode: LayoutNode, focusedNodeId: string) => {
            layoutModel.commitSnapRoot(rootNode, focusedNodeId);
        },
        // While the apply is in flight the tab owns blocks the tree does not contain yet - and, while
        // shrinking, the tree holds blocks the tab is about to stop owning - so the model's orphan
        // cleanup stands down until the whole transaction has settled.
        beginApply: () => {
            previousTree = layoutModel.captureTreeSnapshot();
            layoutModel.beginSnapApply();
        },
        endApply: () => {
            previousTree = null;
            layoutModel.endSnapApply();
        },
        collectPaneFacts: async (request: SnapApplyRequest, blockIds?: string[]) => {
            const focusedBlockId = providers.getFocusedBlockId();
            const panes = blockIds ?? layoutModel.getLeafBlockIds();
            const tabBlockIds = getTabBlockIds();
            const facts: SnapPaneFacts[] = [];
            for (const blockId of panes) {
                facts.push(
                    await collectPaneFacts(
                        providers,
                        blockId,
                        { stickyBlockId: request.stickyBlockId, focusedBlockId },
                        tabBlockIds.includes(blockId)
                    )
                );
            }
            return facts;
        },
        // The committed layout's own panes: a block a removal is about to delete must not be in here,
        // and the compensation uses this to decide what the final layout still needs.
        getTreeBlockIds: () => layoutModel.getLeafBlockIds(),
        restorePreviousTree: async (substitutions: Record<string, string>) => {
            if (previousTree == null) {
                throw new Error("no previous layout to restore");
            }
            layoutModel.commitSnapRoot(
                substituteTreeBlockIds(previousTree.rootNode, substitutions),
                previousTree.focusedNodeId
            );
        },
    };
}

/**
 * Gathers the facts for one pane.
 *
 * Every provider is wrapped: a provider that throws produces a missing fact, and a missing fact is a
 * refusal in `judgeReclaimablePane`, so an unreadable pane can never be reclaimed. Ownership is passed
 * in from the caller's single read of the tab's block list, so it reflects the real tab record rather
 * than an assumption.
 */
export async function collectPaneFacts(
    providers: Required<SnapPaneFactProviders>,
    blockId: string,
    context: { stickyBlockId: string; focusedBlockId?: string },
    inTab: boolean
): Promise<SnapPaneFacts> {
    const record = safe(() => providers.getBlockRecord(blockId));
    const runtimeStatus = await safeAsync(() => providers.getRuntimeStatus(blockId));
    const journal = await safeAsync(() => providers.getJournalUsage(blockId));
    return {
        blockId,
        meta: record?.meta ?? null,
        jobId: record?.jobId ?? null,
        runtimeStatus: runtimeStatus ?? null,
        journal: journal ?? null,
        inTab,
        isSticky: blockId === context.stickyBlockId,
        isFocused: context.focusedBlockId != null && blockId === context.focusedBlockId,
    };
}

function safe<T>(fn: () => T): T | undefined {
    try {
        return fn();
    } catch {
        return undefined;
    }
}

async function safeAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
        return await fn();
    } catch {
        return undefined;
    }
}

/** Whether a dragged pane belongs to this tab, which is what lets it arm the Snap Bar. */
export function isPaneInTab(layoutModel: LayoutModel, blockId: string | undefined): boolean {
    if (blockId == null) {
        return false;
    }
    try {
        return layoutModel.getTabBlockIds().includes(blockId);
    } catch {
        return false;
    }
}

/**
 * The panes a Snap transaction could safely reclaim right now.
 *
 * This is advisory: it decides whether the Snap Bar offers a smaller preset. The transaction gathers
 * the same facts again and refuses if anything is off, so a stale answer here cannot cost a session.
 */
export async function collectReclaimablePaneIds(
    layoutModel: LayoutModel,
    factProviders?: SnapPaneFactProviders
): Promise<string[]> {
    const providers: Required<SnapPaneFactProviders> = {
        getBlockRecord: factProviders?.getBlockRecord ?? defaultBlockRecord,
        getRuntimeStatus: factProviders?.getRuntimeStatus ?? defaultRuntimeStatus,
        getJournalUsage: factProviders?.getJournalUsage ?? defaultJournalUsage,
        getFocusedBlockId: factProviders?.getFocusedBlockId ?? (() => layoutModel.getFocusedBlockId()),
    };
    const focusedBlockId = providers.getFocusedBlockId();
    const tabBlockIds = layoutModel.getTabBlockIds();
    const reclaimable: string[] = [];
    for (const blockId of layoutModel.getLeafBlockIds()) {
        const facts = await collectPaneFacts(
            providers,
            blockId,
            { stickyBlockId: "", focusedBlockId },
            tabBlockIds.includes(blockId)
        );
        if (judgeReclaimablePane(facts).reclaimable) {
            reclaimable.push(blockId);
        }
    }
    return reclaimable;
}

/**
 * The production host for a tab, with ownership taken from the tab the model is bound to.
 *
 * This is the wiring callers should use: there is no way to end up checking ownership against the
 * layout tree, and the cleanup bracket, the pane facts and the restore path are wired for every apply.
 */
export function createTabSnapLayoutHost(
    deps: Omit<SnapLayoutHostDeps, "getTabBlockIds"> & { factProviders?: SnapPaneFactProviders }
): SnapApplyHost {
    return createSnapLayoutHost({
        ...deps,
        getTabBlockIds: () => deps.layoutModel.getTabBlockIds(),
    });
}
