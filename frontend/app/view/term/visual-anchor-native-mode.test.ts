// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A native (terminal-osc) confirmation carries no execution mode. Identity is the causal tuple
 * blockId + sessionEpoch + hookSequence + commandId + anchorNonce + authority, so a confirmation
 * without a mode must still be accepted and must still pair with its anchor - in either order.
 */

import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { VisualAnchorRegistry } from "./visual-anchor";
import { TermWrap } from "./termwrap";

const BLOCK = "block-native-mode";
const EPOCH = "epoch-native-1";
const NONCE = "nonce-native-1";
const COMMAND = "cmd-native-1";

function confirmation() {
    return {
        blockId: BLOCK,
        authority: "terminal-osc",
        sessionEpoch: EPOCH,
        hookSequence: 3,
        commandId: COMMAND,
        anchorNonce: NONCE,
        mode: "",
    };
}

function anchorContext() {
    return { blockId: BLOCK, authority: "terminal-osc", sessionEpoch: EPOCH, hookSequence: 3, anchorNonce: NONCE, mode: "" };
}

describe("native confirmation without a mode", () => {
    it("binds when the confirmation arrives without a mode (regression)", () => {
        const registry = new VisualAnchorRegistry();
        registry.confirm(confirmation() as never);
        const accepted = registry.observeAnchor({ ...anchorContext(), handle: { dispose: vi.fn() } } as never);
        expect(accepted).toBe(true);
        expect(registry.get(NONCE)).not.toBeNull();
        expect(registry.get(NONCE)?.commandId).toBe(COMMAND);
    });

    it("binds when the anchor arrives first and the confirmation follows", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor({ ...anchorContext(), handle: { dispose: vi.fn() } } as never);
        registry.confirm(confirmation() as never);
        expect(registry.get(NONCE)?.commandId).toBe(COMMAND);
    });

    it("still rejects a confirmation whose identity is incomplete", () => {
        const registry = new VisualAnchorRegistry();
        registry.confirm({ ...confirmation(), commandId: "" } as never);
        expect(registry.get(NONCE)).toBeFalsy();
    });
});

describe("TermWrap accepts a native confirmation and pairs it with the later B frame", () => {
    it("produces a snapshot entry for the exact command id", () => {
        const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 6, scrollback: 20 });
        const wrap: TermWrap = Object.create(TermWrap.prototype);
        const internals = wrap as unknown as Record<string, unknown>;
        internals.terminal = term;
        internals.blockId = BLOCK;
        internals.ingressState = "live";
        internals.visualAnchorCues = new Map();
        internals.visualAnchorRegistry = new VisualAnchorRegistry();
        internals.commandAnchorSubscribers = new Set();
        internals.notifyCommandAnchorSubscribers = TermWrap.prototype["notifyCommandAnchorSubscribers"].bind(wrap);
        internals.confirmVisualAnchor = TermWrap.prototype["confirmVisualAnchor"].bind(wrap);
        internals.registerVisualAnchor = TermWrap.prototype["registerVisualAnchor"].bind(wrap);

        (internals.confirmVisualAnchor as (data: unknown) => void)(confirmation());
        (internals.registerVisualAnchor as (data: unknown) => void)({ v: 1, epoch: EPOCH, seq: 3, id: COMMAND, nonce: NONCE, phase: "start" });

        const snapshot = wrap.getCommandAnchorSnapshot();
        expect(snapshot.map((entry) => entry.commandId)).toEqual([COMMAND]);
        expect(snapshot[0].sessionEpoch).toBe(EPOCH);
        term.dispose();
    });
});
