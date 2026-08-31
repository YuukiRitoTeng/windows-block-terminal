export type VisualAnchorContext = {
    blockId: string;
    sessionEpoch: string;
    hookSequence: number;
    commandId: string;
    anchorNonce: string;
    hostId?: string;
    runspaceId?: string;
};

export type VisualAnchorHandle = {
    dispose: () => void;
};

export type ConfirmedVisualAnchor = VisualAnchorContext & {
    mode: string;
    handle: VisualAnchorHandle;
};

type PendingAnchor = VisualAnchorContext & { handle: VisualAnchorHandle };

export class VisualAnchorRegistry {
    private anchors = new Map<string, PendingAnchor>();
    private confirmations = new Map<string, VisualAnchorContext & { mode: string }>();
    private bindings = new Map<string, ConfirmedVisualAnchor>();
    private rejected = new Set<string>();

    observeAnchor(anchor: VisualAnchorContext & { handle: VisualAnchorHandle }): boolean {
        if (!this.isValidContext(anchor) || this.rejected.has(anchor.anchorNonce)) return false;
        if (this.bindings.has(anchor.anchorNonce) || this.anchors.has(anchor.anchorNonce)) return false;
        const confirmation = this.confirmations.get(anchor.anchorNonce);
        if (confirmation) {
            if (!this.matches(anchor, confirmation)) {
                this.rejected.add(anchor.anchorNonce);
                this.confirmations.delete(anchor.anchorNonce);
                return false;
            }
            this.confirmations.delete(anchor.anchorNonce);
            this.bindings.set(anchor.anchorNonce, { ...anchor, ...confirmation, handle: anchor.handle });
            return true;
        }
        this.anchors.set(anchor.anchorNonce, anchor);
        return true;
    }

    confirm(binding: VisualAnchorContext & { mode: string }): void {
        if (!this.isValidContext(binding) || this.rejected.has(binding.anchorNonce)) return;
        if (this.bindings.has(binding.anchorNonce)) return;
        const anchor = this.anchors.get(binding.anchorNonce);
        if (anchor) {
            if (!this.matches(anchor, binding)) {
                this.rejected.add(binding.anchorNonce);
                this.anchors.delete(binding.anchorNonce);
                anchor.handle.dispose();
                return;
            }
            this.anchors.delete(binding.anchorNonce);
            this.bindings.set(binding.anchorNonce, { ...anchor, ...binding });
            return;
        }
        if (this.confirmations.has(binding.anchorNonce)) return;
        this.confirmations.set(binding.anchorNonce, binding);
    }

    remove(anchorNonce: string): void {
        if (anchorNonce === "") return;
        this.anchors.delete(anchorNonce);
        this.bindings.delete(anchorNonce);
        this.confirmations.delete(anchorNonce);
        this.rejected.add(anchorNonce);
    }

    invalidate(): void {
        for (const nonce of this.anchors.keys()) this.rejected.add(nonce);
        for (const nonce of this.confirmations.keys()) this.rejected.add(nonce);
        for (const nonce of this.bindings.keys()) this.rejected.add(nonce);
        for (const anchor of this.anchors.values()) anchor.handle.dispose();
        for (const binding of this.bindings.values()) binding.handle.dispose();
        this.anchors.clear();
        this.confirmations.clear();
        this.bindings.clear();
    }

    get(anchorNonce: string): ConfirmedVisualAnchor | undefined {
        return this.bindings.get(anchorNonce);
    }

    private isValidContext(context: VisualAnchorContext): boolean {
        return (
            context.blockId !== "" &&
            context.sessionEpoch !== "" &&
            context.hookSequence > 0 &&
            context.commandId !== "" &&
            context.anchorNonce !== ""
        );
    }

    private matches(anchor: VisualAnchorContext, confirmation: VisualAnchorContext): boolean {
        return (
            anchor.blockId === confirmation.blockId &&
            anchor.sessionEpoch === confirmation.sessionEpoch &&
            anchor.hookSequence === confirmation.hookSequence &&
            anchor.commandId === confirmation.commandId &&
            (anchor.hostId == null || confirmation.hostId == null || anchor.hostId === confirmation.hostId) &&
            (anchor.runspaceId == null ||
                confirmation.runspaceId == null ||
                anchor.runspaceId === confirmation.runspaceId)
        );
    }
}
