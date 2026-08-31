import { describe, expect, it, vi } from "vitest";
import { VisualAnchorRegistry, type VisualAnchorContext } from "./visual-anchor";

function anchor(nonce = "nonce-1"): VisualAnchorContext {
    return {
        blockId: "block-1",
        sessionEpoch: "epoch-1",
        hookSequence: 1,
        commandId: "command-1",
        anchorNonce: nonce,
        hostId: "host-1",
        runspaceId: "runspace-1",
    };
}

function confirmation(nonce = "nonce-1") {
    return { ...anchor(nonce), mode: "structured" };
}

describe("VisualAnchorRegistry", () => {
    it("binds anchor and confirmation in either order", () => {
        const registry = new VisualAnchorRegistry();
        const handle = { dispose: vi.fn() };
        registry.observeAnchor({ ...anchor(), handle });
        registry.confirm(confirmation());
        expect(registry.get("nonce-1")?.commandId).toBe("command-1");

        const reverse = new VisualAnchorRegistry();
        reverse.confirm(confirmation());
        reverse.observeAnchor({ ...anchor(), handle: { dispose: vi.fn() } });
        expect(reverse.get("nonce-1")?.commandId).toBe("command-1");
    });

    it("rejects mismatched context and replay", () => {
        const registry = new VisualAnchorRegistry();
        const handle = { dispose: vi.fn() };
        registry.observeAnchor({ ...anchor(), handle });
        registry.confirm({ ...confirmation(), sessionEpoch: "other-epoch" });
        expect(registry.get("nonce-1")).toBeUndefined();
        registry.confirm(confirmation());
        expect(registry.get("nonce-1")).toBeUndefined();

        const wrongNonce = new VisualAnchorRegistry();
        wrongNonce.observeAnchor({ ...anchor(), handle: { dispose: vi.fn() } });
        wrongNonce.confirm(confirmation("other"));
        expect(wrongNonce.get("nonce-1")).toBeUndefined();
    });

    it("removes markers and invalidates all bindings", () => {
        const registry = new VisualAnchorRegistry();
        const handle = { dispose: vi.fn() };
        registry.observeAnchor({ ...anchor(), handle });
        registry.confirm(confirmation());
        registry.remove("nonce-1");
        expect(registry.get("nonce-1")).toBeUndefined();
        registry.observeAnchor({ ...anchor("nonce-2"), handle });
        registry.confirm(confirmation("nonce-2"));
        expect(registry.get("nonce-2")?.commandId).toBe("command-1");

        registry.invalidate();
        expect(handle.dispose).toHaveBeenCalled();
        registry.observeAnchor({ ...anchor("nonce-1"), handle: { dispose: vi.fn() } });
        registry.confirm(confirmation("nonce-1"));
        expect(registry.get("nonce-1")).toBeUndefined();
    });
});
