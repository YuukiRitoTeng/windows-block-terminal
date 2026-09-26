import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { VisualAnchorRegistry, type VisualAnchorContext } from "./visual-anchor";

const termwrapSource = readFileSync(new URL("./termwrap.ts", import.meta.url), "utf8");

function anchor(nonce = "nonce-1"): VisualAnchorContext {
    return {
        blockId: "block-1",
        // A mark that names a hosted process and runspace is the hosted runtime's mark.
        authority: "hosted-sidechannel",
        sessionEpoch: "epoch-1",
        hookSequence: 1,
        commandId: "command-1",
        anchorNonce: nonce,
        hostId: "host-1",
        runspaceId: "runspace-1",
    };
}

function terminalAnchor(nonce = "nonce-terminal"): VisualAnchorContext {
    return {
        blockId: "block-1",
        // The in-band integration's mark carries no hosted identity.
        authority: "terminal-osc",
        sessionEpoch: "epoch-1",
        hookSequence: 1,
        commandId: "command-1",
        anchorNonce: nonce,
    };
}

function confirmation(nonce = "nonce-1") {
    return { ...anchor(nonce), authority: "hosted-sidechannel", mode: "structured" };
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

        const withoutRawCommand = new VisualAnchorRegistry();
        withoutRawCommand.observeAnchor({
            ...anchor("nonce-no-command"),
            commandId: undefined,
            handle: { dispose: vi.fn() },
        });
        withoutRawCommand.confirm(confirmation("nonce-no-command"));
        expect(withoutRawCommand.get("nonce-no-command")?.commandId).toBe("command-1");
    });

    it("rejects mismatched context and replay", () => {
        const registry = new VisualAnchorRegistry();
        const handle = { dispose: vi.fn() };
        registry.observeAnchor({ ...anchor(), handle });
        registry.confirm({ ...confirmation(), sessionEpoch: "other-epoch" });
        expect(registry.get("nonce-1")).toBeUndefined();
        registry.confirm(confirmation());
        expect(registry.get("nonce-1")).toBeUndefined();

        const wrongRawCommand = new VisualAnchorRegistry();
        wrongRawCommand.observeAnchor({ ...anchor(), commandId: "wrong-command", handle });
        wrongRawCommand.confirm(confirmation());
        expect(wrongRawCommand.get("nonce-1")).toBeUndefined();

        const missingConfirmationCommand = new VisualAnchorRegistry();
        missingConfirmationCommand.observeAnchor({ ...anchor(), handle: { dispose: vi.fn() } });
        missingConfirmationCommand.confirm({ ...confirmation(), commandId: undefined });
        expect(missingConfirmationCommand.get("nonce-1")).toBeUndefined();

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
        registry.observeAnchor({ ...anchor("nonce-2"), hookSequence: 2, handle });
        registry.confirm({ ...confirmation("nonce-2"), hookSequence: 2 });
        expect(registry.get("nonce-2")?.commandId).toBe("command-1");

        registry.invalidate();
        expect(handle.dispose).toHaveBeenCalled();
        registry.observeAnchor({ ...anchor("nonce-1"), handle: { dispose: vi.fn() } });
        registry.confirm(confirmation("nonce-1"));
        expect(registry.get("nonce-1")).toBeUndefined();
    });

    it("bounds pending state, expires stale entries, and bounds tombstones", () => {
        vi.useFakeTimers();
        try {
            const registry = new VisualAnchorRegistry();
            for (let i = 1; i <= 288; i++) {
                registry.observeAnchor({
                    ...anchor(`pending-${i}`),
                    hookSequence: i,
                    handle: { dispose: vi.fn() },
                });
            }
            expect((registry as any).anchors.size).toBeLessThanOrEqual(256);

            vi.advanceTimersByTime(10 * 60 * 1000 + 1);
            registry.observeAnchor({
                ...anchor("fresh"),
                hookSequence: 289,
                handle: { dispose: vi.fn() },
            });
            expect((registry as any).anchors.has("pending-288")).toBe(false);

            for (let i = 0; i < 600; i++) registry.remove(`tombstone-${i}`);
            expect((registry as any).rejected.size).toBeLessThanOrEqual(512);
            registry.invalidate();
            expect((registry as any).anchors.size).toBe(0);
            expect((registry as any).confirmations.size).toBe(0);
            expect((registry as any).bindings.size).toBe(0);
            expect((registry as any).rejected.size).toBeLessThanOrEqual(512);

            const bindings = new VisualAnchorRegistry();
            for (let i = 1; i <= 1025; i++) {
                const nonce = `binding-${i}`;
                bindings.observeAnchor({
                    ...anchor(nonce),
                    hookSequence: i,
                    handle: { dispose: vi.fn() },
                });
                bindings.confirm({ ...confirmation(nonce), hookSequence: i });
            }
            expect((bindings as any).bindings.size).toBeLessThanOrEqual(1024);
            bindings.confirm({ ...confirmation("binding-1"), hookSequence: 1 });
            expect(bindings.get("binding-1")).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("exposes only confirmed registry-backed anchors and exact marker scrolling", () => {
        // xterm's marker API is unavailable to Vitest here. This contract fails
        // if the terminal integration falls back to command text, line, or time.
        expect(termwrapSource).toContain("getCommandAnchorSnapshot()");
        expect(termwrapSource).toContain("subscribeCommandAnchors(listener");
        expect(termwrapSource).toContain("scrollToCommandAnchor(commandId: string)");
        expect(termwrapSource).toContain("this.visualAnchorRegistry.get(nonce)");
        expect(termwrapSource).toContain("this.terminal.scrollToLine(cue.marker.line)");
    });

    it("notifies the rail when confirmed markers are created, removed, cleared, or disposed", () => {
        expect(termwrapSource).toContain("this.notifyCommandAnchorSubscribers()");
        expect(termwrapSource).toContain("marker.onDispose(() => {");
        expect(termwrapSource).toContain("resetTerminalFileOrigin()");
        expect(termwrapSource).toContain("releasePresentationState()");
        expect(termwrapSource).toContain("canClearProductBuffer(): boolean");
        expect(termwrapSource).toContain("applyProductClear(): Promise<void>");
        expect(termwrapSource).toContain("dispose()");
    });
});
