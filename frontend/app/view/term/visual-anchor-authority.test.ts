// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict visual-anchor isolation in the renderer.
 *
 * Both producers write their marks into the same terminal stream, so the renderer
 * decides which producer a mark belongs to from the identity the mark claims -
 * exactly as the Go anchor registry does. The pairing is then strict in both
 * directions: an in-band terminal mark can never be bound by a hosted
 * confirmation, the hosted runtime's mark can never be bound by an in-band
 * confirmation, and anything missing fails closed.
 */

import { authorityForMark, isKnownAuthority, VisualAnchorRegistry, type VisualAnchorContext } from "@/app/view/term/visual-anchor";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const termwrapSource = readFileSync(new URL("./termwrap.ts", import.meta.url), "utf8");

function terminalMark(nonce: string, extra: Partial<VisualAnchorContext> = {}): VisualAnchorContext {
    return {
        blockId: "block-1",
        authority: "terminal-osc",
        sessionEpoch: "epoch-1",
        hookSequence: 1,
        commandId: "command-1",
        anchorNonce: nonce,
        ...extra,
    };
}

function hostedMark(nonce: string, hostId = "host-1", runspaceId = "runspace-1"): VisualAnchorContext {
    return {
        blockId: "block-1",
        authority: "hosted-sidechannel",
        sessionEpoch: "epoch-1",
        hookSequence: 1,
        commandId: "command-1",
        anchorNonce: nonce,
        hostId,
        runspaceId,
    };
}

const hostedConfirmation = (nonce: string, hostId = "host-1", runspaceId = "runspace-1") => ({
    ...hostedMark(nonce, hostId, runspaceId),
    mode: "structured",
});

const terminalConfirmation = (nonce: string) => ({ ...terminalMark(nonce), mode: "unknown" });

describe("visual anchor authority derivation", () => {
    it("reads the authority from the mark's own identity claim", () => {
        expect(authorityForMark("host-1", "runspace-1")).toEqual({
            authority: "hosted-sidechannel",
            hostId: "host-1",
            runspaceId: "runspace-1",
        });
        expect(authorityForMark(undefined, undefined)).toEqual({ authority: "terminal-osc" });
        expect(authorityForMark("", "")).toEqual({ authority: "terminal-osc" });
    });

    it("treats an incomplete identity claim as a terminal mark", () => {
        // A single id is not a hosted mark; it must not become a hosted anchor.
        expect(authorityForMark("host-1", undefined)).toEqual({ authority: "terminal-osc" });
        expect(authorityForMark(undefined, "runspace-1")).toEqual({ authority: "terminal-osc" });
        expect(authorityForMark("host-1", "")).toEqual({ authority: "terminal-osc" });
    });

    it("is what the production mark path uses", () => {
        // The renderer must derive the claim for every mark it observes; leaving the
        // authority unset is what allowed a hosted confirmation to pair with a
        // terminal mark.
        expect(termwrapSource).toContain("const mark = authorityForMark(");
        expect(termwrapSource).toContain("authority: mark.authority,");
        expect(termwrapSource).not.toMatch(/authority:\s*typeof data\.authority/);
    });
});

describe("visual anchor cross-authority isolation", () => {
    it("never binds a terminal mark with a hosted confirmation, in either order", () => {
        const confirmationFirst = new VisualAnchorRegistry();
        confirmationFirst.confirm(hostedConfirmation("nonce-1"));
        confirmationFirst.observeAnchor({ ...terminalMark("nonce-1"), handle: { dispose: vi.fn() } });
        expect(confirmationFirst.get("nonce-1")).toBeUndefined();

        const markFirst = new VisualAnchorRegistry();
        const handle = { dispose: vi.fn() };
        markFirst.observeAnchor({ ...terminalMark("nonce-2"), handle });
        markFirst.confirm(hostedConfirmation("nonce-2"));
        expect(markFirst.get("nonce-2")).toBeUndefined();
        expect(handle.dispose).toHaveBeenCalled();
    });

    it("never binds a hosted mark with an in-band confirmation, in either order", () => {
        const confirmationFirst = new VisualAnchorRegistry();
        confirmationFirst.confirm(terminalConfirmation("nonce-3"));
        confirmationFirst.observeAnchor({ ...hostedMark("nonce-3"), handle: { dispose: vi.fn() } });
        expect(confirmationFirst.get("nonce-3")).toBeUndefined();

        const markFirst = new VisualAnchorRegistry();
        markFirst.observeAnchor({ ...hostedMark("nonce-4"), handle: { dispose: vi.fn() } });
        markFirst.confirm(terminalConfirmation("nonce-4"));
        expect(markFirst.get("nonce-4")).toBeUndefined();
    });

    it("requires a hosted pair to name the same process and runspace", () => {
        const missingRunspace = new VisualAnchorRegistry();
        missingRunspace.observeAnchor({
            ...hostedMark("nonce-5"),
            runspaceId: undefined,
            handle: { dispose: vi.fn() },
        });
        missingRunspace.confirm(hostedConfirmation("nonce-5"));
        expect(missingRunspace.get("nonce-5")).toBeUndefined();

        const otherHost = new VisualAnchorRegistry();
        otherHost.observeAnchor({ ...hostedMark("nonce-6"), handle: { dispose: vi.fn() } });
        otherHost.confirm(hostedConfirmation("nonce-6", "host-2", "runspace-1"));
        expect(otherHost.get("nonce-6")).toBeUndefined();

        // A hosted confirmation without identity cannot bind a hosted mark either.
        const anonymous = new VisualAnchorRegistry();
        anonymous.observeAnchor({ ...hostedMark("nonce-7"), handle: { dispose: vi.fn() } });
        anonymous.confirm({ ...hostedConfirmation("nonce-7"), hostId: undefined, runspaceId: undefined });
        expect(anonymous.get("nonce-7")).toBeUndefined();
    });

    it("refuses hosted identity on an in-band pairing", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor({ ...terminalMark("nonce-8"), handle: { dispose: vi.fn() } });
        registry.confirm({ ...terminalConfirmation("nonce-8"), hostId: "host-1", runspaceId: "runspace-1" });
        expect(registry.get("nonce-8")).toBeUndefined();
    });

    it("refuses a context without a known authority", () => {
        const mark = new VisualAnchorRegistry();
        // Production disposes the marker when the registry refuses it (registerVisualAnchor
        // disposes on a false result), so this only has to prove nothing was stored.
        mark.observeAnchor({ ...terminalMark("nonce-9"), authority: undefined as unknown as string, handle: { dispose: vi.fn() } });
        mark.confirm(terminalConfirmation("nonce-9"));
        expect(mark.get("nonce-9")).toBeUndefined();

        const unknown = new VisualAnchorRegistry();
        unknown.observeAnchor({ ...terminalMark("nonce-10"), authority: "structured", handle: { dispose: vi.fn() } });
        unknown.confirm({ ...terminalConfirmation("nonce-10"), authority: "structured" });
        expect(unknown.get("nonce-10")).toBeUndefined();

        const confirmation = new VisualAnchorRegistry();
        confirmation.observeAnchor({ ...terminalMark("nonce-11"), handle: { dispose: vi.fn() } });
        confirmation.confirm({ ...terminalConfirmation("nonce-11"), authority: "" });
        expect(confirmation.get("nonce-11")).toBeUndefined();
    });

    it("still binds each authority's own mark", () => {
        const terminal = new VisualAnchorRegistry();
        terminal.observeAnchor({ ...terminalMark("nonce-12"), handle: { dispose: vi.fn() } });
        terminal.confirm(terminalConfirmation("nonce-12"));
        expect(terminal.get("nonce-12")?.authority).toBe("terminal-osc");
        expect(terminal.get("nonce-12")?.hostId).toBeUndefined();

        const hosted = new VisualAnchorRegistry();
        hosted.observeAnchor({ ...hostedMark("nonce-13"), handle: { dispose: vi.fn() } });
        hosted.confirm(hostedConfirmation("nonce-13"));
        expect(hosted.get("nonce-13")?.authority).toBe("hosted-sidechannel");
        expect(hosted.get("nonce-13")?.hostId).toBe("host-1");
    });

    it("keeps the authority names explicit", () => {
        expect(isKnownAuthority("terminal-osc")).toBe(true);
        expect(isKnownAuthority("hosted-sidechannel")).toBe(true);
        expect(isKnownAuthority(undefined)).toBe(false);
    });
});
