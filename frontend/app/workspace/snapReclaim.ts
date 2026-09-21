// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which existing panes a preset may reclaim when it has fewer slots than the tab has panes.
 *
 * Down-sizing is only safe for panes the app itself created to fill a preset slot and that were never
 * used for anything: no session, no command, no job, no remote connection. Everything else - SSH, WSL,
 * durable sessions, a pane the user typed in, a pane whose state cannot be established - is refused.
 *
 * This module only judges facts it is handed; it never reads the layout tree or the backend. The
 * facts come from the host, and the rules here are deliberately *fail closed*: a missing runtime
 * status, an unhealthy command journal or a missing block record all mean "not reclaimable".
 *
 * Nothing here uses the preset templates: whether a slot can be filled is a layout question, whether a
 * pane may be destroyed is a runtime question, and the two are kept apart on purpose.
 */

/** Meta key written on every terminal the Snap Bar creates to fill a preset slot. */
export const SNAP_AUTOCREATED_META_KEY = "snap:autocreated";
/**
 * Meta key written the first time a user sends input to a Snap-created terminal.
 *
 * The command journal is the authoritative record of commands, but it depends on shell integration
 * reporting them; a keystroke marker cannot be missed, so a pane the user touched is never reclaimable
 * even if the journal never saw the command.
 */
export const SNAP_TOUCHED_META_KEY = "snap:touched";

export interface SnapPaneFacts {
    blockId: string;
    /** The block record's meta, verbatim. Undefined when the record could not be read. */
    meta?: Record<string, any> | null;
    /** `block.jobid`: set once a job/durable session was attached to the block. */
    jobId?: string | null;
    /** Authoritative controller runtime status. Undefined when it could not be read. */
    runtimeStatus?: { shellprocstatus?: string; shellprocconnname?: string } | null;
    /** Command journal usage. Undefined when the journal's health could not be established. */
    journal?: { healthy: boolean; recordCount: number } | null;
    /** Whether the block is in the tab's own block list. */
    inTab: boolean;
    /** Whether this pane is the one being dragged. */
    isSticky: boolean;
    /** Whether this pane currently has focus. */
    isFocused: boolean;
    /** Whether this pane is part of another in-flight mutation. */
    inOtherMutation?: boolean;
}

export type SnapReclaimRefusal =
    | "not-in-tab"
    | "in-other-mutation"
    | "sticky-pane"
    | "focused-pane"
    | "no-snap-provenance"
    | "touched-by-user"
    | "not-a-local-terminal"
    | "remote-connection"
    | "has-job-or-session"
    | "runtime-status-unknown"
    | "runtime-connecting"
    | "journal-unavailable"
    | "has-command-history";

export type SnapPaneReclaimVerdict =
    | { blockId: string; reclaimable: true; reason?: undefined }
    | { blockId: string; reclaimable: false; reason: SnapReclaimRefusal };

/** Runtime states that mean the pane is mid-connection: never reclaim one of those. */
const CONNECTING_RUNTIME_STATES = ["connecting", "init"];

/**
 * Whether a connection name means "this machine".
 *
 * Mirrors the backend's `conncontroller.IsLocalConnName`: the local connection is called `local`
 * (with `local:<variant>` for shells like Git Bash) and a block with no connection name is local too.
 * Anything else - `wsl://…`, `user@host`, `ssh:…` - is not, and such a pane is never reclaimed.
 */
export function isLocalConnectionName(connName: string | null | undefined): boolean {
    if (connName == null) {
        return true;
    }
    return connName === "" || connName === "local" || connName.startsWith("local:");
}

function isSnapCreated(meta: Record<string, any> | null | undefined): boolean {
    return meta?.[SNAP_AUTOCREATED_META_KEY] === true;
}

function isTouched(meta: Record<string, any> | null | undefined): boolean {
    return meta?.[SNAP_TOUCHED_META_KEY] === true;
}

/**
 * Whether a first keystroke should mark this block as used.
 *
 * Only Snap-created terminals are marked (nothing else can ever be reclaimed), and only once.
 */
export function shouldMarkSnapTerminalTouched(meta: Record<string, any> | null | undefined): boolean {
    return isSnapCreated(meta) && !isTouched(meta);
}

/**
 * Decides whether one pane may be reclaimed. The first failing rule wins, so the reason reported is
 * the strongest one that applies.
 */
export function judgeReclaimablePane(facts: SnapPaneFacts): SnapPaneReclaimVerdict {
    const refuse = (reason: SnapReclaimRefusal): SnapPaneReclaimVerdict => ({
        blockId: facts.blockId,
        reclaimable: false,
        reason,
    });

    if (!facts.inTab) {
        return refuse("not-in-tab");
    }
    if (facts.inOtherMutation) {
        return refuse("in-other-mutation");
    }
    if (facts.isSticky) {
        return refuse("sticky-pane");
    }
    if (facts.isFocused) {
        return refuse("focused-pane");
    }

    // Provenance: only a pane the Snap Bar itself created may be removed. This is an explicit marker,
    // never inferred from the view, the controller, or a missing connection name.
    if (!isSnapCreated(facts.meta)) {
        return refuse("no-snap-provenance");
    }
    if (isTouched(facts.meta)) {
        return refuse("touched-by-user");
    }

    // Shape: it must still be a plain local terminal.
    if (facts.meta?.view !== "term" || facts.meta?.controller !== "shell") {
        return refuse("not-a-local-terminal");
    }
    // Remote connections: SSH, WSL and anything else that is not this machine.
    if (!isLocalConnectionName(facts.meta?.connection)) {
        return refuse("remote-connection");
    }

    // A job means the block ran something or is attached to a durable session.
    if (facts.jobId != null && facts.jobId !== "") {
        return refuse("has-job-or-session");
    }

    // Authoritative runtime status must be known, and must not be mid-connection.
    if (facts.runtimeStatus == null) {
        return refuse("runtime-status-unknown");
    }
    if (!isLocalConnectionName(facts.runtimeStatus.shellprocconnname)) {
        return refuse("remote-connection");
    }
    const status = facts.runtimeStatus.shellprocstatus;
    if (status != null && CONNECTING_RUNTIME_STATES.includes(status)) {
        return refuse("runtime-connecting");
    }

    // The command journal must be healthy *and* empty: an unavailable journal means we cannot know
    // whether the pane was used, which is a refusal rather than an assumption.
    if (facts.journal == null || !facts.journal.healthy) {
        return refuse("journal-unavailable");
    }
    if (facts.journal.recordCount > 0) {
        return refuse("has-command-history");
    }

    return { blockId: facts.blockId, reclaimable: true };
}

export interface SnapReclaimPlan {
    /** Panes that will be removed. Empty whenever the plan refuses. */
    reclaim: string[];
    /** Every pane that was judged safe to remove, needed or not. Diagnostics, never acted on. */
    candidates: string[];
    /** Panes that were considered and refused, with the rule that refused them. */
    refused: { blockId: string; reason: SnapReclaimRefusal }[];
}

export type SnapReclaimPlanning =
    | { ok: true; plan: SnapReclaimPlan }
    | { ok: false; reason: "insufficient-reclaimable"; plan: SnapReclaimPlan };

/**
 * Picks the panes to reclaim, or refuses.
 *
 * `needed` is how many panes must go for the preset to fit. Reclaiming any *other* pane is never an
 * option, so an insufficient number of safe panes is a refusal, not a partial success: on a refusal
 * `reclaim` is empty, because nothing may be removed.
 */
export function planSnapReclaim(facts: SnapPaneFacts[], needed: number): SnapReclaimPlanning {
    const verdicts = facts.map(judgeReclaimablePane);
    const candidates = verdicts.filter((verdict) => verdict.reclaimable).map((verdict) => verdict.blockId);
    const refused = verdicts
        .filter((verdict): verdict is Extract<SnapPaneReclaimVerdict, { reclaimable: false }> => !verdict.reclaimable)
        .map((verdict) => ({ blockId: verdict.blockId, reason: verdict.reason }));

    if (needed <= 0) {
        return { ok: true, plan: { reclaim: [], candidates, refused } };
    }
    if (candidates.length < needed) {
        return { ok: false, reason: "insufficient-reclaimable", plan: { reclaim: [], candidates, refused } };
    }
    return { ok: true, plan: { reclaim: candidates.slice(0, needed), candidates, refused } };
}
