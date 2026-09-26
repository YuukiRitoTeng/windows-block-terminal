export type VisualAnchorContext = {
    blockId: string;
    /**
     * Which producer owns this command: "terminal-osc" or "hosted-sidechannel".
     * Required: a context without a known authority is never valid, so a missing
     * claim can never be matched by the other producer's confirmation.
     */
    authority: string;
    sessionEpoch: string;
    hookSequence: number;
    commandId?: string;
    anchorNonce: string;
    hostId?: string;
    runspaceId?: string;
};

export type VisualAnchorHandle = {
    dispose: () => void;
};

export type ConfirmedVisualAnchor = VisualAnchorContext & {
    commandId: string;
    mode: string;
    authority: string;
    handle: VisualAnchorHandle;
};

/**
 * The command authorities a confirmed identity may come from. Authority is an
 * explicit claim by the producer: `mode` describes the execution lifecycle and
 * is never used to decide which authority owns a command.
 */
export const KnownCommandAuthorities = ["terminal-osc", "hosted-sidechannel"] as const;

export function isKnownAuthority(authority?: string): boolean {
    return authority != null && (KnownCommandAuthorities as readonly string[]).includes(authority);
}

export type MarkAuthority = {
    authority: (typeof KnownCommandAuthorities)[number];
    hostId?: string;
    runspaceId?: string;
};

/**
 * Decides which producer a visual anchor mark belongs to.
 *
 * Both producers write their marks into the same terminal stream, so the mark's
 * own identity claim decides it - exactly as the Go anchor registry does. A mark
 * that names a hosted process and runspace is the hosted runtime's mark; a mark
 * that names nothing belongs to the terminal integration. The identity stays a
 * claim: it must agree with the authenticated confirmation before it binds, and a
 * terminal mark never carries one.
 */
export function authorityForMark(hostId?: string, runspaceId?: string): MarkAuthority {
    if (hasIdentity(hostId) && hasIdentity(runspaceId)) {
        return { authority: "hosted-sidechannel", hostId, runspaceId };
    }
    return { authority: "terminal-osc" };
}

function hasIdentity(value?: string): boolean {
    return typeof value === "string" && value !== "";
}

type PendingAnchor = VisualAnchorContext & { handle: VisualAnchorHandle };
type PendingConfirmation = VisualAnchorContext & { mode: string; authority: string; at: number };
type BindingEntry = { binding: ConfirmedVisualAnchor; at: number };

const MAX_PENDING = 256;
const MAX_BINDINGS = 1024;
const MAX_TOMBSTONES = 512;
const PENDING_TTL_MS = 10 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 60 * 1000;

/**
 * How many anchors of a not-yet-trusted session are parked before the oldest are evicted.
 * Exported so a regression can assert the bound instead of restating the number.
 */
export const MaxQuarantinedAnchors = MAX_PENDING;

export class VisualAnchorRegistry {
    /** The shell session this registry currently serves. */
    sessionEpoch = "";
    private maxSequence = 0;
    private anchors = new Map<string, PendingAnchor & { at: number }>();
    private confirmations = new Map<string, PendingConfirmation>();
    private bindings = new Map<string, BindingEntry>();
    private rejected = new Map<string, number>();
    /**
     * Valid anchors that arrived before their session was trusted. A newer-epoch B must not take
     * session authority on its own, but it must not be tombstoned either: when the trusted
     * confirmation of that epoch arrives, the anchor is re-observed and pairs normally.
     */
    private quarantined = new Map<string, PendingAnchor & { at: number; epoch: string }>();

    observeAnchor(anchor: VisualAnchorContext & { handle: VisualAnchorHandle }): boolean {
        this.prune();
        if (!this.isValidContext(anchor, false)) return false;
        if (this.rejected.has(anchor.anchorNonce)) return false;
        if (!this.acceptSequence(anchor)) {
            if (this.sessionEpoch !== "" && anchor.sessionEpoch !== this.sessionEpoch) {
                // A different session: no authority until a trusted confirmation declares the
                // transition, and no tombstone that would permanently lose the first binding.
                this.quarantine(anchor);
                return false;
            }
            this.rejectPending(anchor.anchorNonce);
            return false;
        }
        if (this.bindings.has(anchor.anchorNonce) || this.anchors.has(anchor.anchorNonce)) return false;
        const confirmation = this.confirmations.get(anchor.anchorNonce);
        if (confirmation) {
            if (!this.matches(anchor, confirmation)) {
                this.reject(anchor.anchorNonce);
                this.confirmations.delete(anchor.anchorNonce);
                return false;
            }
            this.confirmations.delete(anchor.anchorNonce);
            this.bindings.set(anchor.anchorNonce, {
                binding: { ...anchor, ...confirmation, commandId: confirmation.commandId, handle: anchor.handle },
                at: Date.now(),
            });
            this.evictBindings();
            return true;
        }
        this.anchors.set(anchor.anchorNonce, { ...anchor, at: Date.now() });
        this.evictPending();
        return true;
    }

    confirm(binding: VisualAnchorContext & { mode: string; authority: string }): void {
        this.prune();
        if (!this.isValidContext(binding, true) || !isKnownAuthority(binding.authority)) {
            this.rejectPending(binding.anchorNonce);
            return;
        }
        if (this.rejected.has(binding.anchorNonce)) return;
        if (!this.acceptSequence(binding)) {
            this.rejectPending(binding.anchorNonce);
            return;
        }
        if (this.bindings.has(binding.anchorNonce)) return;
        const anchor = this.anchors.get(binding.anchorNonce);
        if (anchor) {
            if (!this.matches(anchor, binding)) {
                this.reject(binding.anchorNonce);
                this.anchors.delete(binding.anchorNonce);
                anchor.handle.dispose();
                return;
            }
            this.anchors.delete(binding.anchorNonce);
            this.bindings.set(binding.anchorNonce, {
                binding: { ...anchor, ...binding, commandId: binding.commandId },
                at: Date.now(),
            });
            this.evictBindings();
            return;
        }
        if (this.confirmations.has(binding.anchorNonce)) return;
        this.confirmations.set(binding.anchorNonce, { ...binding, at: Date.now() });
        this.evictPending();
    }

    remove(anchorNonce: string): void {
        if (anchorNonce === "") return;
        this.anchors.delete(anchorNonce);
        this.bindings.delete(anchorNonce);
        this.confirmations.delete(anchorNonce);
        // A nonce that is no longer wanted is no longer parked either. Its marker died with the
        // caller's cue, so a later trusted confirmation must be free to bind that nonce on a fresh
        // frame instead of meeting the teardown of the previous one as a rejection.
        if (this.quarantined.delete(anchorNonce)) return;
        this.reject(anchorNonce);
    }

    invalidate(): void {
        for (const nonce of this.anchors.keys()) this.reject(nonce);
        for (const nonce of this.confirmations.keys()) this.reject(nonce);
        for (const nonce of this.bindings.keys()) this.reject(nonce);
        // A parked anchor is presentation state like any other binding: its marker is gone with the
        // buffer that held it, so it can no longer be navigated to and must not survive as an entry
        // a later trusted confirmation would adopt. It is dropped rather than tombstoned: a parked
        // anchor was never accepted, so rejecting its nonce would let the teardown of one frame
        // block a later trusted confirmation from binding that nonce at all.
        for (const entry of this.quarantined.values()) entry.handle.dispose();
        for (const anchor of this.anchors.values()) anchor.handle.dispose();
        for (const entry of this.bindings.values()) entry.binding.handle.dispose();
        this.anchors.clear();
        this.confirmations.clear();
        this.bindings.clear();
        this.quarantined.clear();

        this.evictTombstones();
    }

    /**
     * Resets the session lock when a trusted confirmation declares a different session epoch.
     * A trusted controller restart starts a fresh shell session (epoch-B / seq=1) in the same pane;
     * the previous session's lock and its stale pending state must not reject it. This is deliberately
     * NOT part of invalidate(): clearVisualBuffer() invalidates without touching the shell session.
     */
    resetSessionForEpoch(sessionEpoch: string): void {
        if (sessionEpoch === "" || sessionEpoch === this.sessionEpoch) return;
        for (const nonce of [...this.anchors.keys(), ...this.confirmations.keys(), ...this.bindings.keys()]) {
            this.reject(nonce);
        }
        for (const anchor of this.anchors.values()) anchor.handle.dispose();
        for (const entry of this.bindings.values()) entry.binding.handle.dispose();
        this.anchors.clear();
        this.confirmations.clear();
        this.bindings.clear();
        this.sessionEpoch = sessionEpoch;
        this.maxSequence = 0;
        this.evictTombstones();
        // Adopt the anchors this session already delivered before it was trusted. They are
        // re-observed through the normal path, so pairing stays exactly the existing one.
        const pendingForEpoch = [...this.quarantined.values()].filter((entry) => entry.epoch === sessionEpoch);
        for (const entry of pendingForEpoch) {
            this.quarantined.delete(entry.anchorNonce);
        }
        for (const entry of pendingForEpoch) {
            this.observeAnchor(entry);
        }
    }

    /**
     * Whether a valid anchor of a not-yet-trusted session is waiting for its trusted transition.
     * Its marker must survive until then: a quarantined anchor is parked, not rejected.
     */
    isQuarantined(anchorNonce: string): boolean {
        return anchorNonce !== "" && this.quarantined.has(anchorNonce);
    }

    private quarantine(anchor: VisualAnchorContext & { handle: VisualAnchorHandle }): void {
        if (this.quarantined.has(anchor.anchorNonce)) return;
        this.quarantined.set(anchor.anchorNonce, { ...anchor, at: Date.now(), epoch: anchor.sessionEpoch });
        while (this.quarantined.size > MAX_PENDING) {
            const oldest = [...this.quarantined.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (oldest == null) break;
            this.quarantined.get(oldest[0])?.handle.dispose();
            this.quarantined.delete(oldest[0]);
        }
    }

    get(anchorNonce: string): ConfirmedVisualAnchor | undefined {
        this.prune();
        return this.bindings.get(anchorNonce)?.binding;
    }

    private isValidContext(context: VisualAnchorContext, requireCommandId: boolean): boolean {
        return (
            context.blockId !== "" &&
            isKnownAuthority(context.authority) &&
            context.sessionEpoch !== "" &&
            context.hookSequence > 0 &&
            (!requireCommandId || (typeof context.commandId === "string" && context.commandId !== "")) &&
            context.anchorNonce !== ""
        );
    }

    /**
     * A mark and a confirmation may only pair inside one authority, and the
     * identity they name must agree. Missing fields fail closed: a terminal mark
     * carries no hosted identity, and a hosted pair must name its process and
     * runspace on both sides.
     */
    private matches(anchor: VisualAnchorContext, confirmation: VisualAnchorContext): boolean {
        if (!isKnownAuthority(anchor.authority) || anchor.authority !== confirmation.authority) return false;
        if (anchor.blockId !== confirmation.blockId) return false;
        if (anchor.sessionEpoch !== confirmation.sessionEpoch) return false;
        if (anchor.hookSequence !== confirmation.hookSequence) return false;
        if (anchor.commandId != null && anchor.commandId !== confirmation.commandId) return false;
        if (anchor.authority === "hosted-sidechannel") {
            return (
                hasIdentity(anchor.hostId) &&
                hasIdentity(anchor.runspaceId) &&
                anchor.hostId === confirmation.hostId &&
                anchor.runspaceId === confirmation.runspaceId
            );
        }
        return (
            !hasIdentity(anchor.hostId) &&
            !hasIdentity(anchor.runspaceId) &&
            !hasIdentity(confirmation.hostId) &&
            !hasIdentity(confirmation.runspaceId)
        );
    }

    private acceptSequence(context: VisualAnchorContext): boolean {
        if (this.sessionEpoch === "") this.sessionEpoch = context.sessionEpoch;
        if (this.sessionEpoch !== context.sessionEpoch || context.hookSequence < this.maxSequence) return false;
        if (context.hookSequence === this.maxSequence) {
            const known = this.anchors.has(context.anchorNonce) || this.confirmations.has(context.anchorNonce);
            if (!known) return false;
        } else {
            this.maxSequence = context.hookSequence;
        }
        return true;
    }

    private reject(nonce: string): void {
        if (nonce === "") return;
        this.rejected.set(nonce, Date.now());
        this.evictTombstones();
    }

    private rejectPending(nonce: string): void {
        if (nonce === "") return;
        const anchor = this.anchors.get(nonce);
        if (anchor) anchor.handle.dispose();
        this.anchors.delete(nonce);
        this.confirmations.delete(nonce);
        this.reject(nonce);
    }

    private prune(): void {
        const now = Date.now();
        for (const [nonce, entry] of this.anchors) {
            if (now - entry.at > PENDING_TTL_MS) {
                this.anchors.delete(nonce);
                this.reject(nonce);
            }
        }
        for (const [nonce, entry] of this.confirmations) {
            if (now - entry.at > PENDING_TTL_MS) {
                this.confirmations.delete(nonce);
                this.reject(nonce);
            }
        }
        for (const [nonce, at] of this.rejected) {
            if (now - at > TOMBSTONE_TTL_MS) this.rejected.delete(nonce);
        }
        this.evictPending();
        this.evictBindings();
        this.evictTombstones();
    }

    private evictPending(): void {
        while (this.anchors.size > MAX_PENDING) this.evictOldest(this.anchors);
        while (this.confirmations.size > MAX_PENDING) this.evictOldest(this.confirmations);
    }

    private evictBindings(): void {
        while (this.bindings.size > MAX_BINDINGS) this.evictOldest(this.bindings);
    }

    private evictOldest<T extends { at: number }>(entries: Map<string, T>): void {
        let oldestNonce = "";
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [nonce, entry] of entries) {
            if (entry.at < oldestAt) {
                oldestNonce = nonce;
                oldestAt = entry.at;
            }
        }
        if (oldestNonce === "") return;
        entries.delete(oldestNonce);
        this.reject(oldestNonce);
    }

    private evictTombstones(): void {
        while (this.rejected.size > MAX_TOMBSTONES) {
            let oldestNonce = "";
            let oldestAt = Number.POSITIVE_INFINITY;
            for (const [nonce, at] of this.rejected) {
                if (at < oldestAt) {
                    oldestNonce = nonce;
                    oldestAt = at;
                }
            }
            if (oldestNonce === "") return;
            this.rejected.delete(oldestNonce);
        }
    }
}