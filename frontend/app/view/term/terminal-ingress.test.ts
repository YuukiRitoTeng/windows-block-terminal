import { describe, expect, it } from "vitest";

import { drainTerminalIngress, trimTerminalIngressPrefix, type TerminalIngressChunk } from "./terminal-ingress";
import { VisualAnchorRegistry } from "./visual-anchor";

function bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

describe("terminal ingress initialization", () => {
    it("trims the initial snapshot prefix without duplicating a queued OSC anchor", async () => {
        const registry = new VisualAnchorRegistry();
        let markerCount = 0;
        const queue: TerminalIngressChunk[] = [
            {
                sequence: 1,
                data: bytes('snapshot-duplicate\x1b]16162;B;{"nonce":"n1","epoch":"e1","phase":"start","seq":1}\x07'),
            },
        ];
        trimTerminalIngressPrefix(queue, bytes("snapshot-duplicate").byteLength);

        const writes: Uint8Array[] = [];
        await drainTerminalIngress(
            queue,
            async (data) => {
                writes.push(data);
                markerCount++;
                registry.observeAnchor({
                    blockId: "block-1",
                    sessionEpoch: "e1",
                    hookSequence: 1,
                    commandId: undefined,
                    anchorNonce: "n1",
                    handle: { dispose: () => {} },
                });
            },
            () => true
        );

        registry.confirm({
            blockId: "block-1",
            sessionEpoch: "e1",
            hookSequence: 1,
            commandId: "command-1",
            anchorNonce: "n1",
            hostId: "host-1",
            runspaceId: "runspace-1",
            mode: "structured",
        });

        const output = new TextDecoder().decode(writes[0]);
        expect(output).toContain("\x1b]16162;B;");
        expect(output.split("\x1b]16162;B;")).toHaveLength(2);
        expect(new TextDecoder().decode(writes[0])).not.toContain("snapshot-duplicate");
        expect(writes).toHaveLength(1);
        expect(markerCount).toBe(1);
        expect(registry.get("n1")?.commandId).toBe("command-1");
    });

    it("drains a pending append after an initial-load barrier exactly once", async () => {
        const queue: TerminalIngressChunk[] = [];
        let releaseLoad: () => void;
        const loadBarrier = new Promise<void>((resolve) => {
            releaseLoad = resolve;
        });
        let writes = 0;
        const osc = '\x1b]16162;B;{"nonce":"n1","epoch":"e1","phase":"start","seq":1}\x07';

        queue.push({ sequence: 1, data: bytes(osc) });
        const drain = (async () => {
            await loadBarrier;
            await drainTerminalIngress(
                queue,
                async (data) => {
                    writes++;
                    expect(new TextDecoder().decode(data)).toBe(osc);
                },
                () => true
            );
        })();
        expect(writes).toBe(0);
        releaseLoad();
        await drain;

        expect(writes).toBe(1);
        expect(queue).toHaveLength(0);
    });

    it("does not replay queued anchors after clear or dispose invalidates the ingress", async () => {
        const queue: TerminalIngressChunk[] = [{ sequence: 1, data: bytes("\x1b]16162;B;stale\x07") }];
        let current = true;
        let writes = 0;
        queue.length = 0;
        current = false;

        await drainTerminalIngress(
            queue,
            async () => {
                writes++;
            },
            () => current
        );
        expect(writes).toBe(0);
        expect(queue).toHaveLength(0);
    });
});
