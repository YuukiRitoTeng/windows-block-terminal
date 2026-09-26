// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Same-pane shell session transition, through the production seam.
 *
 * A pane can be replaced by a new shell session (trusted controller restart). Both input orders
 * must still bind under the existing exact identity: the confirmation-first order, and the
 * anchor-first order where the new session's B arrives while the registry is still locked to the
 * previous epoch. The new epoch may not take authority on its own, and the old session may not
 * come back.
 */

import { Terminal } from "@xterm/headless";
import type { IMarker } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { MaxQuarantinedAnchors, VisualAnchorRegistry } from "./visual-anchor";
import { TermWrap } from "./termwrap";

const BLOCK = "block-transition";
const NONCE_A = "nonce-A";
const NONCE_B = "nonce-B";

const context = (epoch: string, seq: number, nonce: string) => ({
    blockId: BLOCK,
    authority: "terminal-osc",
    sessionEpoch: epoch,
    hookSequence: seq,
    anchorNonce: nonce,
    mode: "",
});
const handle = () => ({ dispose: vi.fn() });
const confirmation = (epoch: string, seq: number, nonce: string) => ({
    ...context(epoch, seq, nonce),
    commandId: `cmd-${nonce}`,
});

function makeWrap() {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 6, scrollback: 20 });
    const wrap: TermWrap = Object.create(TermWrap.prototype);
    const internals = wrap as unknown as Record<string, unknown>;
    internals.terminal = term;
    internals.blockId = BLOCK;
    internals.ingressState = "live";
    internals.visualAnchorCues = new Map();
    internals.visualAnchorRegistry = new VisualAnchorRegistry();
    internals.commandAnchorSubscribers = new Set();
    internals.promptMarkers = [];
    internals.notifyCommandAnchorSubscribers = TermWrap.prototype["notifyCommandAnchorSubscribers"].bind(wrap);
    internals.registerConfirmedVisualCue = TermWrap.prototype["registerConfirmedVisualCue"].bind(wrap);
    internals.releasePresentationState = TermWrap.prototype["releasePresentationState"].bind(wrap);
    internals.confirmVisualAnchor = TermWrap.prototype["confirmVisualAnchor"].bind(wrap);
    internals.registerVisualAnchor = TermWrap.prototype["registerVisualAnchor"].bind(wrap);
    return { wrap, term, internals };
}

const register = (internals: Record<string, unknown>, epoch: string, seq: number, nonce: string) =>
    (internals.registerVisualAnchor as (data: unknown) => void)({ v: 1, epoch, seq, id: `cmd-${nonce}`, nonce, phase: "start" });
const confirm = (internals: Record<string, unknown>, epoch: string, seq: number, nonce: string) =>
    (internals.confirmVisualAnchor as (data: unknown) => void)(confirmation(epoch, seq, nonce));

describe("VisualAnchorRegistry session transition", () => {
    it("binds epoch A, then binds epoch B confirmation-first", () => {
        const registry = new VisualAnchorRegistry();
        registry.confirm(confirmation("epoch-A", 2, NONCE_A) as never);
        expect(registry.observeAnchor({ ...context("epoch-A", 2, NONCE_A), handle: handle() } as never)).toBe(true);
        registry.resetSessionForEpoch("epoch-B");
        registry.confirm(confirmation("epoch-B", 1, NONCE_B) as never);
        expect(registry.observeAnchor({ ...context("epoch-B", 1, NONCE_B), handle: handle() } as never)).toBe(true);
        expect(registry.get(NONCE_B)?.commandId).toBe(`cmd-${NONCE_B}`);
    });

    it("keeps an anchor-first new epoch binding after the trusted transition", () => {
        const registry = new VisualAnchorRegistry();
        registry.confirm(confirmation("epoch-A", 2, NONCE_A) as never);
        registry.observeAnchor({ ...context("epoch-A", 2, NONCE_A), handle: handle() } as never);
        // Anchor first: the new session's B arrives while epoch A is still the locked session.
        expect(registry.observeAnchor({ ...context("epoch-B", 1, NONCE_B), handle: handle() } as never)).toBe(false);
        expect(registry.get(NONCE_B)).toBeUndefined();
        // The trusted confirmation declares the transition; the earlier B is adopted, and the
        // confirmation that carried the transition completes the pairing.
        registry.resetSessionForEpoch("epoch-B");
        registry.confirm(confirmation("epoch-B", 1, NONCE_B) as never);
        expect(registry.get(NONCE_B)?.commandId).toBe(`cmd-${NONCE_B}`);
    });

    it("never revives the old session after the transition", () => {
        const registry = new VisualAnchorRegistry();
        registry.confirm(confirmation("epoch-A", 2, NONCE_A) as never);
        registry.observeAnchor({ ...context("epoch-A", 2, NONCE_A), handle: handle() } as never);
        registry.resetSessionForEpoch("epoch-B");
        registry.observeAnchor({ ...context("epoch-B", 1, NONCE_B), handle: handle() } as never);
        expect(registry.observeAnchor({ ...context("epoch-A", 5, "late-A"), handle: handle() } as never)).toBe(false);
        registry.confirm(confirmation("epoch-A", 6, "late-A") as never);
        expect(registry.get("late-A")).toBeUndefined();
    });

    it("keeps the same session across a visual clear", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor({ ...context("epoch-A", 3, "n1"), handle: handle() } as never);
        registry.invalidate();
        expect(registry.observeAnchor({ ...context("epoch-A", 5, "n2"), handle: handle() } as never)).toBe(true);
    });
});

describe("TermWrap production seam", () => {
    it("binds an anchor-first new session once the trusted confirmation arrives", () => {
        const { wrap, internals, term } = makeWrap();
        confirm(internals, "epoch-A", 2, NONCE_A);
        register(internals, "epoch-A", 2, NONCE_A);
        expect(wrap.getCommandAnchorSnapshot().map((a) => a.commandId)).toEqual([`cmd-${NONCE_A}`]);
        // Anchor first: the replaced session's B arrives while the registry is still locked to
        // epoch A, so it is parked and must not appear as a navigable anchor yet.
        register(internals, "epoch-B", 1, NONCE_B);
        expect(wrap.getCommandAnchorSnapshot().map((a) => a.commandId)).toEqual([`cmd-${NONCE_A}`]);
        // The trusted confirmation declares the transition. The parked B is adopted and the
        // confirmation that carried the transition completes the pairing on the new epoch.
        confirm(internals, "epoch-B", 1, NONCE_B);
        const snapshot = wrap.getCommandAnchorSnapshot();
        expect(snapshot.map((a) => a.commandId)).toContain(`cmd-${NONCE_B}`);
        const entry = snapshot.find((a) => a.commandId === `cmd-${NONCE_B}`);
        expect(entry?.sessionEpoch).toBe("epoch-B");
        expect(snapshot.map((a) => a.commandId)).not.toContain(`cmd-${NONCE_A}`);
        term.dispose();
    });

    it("still binds confirmation-first for the new session", () => {
        const { wrap, internals, term } = makeWrap();
        confirm(internals, "epoch-A", 2, NONCE_A);
        register(internals, "epoch-A", 2, NONCE_A);
        confirm(internals, "epoch-B", 1, NONCE_B);
        register(internals, "epoch-B", 1, NONCE_B);
        expect(wrap.getCommandAnchorSnapshot().map((a) => a.commandId)).toContain(`cmd-${NONCE_B}`);
        term.dispose();
    });
});

describe("TermWrap parked anchor lifecycle", () => {
    // The parked-anchor container is private by design; the regression reads only its size and
    // membership to prove the bound, through an explicit structural view of the real instance.
    const registryOf = (internals: Record<string, unknown>) => {
        const registry = internals.visualAnchorRegistry as unknown as {
            quarantined: Map<string, unknown>;
            get: (nonce: string) => { commandId: string } | undefined;
        };
        return registry;
    };
    const cueEntry = (internals: Record<string, unknown>, nonce: string) =>
        (internals.visualAnchorCues as Map<string, { marker: IMarker }>).get(nonce);

    it("releases the cue of every anchor the quarantine evicts, so the map stays bounded", () => {
        const { wrap, internals, term } = makeWrap();
        const anchorCount = MaxQuarantinedAnchors + 44;
        confirm(internals, "epoch-A", 2, NONCE_A);
        register(internals, "epoch-A", 2, NONCE_A);
        for (let i = 0; i < anchorCount; i++) {
            register(internals, "epoch-B", i + 1, `parked-${i}`);
            if (i === 0) {
                // A parked anchor carries no authority: it is not navigable before its transition.
                expect(wrap.getCommandAnchorSnapshot().map((a) => a.commandId)).toEqual([`cmd-${NONCE_A}`]);
            }
        }
        const cues = internals.visualAnchorCues as Map<string, { marker: { isDisposed: boolean } }>;
        const evicted = anchorCount - MaxQuarantinedAnchors;
        // The parked anchors are bounded, and every frame past that bound took its cue with it.
        expect(registryOf(internals).quarantined.size).toBe(MaxQuarantinedAnchors);
        expect(cues.size).toBe(MaxQuarantinedAnchors + 1);
        expect(registryOf(internals).quarantined.has("parked-0")).toBe(false);
        expect(registryOf(internals).get("parked-0")).toBeUndefined();
        expect(cues.has("parked-0")).toBe(false);
        expect(registryOf(internals).quarantined.has(`parked-${evicted - 1}`)).toBe(false);
        expect(cues.has(`parked-${evicted - 1}`)).toBe(false);
        // Every surviving cue still owns a live marker: none of them is a disposed leftover.
        for (const cue of cues.values()) {
            expect(cue.marker.isDisposed).toBe(false);
        }
        // The accepted epoch-A cue was never collateral damage.
        expect(cueEntry(internals, NONCE_A)?.marker.isDisposed).toBe(false);
        expect(wrap.getCommandAnchorSnapshot().map((a) => a.commandId)).toEqual([`cmd-${NONCE_A}`]);
        term.dispose();
    });

    it("adopts a parked anchor that outlived the eviction, and never revives the old session", () => {
        const { wrap, internals, term } = makeWrap();
        const anchorCount = MaxQuarantinedAnchors + 44;
        confirm(internals, "epoch-A", 2, NONCE_A);
        register(internals, "epoch-A", 2, NONCE_A);
        for (let i = 0; i < anchorCount; i++) {
            register(internals, "epoch-B", i + 1, `parked-${i}`);
        }
        const survivor = `parked-${anchorCount - 1}`;
        expect(cueEntry(internals, survivor)?.marker.isDisposed).toBe(false);
        // The trusted transition adopts the parked anchors the new epoch still holds and pairs the
        // one its confirmation names; the evicted frames are gone for good.
        confirm(internals, "epoch-B", anchorCount, survivor);
        const snapshot = wrap.getCommandAnchorSnapshot();
        expect(snapshot.map((a) => a.commandId)).toEqual([`cmd-${survivor}`]);
        expect(snapshot[0].sessionEpoch).toBe("epoch-B");
        expect(snapshot.map((a) => a.commandId)).not.toContain(`cmd-${NONCE_A}`);
        // A stale confirmation of the replaced session never binds - the evicted frame is gone for
        // good, so there is nothing left to revive it with.
        confirm(internals, "epoch-A", 100, "late-A");
        expect(wrap.getCommandAnchorSnapshot().map((a) => a.commandId)).not.toContain(`cmd-late-A`);
        expect(registryOf(internals).get("late-A")).toBeUndefined();
        term.dispose();
    });
});

describe("TermWrap parked anchor ownership", () => {
    const parkedMarkers = (internals: Record<string, unknown>) => {
        const registry = internals.visualAnchorRegistry as unknown as {
            quarantined: Map<string, { handle: unknown; commandId?: string }>;
        };
        return registry.quarantined;
    };
    const cueEntry = (internals: Record<string, unknown>, nonce: string) =>
        (internals.visualAnchorCues as Map<string, { marker: IMarker }>).get(nonce);

    it("disposes a repeated frame's marker instead of orphaning the parked one", () => {
        const { wrap, internals, term } = makeWrap();
        confirm(internals, "epoch-A", 2, NONCE_A);
        register(internals, "epoch-A", 2, NONCE_A);
        // Two frames carrying the same nonce while the session is still untrusted. The registry
        // parks one anchor per nonce, so only the first frame has a marker worth keeping.
        register(internals, "epoch-B", 1, "dup");
        const first = cueEntry(internals, "dup")!.marker;
        expect(first.isDisposed).toBe(false);
        register(internals, "epoch-B", 2, "dup");
        const second = cueEntry(internals, "dup")!.marker;
        // The cue still owns the first frame's marker, and the registry still points at it.
        expect(second).toBe(first);
        expect(first.isDisposed).toBe(false);
        expect(parkedMarkers(internals).get("dup")?.commandId).toBe("cmd-dup");
        // The repeat had nothing to park, so its marker was released on arrival. Disposing a live
        // marker after the terminal is gone would throw; this one is already disposed.
        term.dispose();
        expect(() => second.dispose()).not.toThrow();
        expect(first.isDisposed).toBe(true);

        // The frame the transition adopts is the one that was parked - on its own identity, once.
        const { wrap: wrap2, internals: internals2, term: term2 } = makeWrap();
        confirm(internals2, "epoch-A", 2, NONCE_A);
        register(internals2, "epoch-A", 2, NONCE_A);
        register(internals2, "epoch-B", 1, "dup");
        register(internals2, "epoch-B", 2, "dup");
        expect(wrap2.getCommandAnchorSnapshot().map((a) => a.commandId)).toEqual([`cmd-${NONCE_A}`]);
        confirm(internals2, "epoch-B", 1, "dup");
        const snapshot = wrap2.getCommandAnchorSnapshot();
        expect(snapshot.map((a) => a.commandId)).toEqual(["cmd-dup"]);
        expect(snapshot[0].sessionEpoch).toBe("epoch-B");
        expect(parkedMarkers(internals2).size).toBe(0);
        term2.dispose();
    });
});

describe("TermWrap parked anchors across a visual clear", () => {
    const parkedMarkers = (internals: Record<string, unknown>) => {
        const registry = internals.visualAnchorRegistry as unknown as {
            quarantined: Map<string, unknown>;
            rejected: Map<string, number>;
        };
        return registry;
    };
    const cueEntry = (internals: Record<string, unknown>, nonce: string) =>
        (internals.visualAnchorCues as Map<string, { marker: IMarker }>).get(nonce);
    const release = (internals: Record<string, unknown>) =>
        (internals.releasePresentationState as () => void)();

    it("drops a parked anchor with the buffer it pointed at, and leaves no tombstone behind", () => {
        const { internals, term } = makeWrap();
        confirm(internals, "epoch-A", 2, NONCE_A);
        register(internals, "epoch-A", 2, NONCE_A);
        // The replaced session's frame arrives while epoch A still owns the session: parked.
        register(internals, "epoch-B", 1, NONCE_B);
        expect(cueEntry(internals, NONCE_B)!.marker.isDisposed).toBe(false);
        expect(parkedMarkers(internals).quarantined.size).toBe(1);

        release(internals);

        // The clear took the buffer the parked frame pointed at, so the frame goes with it: no
        // entry for a later confirmation to adopt, and no cue left holding a dead marker.
        expect(parkedMarkers(internals).quarantined.size).toBe(0);
        expect(cueEntry(internals, NONCE_B)).toBeUndefined();
        // Its teardown must not leave a rejection that would make the nonce unbindable later: the
        // anchor was parked, never accepted, so nothing about it was ever rejected.
        expect(parkedMarkers(internals).rejected.has(NONCE_B)).toBe(false);

        // A trusted transition after the clear still pairs a freshly delivered frame normally.
        register(internals, "epoch-B", 1, NONCE_B);
        expect(cueEntry(internals, NONCE_B)).toBeDefined();
        confirm(internals, "epoch-B", 1, NONCE_B);
        const bound = (internals.visualAnchorRegistry as VisualAnchorRegistry).get(NONCE_B);
        expect(bound?.commandId).toBe(`cmd-${NONCE_B}`);
        expect(parkedMarkers(internals).quarantined.size).toBe(0);
        term.dispose();
    });

    it("keeps the shell session identity across the clear", () => {
        const { internals, term } = makeWrap();
        confirm(internals, "epoch-A", 2, NONCE_A);
        register(internals, "epoch-A", 2, NONCE_A);
        register(internals, "epoch-B", 1, NONCE_B);
        release(internals);
        // A same-session clear does not restart the shell: the lock and its sequence stay put.
        const registry = internals.visualAnchorRegistry as unknown as { sessionEpoch: string; maxSequence: number };
        expect(registry.sessionEpoch).toBe("epoch-A");
        expect(registry.maxSequence).toBe(2);
        term.dispose();
    });
});
