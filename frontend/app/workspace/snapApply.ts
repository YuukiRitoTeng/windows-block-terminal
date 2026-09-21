// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Atomic Snap Layout application.
 *
 * Applying a preset has to change topology, sizes, focus and the pane set in one step. Doing it pane
 * by pane would expose intermediate trees that can be persisted or run through orphan cleanup,
 * leaving blocks that exist but are not in any tree. This controller therefore:
 *
 *   1. plans the assignment (the dragged pane keeps its slot; existing panes fill the rest),
 *   2. if the preset has fewer slots than the tab has panes, plans which panes may be *reclaimed* -
 *      and refuses the whole apply unless every pane it removes is proven safe to remove,
 *   3. creates only the local terminals the preset actually needs,
 *   4. materializes the complete tree, commits it with a single replacement, and only then removes the
 *      reclaimed panes.
 *
 * Everything happens inside one mutation window (`beginApply`/`endApply`), so orphan cleanup never
 * sees the intermediate states, and planned removals are never left to it: a pane this call removes is
 * removed here, inside the transaction.
 *
 * Failure handling is compensating, not best effort:
 *
 *   - before the commit, every block this call created is deleted again,
 *   - after the commit, if a removal fails, the panes already removed are re-created (they are, by
 *     definition, empty Snap-created terminals with no session to lose), the previous tree is
 *     re-committed pointing at the replacements, and the panes created for the new tree are removed,
 *   - whatever could not be compensated is reported in `leakedBlockIds` instead of being hidden.
 *
 * The controller depends on an injected host rather than on the layout model directly, so the
 * ordering, the reclaim rules and the compensation can be tested without a running app.
 */

import { LayoutNode } from "@/layout/lib/types";
import { materializeSnapPreset, substituteTreeBlockIds } from "@/layout/lib/snapMaterialize";
import { SnapPreset, collectSlots, countSlots, planSnapAssignment } from "@/layout/lib/snapPresets";
import { SnapPaneFacts, SnapReclaimRefusal, judgeReclaimablePane, planSnapReclaim } from "@/app/workspace/snapReclaim";

export interface SnapApplyHost {
    /** Block ids currently present in the tab, in the layout's stable leaf order. */
    getPaneBlockIds(): string[];
    /**
     * Returns true when the block belongs to the tab this apply targets. Guards against injecting a
     * block dragged in from another tab or window into this tab's layout.
     */
    isBlockInTab(blockId: string): boolean;
    /** Creates one Local Terminal block; resolves to its block id. */
    createLocalTerminal(): Promise<string>;
    /** Removes a block again. Used to roll back created blocks and to reclaim planned panes. */
    deleteBlock(blockId: string): Promise<void>;
    /**
     * Replaces the whole layout tree in one step. Implementations must persist once and must not
     * rebalance: the materialized tree is already the preset's exact shape.
     */
    commitTree(rootNode: LayoutNode, focusedNodeId: string): Promise<void>;
    /**
     * Opens the mutation window, before the first block is created.
     *
     * From here until `endApply` the tab owns blocks the tree does not contain (and, while shrinking,
     * the tree contains blocks the tab is about to stop owning), so hosts must keep orphan cleanup
     * from treating either as garbage. `endApply` is always called, even when a step fails, so an
     * implementation can hold a lock here without leaking it.
     */
    beginApply?(): void;
    /** Closes the mutation window, whatever the outcome. Called exactly once per `beginApply`. */
    endApply?(): void;
    /**
     * Facts about panes, used to decide what may be reclaimed when the preset is smaller than the
     * current layout, and to re-validate that decision immediately before a pane is removed.
     *
     * `blockIds` defaults to the panes the tree currently holds. The re-validation after the commit
     * asks for specific ids, because by then they are no longer in the tree.
     *
     * Optional: without it, an apply that would need to remove a pane is refused.
     */
    collectPaneFacts?(request: SnapApplyRequest, blockIds?: string[]): Promise<SnapPaneFacts[]>;
    /**
     * Puts the layout that was in place before this apply back, with the given block id substitutions.
     *
     * Only meaningful together with `collectPaneFacts`, and only called to compensate a failed
     * removal. Hosts that do not implement it must not allow reclaiming: the controller refuses
     * before it removes anything.
     */
    restorePreviousTree?(substitutions: Record<string, string>): Promise<void>;
    /**
     * Block ids the committed layout currently references.
     *
     * Required for reclaiming: it is how the controller knows a block it is about to delete is not
     * still on screen, and how the compensation knows which blocks the final layout still needs.
     * Without it, shrinking is refused and nothing that might be referenced is ever deleted.
     */
    getTreeBlockIds?(): string[];
}

export interface SnapApplyRequest {
    preset: SnapPreset;
    /** Slot the dragged pane was dropped on. */
    stickySlotId: string;
    /** Block id of the dragged pane. */
    stickyBlockId: string;
}

export type SnapApplyRejectReason =
    | "too-many-panes"
    | "unknown-slot"
    | "foreign-block"
    | "stale-pane"
    | "reclaim-unsafe"
    /** The reclaim decision could not be re-established (identity, ownership or facts changed). */
    | "reclaim-unverified";

export type SnapApplyResult =
    | {
          status: "applied";
          presetId: string;
          createdBlockIds: string[];
          /** Panes removed by this call because the preset had fewer slots. */
          reclaimedBlockIds: string[];
          paneCount: number;
      }
    | {
          status: "rejected";
          presetId: string;
          reason: SnapApplyRejectReason;
          paneCount: number;
          /** The pane the rejection is about, when it names one. */
          blockId?: string;
          /** For a refusal to shrink: every pane that was considered and why it was refused. */
          refused?: { blockId: string; reason: SnapReclaimRefusal }[];
          /** For a refusal to shrink: why the decision could not be re-established, when that is the cause. */
          detail?: string;
      }
    | {
          status: "failed";
          presetId: string;
          reason: "create-failed" | "commit-failed" | "reclaim-failed";
          /** Blocks created by this call that were rolled back. */
          rolledBackBlockIds: string[];
          /**
           * Blocks this call created (fillers or replacements) that survive and that the final layout
           * does not reference. These are real block ids: whatever could not be removed is named here
           * so the caller can see exactly what is left behind.
           */
          leakedBlockIds: string[];
          /** Panes this call removed and successfully put back. */
          restoredBlockIds: string[];
          /** Panes this call removed that could not be put back: the replacement failed. */
          unreplacedBlockIds: string[];
          error: unknown;
      };

/**
 * Applies a preset to the tab.
 *
 * The dragged pane keeps its block id and therefore its PTY, SSH or WSL session: it is moved in the
 * tree, never recreated. Existing panes fill the remaining slots in the preset's stable order, and
 * only the shortfall becomes new local terminals.
 */
export async function applySnapPreset(host: SnapApplyHost, request: SnapApplyRequest): Promise<SnapApplyResult> {
    const existing = host.getPaneBlockIds();
    const stickyIsKnown = existing.includes(request.stickyBlockId);
    const paneCount = existing.length;

    // Unknown slot ids are a programming error rather than a user-facing state.
    const slotIds = collectSlots(request.preset.root).map((slot) => slot.slotId);
    if (!slotIds.includes(request.stickySlotId)) {
        return { status: "rejected", presetId: request.preset.id, reason: "unknown-slot", paneCount };
    }

    // Ownership of the dragged pane is checked first, because "this pane is not yours at all" is a
    // more precise statement than "the tree is stale".
    if (!host.isBlockInTab(request.stickyBlockId)) {
        return {
            status: "rejected",
            presetId: request.preset.id,
            reason: "foreign-block",
            paneCount,
            blockId: request.stickyBlockId,
        };
    }

    // Every other pane that would be carried into the new tree has to belong to this tab too. A stale
    // or foreign leaf must not be able to move into a new layout, so the whole apply is refused rather
    // than reusing the rest.
    for (const blockId of existing) {
        if (!host.isBlockInTab(blockId)) {
            return {
                status: "rejected",
                presetId: request.preset.id,
                reason: "stale-pane",
                paneCount,
                blockId,
            };
        }
    }

    const plan = planSnapAssignment(request.preset, {
        stickySlotId: request.stickySlotId,
        paneCount: stickyIsKnown ? paneCount : paneCount + 1,
    });

    let reclaimPlan: SnapReclaimPlanResult = { reclaim: [], kept: existing };
    if (plan == null) {
        // More panes than slots: the preset can only be applied by removing panes, which is allowed
        // only for panes this app created as empty fillers and can still prove are unused.
        const decision = await planReclaim(host, request, existing, paneCount);
        if ("rejected" in decision) {
            return decision.rejected;
        }
        reclaimPlan = decision;
    }

    const keptPanes = reclaimPlan.kept;
    const assignment = planSnapAssignment(request.preset, {
        stickySlotId: request.stickySlotId,
        paneCount: stickyIsKnown ? keptPanes.length : keptPanes.length + 1,
    });
    if (assignment == null) {
        // Cannot happen: the reclaim plan leaves at most `countSlots` panes. Guarded anyway, because
        // guessing here would mean applying a preset that does not fit.
        return { status: "rejected", presetId: request.preset.id, reason: "too-many-panes", paneCount };
    }

    // Everything from here mutates: blocks are created that the tree does not contain yet, panes are
    // removed from the tree and then deleted, and only the host knows how to keep cleanup away from
    // the intermediate states.
    host.beginApply?.();
    try {
        // The reclaim decision was made before the window opened, so it is re-established here from
        // fresh facts before anything is created or committed. A pane that has been used, connected or
        // handed to another tab in the meantime abandons the shrink instead of being removed.
        if (reclaimPlan.reclaim.length > 0) {
            const reverified = await reverifyReclaim(host, request, existing, reclaimPlan.reclaim);
            if ("rejected" in reverified) {
                return reverified.rejected;
            }
        }
        const orderedSlots = assignment.placements.map((placement) => placement.slotId);
        return await applyToSlots(host, request, orderedSlots, keptPanes, reclaimPlan.reclaim, paneCount);
    } finally {
        host.endApply?.();
    }
}

interface SnapReclaimPlanResult {
    reclaim: string[];
    kept: string[];
}

type SnapReclaimDecision = SnapReclaimPlanResult | { rejected: SnapApplyResult };

/** Two id lists as sets: reclaim candidates are compared by identity, never by count. */
function sameBlockIdSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const left = new Set(a);
    return b.every((blockId) => left.has(blockId)) && left.size === new Set(b).size;
}

/**
 * Decides which panes may be removed, or refuses.
 *
 * Refusal is the safe answer and stays the default: no fact provider, no restore path, no way to read
 * the committed layout, insufficient safe panes, or any pane whose state is unknown all end the apply
 * before anything is touched.
 *
 * The facts must describe *exactly* the panes that are on screen - same ids, not merely the same
 * count - and each of them must still be owned by the tab, so a stale or foreign pane can never slip
 * into the plan.
 */
async function planReclaim(
    host: SnapApplyHost,
    request: SnapApplyRequest,
    existing: string[],
    paneCount: number
): Promise<SnapReclaimDecision> {
    const slotCount = countSlots(request.preset);
    const needed = paneCount - slotCount;
    const refuse = (
        reason: SnapApplyRejectReason,
        refused?: { blockId: string; reason: SnapReclaimRefusal }[],
        detail?: string
    ): SnapReclaimDecision => ({
        rejected: { status: "rejected", presetId: request.preset.id, reason, paneCount, refused, detail },
    });

    if (host.collectPaneFacts == null || host.restorePreviousTree == null || host.getTreeBlockIds == null) {
        // Without authoritative facts, a way to read the committed layout and a way to put the layout
        // back, shrinking is not safe.
        return refuse("too-many-panes");
    }
    if (needed <= 0) {
        return { reclaim: [], kept: existing };
    }

    let facts: SnapPaneFacts[];
    try {
        facts = await host.collectPaneFacts(request);
    } catch {
        return refuse("too-many-panes");
    }
    const mismatch = describeFactsMismatch(facts, existing, host);
    if (mismatch != null) {
        return refuse("reclaim-unverified", undefined, mismatch);
    }

    const planning = planSnapReclaim(facts, needed);
    if (!planning.ok) {
        return refuse("reclaim-unsafe", planning.plan.refused);
    }
    const reclaim = planning.plan.reclaim;
    return { reclaim, kept: existing.filter((blockId) => !reclaim.includes(blockId)) };
}

/**
 * Why the collected facts cannot be trusted for the current panes, or null when they can.
 *
 * The facts have to name exactly the panes that are on screen and each of those panes has to be owned
 * by the tab - both from the authoritative tab block list, not from the tree.
 */
function describeFactsMismatch(facts: SnapPaneFacts[], existing: string[], host: SnapApplyHost): string | null {
    const factIds = facts.map((entry) => entry.blockId);
    if (!sameBlockIdSet(factIds, existing)) {
        return `facts cover [${factIds.join(", ")}] but the layout holds [${existing.join(", ")}]`;
    }
    for (const entry of facts) {
        if (entry.inTab !== true) {
            return `pane ${entry.blockId} is not owned by this tab`;
        }
        if (!host.isBlockInTab(entry.blockId)) {
            return `pane ${entry.blockId} is no longer in the tab's block list`;
        }
    }
    return null;
}

/**
 * Re-establishes the reclaim decision inside the mutation window, from freshly collected facts.
 *
 * The plan was made before the window opened, so this is where the time-of-check/time-of-use gap is
 * closed: the same panes must still be on screen, still owned, and still judged reclaimable, and the
 * plan must still select exactly the same ids. Anything else abandons the shrink with the layout
 * untouched.
 */
async function reverifyReclaim(
    host: SnapApplyHost,
    request: SnapApplyRequest,
    expectedPanes: string[],
    plannedReclaim: string[]
): Promise<SnapReclaimPlanResult | { rejected: SnapApplyResult }> {
    const reject = (reason: SnapApplyRejectReason, detail: string): { rejected: SnapApplyResult } => ({
        rejected: {
            status: "rejected",
            presetId: request.preset.id,
            reason,
            paneCount: expectedPanes.length,
            detail,
        },
    });

    if (host.collectPaneFacts == null) {
        return reject("reclaim-unverified", "the host stopped offering pane facts");
    }
    // The panes themselves may have changed since the plan was made.
    if (!sameBlockIdSet(host.getPaneBlockIds(), expectedPanes)) {
        return reject("reclaim-unverified", "the set of panes changed while the plan was being made");
    }

    let facts: SnapPaneFacts[];
    try {
        facts = await host.collectPaneFacts(request);
    } catch {
        return reject("reclaim-unverified", "pane facts could not be re-read");
    }
    const mismatch = describeFactsMismatch(facts, expectedPanes, host);
    if (mismatch != null) {
        return reject("reclaim-unverified", mismatch);
    }

    const planning = planSnapReclaim(facts, plannedReclaim.length);
    if (!planning.ok) {
        return {
            rejected: {
                status: "rejected",
                presetId: request.preset.id,
                reason: "reclaim-unsafe",
                paneCount: expectedPanes.length,
                refused: planning.plan.refused,
            },
        };
    }
    if (!sameBlockIdSet(planning.plan.reclaim, plannedReclaim)) {
        return {
            rejected: {
                status: "rejected",
                presetId: request.preset.id,
                reason: "reclaim-unsafe",
                paneCount: expectedPanes.length,
                refused: planning.plan.refused,
                detail: `the panes that may be reclaimed changed: was [${plannedReclaim.join(
                    ", "
                )}], now [${planning.plan.reclaim.join(", ")}]`,
            },
        };
    }
    return { reclaim: plannedReclaim, kept: expectedPanes.filter((blockId) => !plannedReclaim.includes(blockId)) };
}

/**
 * The mutating half of an apply: fill every preset slot, commit the tree, then remove reclaimed panes.
 *
 * Split out only so the mutation window opened by the caller can be closed in a single `finally`.
 */
async function applyToSlots(
    host: SnapApplyHost,
    request: SnapApplyRequest,
    orderedSlots: string[],
    keptPanes: string[],
    reclaim: string[],
    originalPaneCount: number
): Promise<SnapApplyResult> {
    const createdBlockIds: string[] = [];
    try {
        // The plan fixes the order; every preset slot must still end up with a pane, because the
        // committed tree has to cover the whole preset. Kept panes are consumed in plan order and only
        // the leftover slots become new local terminals.
        // Reusable panes are the kept panes minus the dragged one. Removing by value (not by position)
        // keeps this correct when the dragged pane came from outside the tab and is therefore not in
        // the list at all.
        const reusablePanes = [...keptPanes];
        const stickyIndex = reusablePanes.indexOf(request.stickyBlockId);
        if (stickyIndex >= 0) {
            reusablePanes.splice(stickyIndex, 1);
        }

        const blockIdsBySlot: Record<string, string> = {};
        for (const slotId of orderedSlots) {
            if (slotId === request.stickySlotId) {
                blockIdsBySlot[slotId] = request.stickyBlockId;
                continue;
            }
            const reused = reusablePanes.shift();
            if (reused != null) {
                blockIdsBySlot[slotId] = reused;
                continue;
            }
            // No pane left to reuse, so this slot needs a new terminal.
            let created: string;
            try {
                created = await host.createLocalTerminal();
            } catch (error) {
                const rolledBack = await rollback(host, createdBlockIds);
                return {
                    status: "failed",
                    presetId: request.preset.id,
                    reason: "create-failed",
                    rolledBackBlockIds: rolledBack.rolledBack,
                    leakedBlockIds: rolledBack.leaked,
                    restoredBlockIds: [],
                    unreplacedBlockIds: [],
                    error,
                };
            }
            createdBlockIds.push(created);
            blockIdsBySlot[slotId] = created;
        }

        const { rootNode, focusedNodeId } = materializeSnapPreset({
            preset: request.preset,
            blockIdsBySlot,
            stickySlotId: request.stickySlotId,
        });
        try {
            await host.commitTree(rootNode, focusedNodeId);
        } catch (error) {
            const rolledBack = await rollback(host, createdBlockIds);
            return {
                status: "failed",
                presetId: request.preset.id,
                reason: "commit-failed",
                rolledBackBlockIds: rolledBack.rolledBack,
                leakedBlockIds: rolledBack.leaked,
                restoredBlockIds: [],
                unreplacedBlockIds: [],
                error,
            };
        }

        // The tree no longer contains the reclaimed panes, so removing them now is consistent. They
        // are removed here, inside the transaction, never left to orphan cleanup - and each removal is
        // preceded by a fresh check, because anything may have changed since the plan was made.
        const reclaimedBlockIds: string[] = [];
        for (const blockId of reclaim) {
            const gate = await confirmReclaimableNow(host, request, blockId);
            if (!gate.ok) {
                const compensation = await compensateFailedReclaim(host, {
                    removed: reclaimedBlockIds,
                    created: createdBlockIds,
                });
                return {
                    status: "failed",
                    presetId: request.preset.id,
                    reason: "reclaim-failed",
                    rolledBackBlockIds: compensation.removedCreated,
                    leakedBlockIds: compensation.leaked,
                    restoredBlockIds: compensation.restored,
                    unreplacedBlockIds: compensation.unreplaced,
                    error: new Error(`refusing to remove pane ${blockId}: ${gate.reason}`),
                };
            }
            try {
                await host.deleteBlock(blockId);
                reclaimedBlockIds.push(blockId);
            } catch (error) {
                const compensation = await compensateFailedReclaim(host, {
                    removed: reclaimedBlockIds,
                    created: createdBlockIds,
                });
                return {
                    status: "failed",
                    presetId: request.preset.id,
                    reason: "reclaim-failed",
                    rolledBackBlockIds: compensation.removedCreated,
                    leakedBlockIds: compensation.leaked,
                    restoredBlockIds: compensation.restored,
                    unreplacedBlockIds: compensation.unreplaced,
                    error,
                };
            }
        }

        return {
            status: "applied",
            presetId: request.preset.id,
            createdBlockIds,
            reclaimedBlockIds,
            paneCount: originalPaneCount,
        };
    } catch (error) {
        const rolledBack = await rollback(host, createdBlockIds);
        return {
            status: "failed",
            presetId: request.preset.id,
            reason: "commit-failed",
            rolledBackBlockIds: rolledBack.rolledBack,
            leakedBlockIds: rolledBack.leaked,
            restoredBlockIds: [],
            unreplacedBlockIds: [],
            error,
        };
    }
}

type ReclaimConfirmation = { ok: true; reason?: undefined } | { ok: false; reason: string };

/**
 * The last check before a pane is deleted.
 *
 * Every condition the plan relied on is re-read here: the block must still belong to the tab, the
 * committed layout must no longer reference it (deleting a block the tree still shows would break the
 * layout), and a fresh set of facts must still judge it reclaimable - provenance, usage marker,
 * session, journal and runtime status included. Any change refuses the removal; nothing is deleted.
 */
async function confirmReclaimableNow(
    host: SnapApplyHost,
    request: SnapApplyRequest,
    blockId: string
): Promise<ReclaimConfirmation> {
    if (!host.isBlockInTab(blockId)) {
        return { ok: false, reason: "it no longer belongs to this tab" };
    }
    const treeBlockIds = host.getTreeBlockIds?.();
    if (treeBlockIds == null) {
        return { ok: false, reason: "the committed layout cannot be read" };
    }
    if (treeBlockIds.includes(blockId)) {
        return { ok: false, reason: "the committed layout still shows it" };
    }
    if (host.collectPaneFacts == null) {
        return { ok: false, reason: "pane facts are no longer available" };
    }

    let facts: SnapPaneFacts[];
    try {
        facts = await host.collectPaneFacts(request, [blockId]);
    } catch {
        return { ok: false, reason: "its facts could not be re-read" };
    }
    const paneFacts = facts?.find((entry) => entry.blockId === blockId);
    if (paneFacts == null) {
        return { ok: false, reason: "no facts were returned for it" };
    }
    if (!host.isBlockInTab(blockId)) {
        return { ok: false, reason: "it left the tab while its facts were being read" };
    }
    const verdict = judgeReclaimablePane(paneFacts);
    if (!verdict.reclaimable) {
        return { ok: false, reason: `it is no longer reclaimable (${verdict.reason})` };
    }
    return { ok: true };
}

/**
 * Undoes a removal that failed part way through.
 *
 * The panes already removed are re-created as equivalent empty terminals - safe precisely because a
 * reclaimable pane has no session, no job and no command history to lose - and the previous tree is
 * re-committed pointing at the replacements. The previous tree is only put back when *every* removed
 * pane has a live replacement: restoring a tree that names a deleted block would be worse than leaving
 * the new layout in place.
 *
 * Which layout ends up in place decides what has to be cleaned up, and the answer comes from the
 * committed layout itself, never from bookkeeping: every block this apply created - the fillers of the
 * new layout and the replacements - is deleted unless the final layout references it. Whatever cannot
 * be deleted is reported by its *real* block id, and the panes that could not be replaced are reported
 * separately, so nothing is described by a stale id.
 */
async function compensateFailedReclaim(
    host: SnapApplyHost,
    context: { removed: string[]; created: string[] }
): Promise<{ restored: string[]; removedCreated: string[]; leaked: string[]; unreplaced: string[] }> {
    const substitutions: Record<string, string> = {};
    const restored: string[] = [];
    const unreplaced: string[] = [];

    for (const blockId of context.removed) {
        try {
            substitutions[blockId] = await host.createLocalTerminal();
            restored.push(blockId);
        } catch {
            unreplaced.push(blockId);
        }
    }

    let treeRestored = false;
    if (unreplaced.length === 0) {
        try {
            await host.restorePreviousTree?.(substitutions);
            treeRestored = true;
        } catch {
            treeRestored = false;
        }
    }

    const finalTreeBlockIds = host.getTreeBlockIds?.();
    if (finalTreeBlockIds == null) {
        // The committed layout cannot be read, so nothing may be deleted: a block the layout still
        // references must never be removed. Everything this apply created is reported instead.
        return {
            restored: treeRestored ? restored : [],
            removedCreated: [],
            leaked: [...context.created, ...Object.values(substitutions)],
            unreplaced,
        };
    }

    const referenced = new Set(finalTreeBlockIds);
    const removedCreated: string[] = [];
    const leaked: string[] = [];
    const candidates = new Set<string>([...context.created, ...Object.values(substitutions)]);
    for (const blockId of candidates) {
        if (referenced.has(blockId)) {
            // Still part of the layout that stays in place.
            continue;
        }
        try {
            await host.deleteBlock(blockId);
            if (context.created.includes(blockId)) {
                removedCreated.push(blockId);
            }
        } catch {
            leaked.push(blockId);
        }
    }

    return { restored: treeRestored ? restored : [], removedCreated, leaked, unreplaced };
}

async function rollback(
    host: SnapApplyHost,
    blockIds: string[]
): Promise<{ rolledBack: string[]; leaked: string[] }> {
    const rolledBack: string[] = [];
    const leaked: string[] = [];
    for (const blockId of blockIds) {
        try {
            await host.deleteBlock(blockId);
            rolledBack.push(blockId);
        } catch {
            // A block that cannot be deleted is reported rather than silently dropped.
            leaked.push(blockId);
        }
    }
    return { rolledBack, leaked };
}
