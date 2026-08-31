export type VisualAnchorContext = {
    blockId: string;
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
    handle: VisualAnchorHandle;
};

type PendingAnchor = VisualAnchorContext & { handle: VisualAnchorHandle };
type PendingConfirmation = VisualAnchorContext & { mode: string; at: number };
type BindingEntry = { binding: ConfirmedVisualAnchor; at: number };

const MAX_PENDING = 256;
const MAX_BINDINGS = 1024;
const MAX_TOMBSTONES = 512;
const PENDING_TTL_MS = 10 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 60 * 1000;

export class VisualAnchorRegistry {
    private sessionEpoch = "";
    private maxSequence = 0;
    private anchors = new Map<string, PendingAnchor & { at: number }>();
    private confirmations = new Map<string, PendingConfirmation>();
    private bindings = new Map<string, BindingEntry>();
    private rejected = new Map<string, number>();

    observeAnchor(anchor: VisualAnchorContext & { handle: VisualAnchorHandle }): boolean {
        this.prune();
        if (!this.isValidContext(anchor, false)) return false;
        if (this.rejected.has(anchor.anchorNonce)) return false;
        if (!this.acceptSequence(anchor)) {
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

    confirm(binding: VisualAnchorContext & { mode: string }): void {
        this.prune();
        if (!this.isValidContext(binding, true)) {
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
        this.reject(anchorNonce);
    }

    invalidate(): void {
        for (const nonce of this.anchors.keys()) this.reject(nonce);
        for (const nonce of this.confirmations.keys()) this.reject(nonce);
        for (const nonce of this.bindings.keys()) this.reject(nonce);
        for (const anchor of this.anchors.values()) anchor.handle.dispose();
        for (const entry of this.bindings.values()) entry.binding.handle.dispose();
        this.anchors.clear();
        this.confirmations.clear();
        this.bindings.clear();
        this.evictTombstones();
    }

    get(anchorNonce: string): ConfirmedVisualAnchor | undefined {
        this.prune();
        return this.bindings.get(anchorNonce)?.binding;
    }

    private isValidContext(context: VisualAnchorContext, requireCommandId: boolean): boolean {
        return (
            context.blockId !== "" &&
            context.sessionEpoch !== "" &&
            context.hookSequence > 0 &&
            (!requireCommandId || (typeof context.commandId === "string" && context.commandId !== "")) &&
            context.anchorNonce !== ""
        );
    }

    private matches(anchor: VisualAnchorContext, confirmation: VisualAnchorContext): boolean {
        return (
            anchor.blockId === confirmation.blockId &&
            anchor.sessionEpoch === confirmation.sessionEpoch &&
            anchor.hookSequence === confirmation.hookSequence &&
            (anchor.commandId == null || anchor.commandId === confirmation.commandId) &&
            (anchor.hostId == null || confirmation.hostId == null || anchor.hostId === confirmation.hostId) &&
            (anchor.runspaceId == null ||
                confirmation.runspaceId == null ||
                anchor.runspaceId === confirmation.runspaceId)
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
