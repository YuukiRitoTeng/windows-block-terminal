// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Command authority in the renderer.
 *
 * The authority of a confirmed command is an explicit claim by its producer
 * ("terminal-osc" for the in-band shell integration, "hosted-sidechannel" for
 * the authenticated hosted runtime). It used to be inferred from
 * `execution_mode === "structured"`, which conflated the lifecycle of a command
 * with the authority that owns its identity - a terminal integration that
 * reports a structured command, or a hosted interactive program, were both
 * classified wrongly by that test.
 */

import { isKnownAuthority, KnownCommandAuthorities, VisualAnchorRegistry } from "@/app/view/term/visual-anchor";
import { readFile } from "fs/promises";
import { join } from "path";
import { assert, beforeAll, describe, test } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");

function anchorContext(nonce: string, extra: Record<string, unknown> = {}) {
    return {
        blockId: "block-1",
        // The in-band integration's mark: it never carries hosted identity.
        authority: "terminal-osc",
        sessionEpoch: "epoch-1",
        hookSequence: 1,
        anchorNonce: nonce,
        handle: { dispose: () => {} },
        ...extra,
    };
}

function confirmation(nonce: string, extra: Record<string, unknown> = {}) {
    return {
        blockId: "block-1",
        sessionEpoch: "epoch-1",
        hookSequence: 1,
        commandId: "command-1",
        anchorNonce: nonce,
        authority: "terminal-osc",
        mode: "structured",
        ...extra,
    };
}

describe("command authority: the names", () => {
    test("only the two producers are authorities", () => {
        assert.deepEqual([...KnownCommandAuthorities], ["terminal-osc", "hosted-sidechannel"]);
        assert.isTrue(isKnownAuthority("terminal-osc"));
        assert.isTrue(isKnownAuthority("hosted-sidechannel"));
    });

    test("nothing else is an authority", () => {
        assert.isFalse(isKnownAuthority(undefined), "an absent claim is not an authority");
        assert.isFalse(isKnownAuthority(""), "an empty claim is not an authority");
        assert.isFalse(isKnownAuthority("structured"), "a lifecycle mode is not an authority");
        assert.isFalse(isKnownAuthority("hosted"), "an abbreviation is not an authority");
    });
});

describe("command authority: binding", () => {
    test("a confirmation without an authority never binds", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor(anchorContext("nonce-1"));
        registry.confirm(confirmation("nonce-1", { authority: undefined }) as any);
        assert.isUndefined(registry.get("nonce-1"), "identity cannot come from an unclaimed authority");
    });

    test("a lifecycle mode is not an authority", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor(anchorContext("nonce-2"));
        registry.confirm(confirmation("nonce-2", { authority: undefined, mode: "structured" }) as any);
        assert.isUndefined(registry.get("nonce-2"), "mode must not stand in for authority");
    });

    test("either authority binds its own mark, whatever the lifecycle mode", () => {
        for (const [authority, mode] of [
            ["terminal-osc", "structured"],
            ["terminal-osc", "unknown"],
            ["hosted-sidechannel", "structured"],
            ["hosted-sidechannel", "interactive"],
        ] as const) {
            const nonce = `nonce-${authority}-${mode}`;
            const registry = new VisualAnchorRegistry();
            // A hosted mark names its process and runspace; a terminal mark names nothing.
            const identity =
                authority === "hosted-sidechannel" ? { hostId: "host-1", runspaceId: "runspace-1" } : {};
            registry.observeAnchor(anchorContext(nonce, { authority, ...identity }));
            registry.confirm(confirmation(nonce, { authority, mode, ...identity }));
            const bound = registry.get(nonce);
            assert.isDefined(bound, `${authority}/${mode} must bind`);
            assert.strictEqual(bound.authority, authority);
            assert.strictEqual(bound.mode, mode, "the mode is still reported to the caller");
        }
    });

    test("an anchor that claims an authority only binds that authority", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor(anchorContext("nonce-3", { authority: "terminal-osc" }));
        registry.confirm(confirmation("nonce-3", { authority: "hosted-sidechannel" }));
        assert.isUndefined(registry.get("nonce-3"), "authority mismatch must not bind");
    });

    test("an in-band confirmation needs no host or runspace identity", () => {
        const registry = new VisualAnchorRegistry();
        registry.observeAnchor(anchorContext("nonce-4"));
        registry.confirm(confirmation("nonce-4", { authority: "terminal-osc", mode: "unknown", hostId: undefined, runspaceId: undefined }));
        const bound = registry.get("nonce-4");
        assert.isDefined(bound, "the in-band authority has no hostId/runspaceId to offer");
        assert.strictEqual(bound.authority, "terminal-osc");
    });
});

describe("command authority: the wiring", () => {
    let termwrap: string;
    let rail: string;

    beforeAll(async () => {
        termwrap = await readSource("frontend/app/view/term/termwrap.ts");
        rail = await readSource("frontend/app/view/term/command-navigation-rail.tsx");
    });

    test("the terminal gates anchored commands on the authority, not the mode", () => {
        assert.notMatch(termwrap, /mode === "structured"/, "the mode is not an authority");
        assert.notMatch(termwrap, /mode !== "structured"/, "the mode is not an authority");
        assert.match(termwrap, /import \{ authorityForMark, isKnownAuthority, VisualAnchorRegistry \} from "\.\/visual-anchor"/);
        // The production mark path derives the authority from the mark itself, exactly as
        // the Go registry does, instead of leaving it unset.
        assert.match(termwrap, /const mark = authorityForMark\(/);
        assert.match(termwrap, /authority: mark\.authority,/);
        const gates = termwrap.match(/isKnownAuthority\(/g) ?? [];
        assert.isAtLeast(gates.length, 4, "every anchored-command gate asks for the authority");
        assert.notMatch(
            termwrap,
            /!hostId \|\|\s*!runspaceId \|\|\s*!mode/,
            "an in-band confirmation has no hostId/runspaceId to require"
        );
    });

    test("the rail requires a confirmed authority on the record", () => {
        assert.notMatch(rail, /execution_mode === "structured"/, "the rail must not infer authority from the mode");
        // The listed identity is the record the journal owns; the visual anchor only
        // positions the terminal, so a cleared buffer cannot empty the rail.
        assert.match(rail, /isKnownAuthority\(record\.authority\)/);
        assert.match(rail, /record\.session_epoch === sessionEpoch/);
        assert.notMatch(rail, /const entries = matched\.map/, "entries must not come from anchors alone");
    });
});
