// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Copy All safety is one decision, not two.
 *
 * A readable terminal region only decides which authoritative source the text comes from. It must
 * never bypass the record's fail-closed gate, and the button enablement must be the same decision
 * the copy path applies.
 */

import { describe, expect, it, vi } from "vitest";
import { canCopyRecordOutput, copyCommandAndOutput } from "./command-copy-all";
import { VisualAnchorRegistry } from "./visual-anchor";

const SAFE_TERMINAL = {
    id: "cmd-1",
    authority: "terminal-osc",
    state: "finished",
    output_state: "closed",
    output_truncated: false,
    output_stored_bytes: 12,
    execution_mode: "unknown",
    command: "echo x",
};

const UNSAFE_TERMINAL = {
    ...SAFE_TERMINAL,
    execution_mode: "interactive",
    output_state: "pending",
    output_truncated: true,
};

const readableRegion = () => "visible";

describe("terminal-osc copy safety", () => {
    it("fails closed for an unsafe record even when the region is readable", async () => {
        const writeText = vi.fn(async () => {});
        expect(canCopyRecordOutput(UNSAFE_TERMINAL as never, readableRegion)).toBe(false);
        const result = await copyCommandAndOutput(UNSAFE_TERMINAL as never, undefined as never, { writeText } as never, readableRegion);
        expect(result.ok).toBe(false);
        expect(writeText).not.toHaveBeenCalled();
    });

    it("fails closed for an unsafe record when the region is not readable either", async () => {
        const writeText = vi.fn(async () => {});
        const result = await copyCommandAndOutput(UNSAFE_TERMINAL as never, undefined as never, { writeText } as never, () => undefined);
        expect(result.ok).toBe(false);
        expect(writeText).not.toHaveBeenCalled();
    });

    it("still copies a safe terminal-osc record from its region", async () => {
        const writeText = vi.fn(async () => {});
        expect(canCopyRecordOutput(SAFE_TERMINAL as never, readableRegion)).toBe(true);
        const result = await copyCommandAndOutput(SAFE_TERMINAL as never, undefined as never, { writeText } as never, readableRegion);
        expect(result.ok).toBe(true);
        expect(writeText).toHaveBeenCalledWith("echo x\nvisible");
    });

    it("keeps the Journal-authority path unchanged", async () => {
        const record = { ...SAFE_TERMINAL, authority: "journal" };
        expect(canCopyRecordOutput(record as never, readableRegion)).toBe(false);
    });
});

describe("same-pane shell session transition", () => {
    const anchorAt = (epoch: string, seq: number, nonce: string) => ({
        blockId: "b",
        authority: "terminal-osc",
        sessionEpoch: epoch,
        hookSequence: seq,
        anchorNonce: nonce,
        mode: "",
        handle: { dispose: vi.fn() },
    });

    it("accepts the new epoch at sequence 1 after a trusted transition", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor(anchorAt("epoch-A", 9, "nonce-A") as never);
        // The trusted confirmation of a new session declares the transition.
        registry.resetSessionForEpoch("epoch-B");
        expect(registry.observeAnchor(anchorAt("epoch-B", 1, "nonce-B") as never)).toBe(true);
    });

    it("does not let a late old-session anchor pull the registry back to the old epoch", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor(anchorAt("epoch-A", 9, "nonce-A") as never);
        registry.resetSessionForEpoch("epoch-B");
        expect(registry.observeAnchor(anchorAt("epoch-B", 1, "nonce-B") as never)).toBe(true);
        // A late event from the previous shell must fail closed, never re-open epoch-A.
        expect(registry.observeAnchor(anchorAt("epoch-A", 10, "nonce-A2") as never)).toBe(false);
    });

    it("keeps the shell session identity across a visual clear (invalidate)", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor(anchorAt("epoch-A", 3, "nonce-1") as never);
        registry.invalidate();
        // clearVisualBuffer only clears the visual projection: the same session continues, so a
        // later anchor of the same epoch is still accepted.
        expect(registry.observeAnchor(anchorAt("epoch-A", 5, "nonce-2") as never)).toBe(true);
    });

    it("rejects a transition that is not a real epoch change", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor(anchorAt("epoch-A", 3, "nonce-1") as never);
        registry.resetSessionForEpoch("epoch-A");
        // The lock is untouched, so a lower sequence of the same epoch stays rejected.
        expect(registry.observeAnchor(anchorAt("epoch-A", 1, "nonce-3") as never)).toBe(false);
    });
});