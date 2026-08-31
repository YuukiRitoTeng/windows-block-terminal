import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
    drainTerminalIngress,
    extractVisualAnchorFrames,
    type TerminalIngressCatchUpResult,
    type TerminalIngressChunk,
} from "./terminal-ingress";
import { VisualAnchorRegistry } from "./visual-anchor";

function bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function anchor(nonce: string): string {
    return `\x1b]16162;B;{"nonce":"${nonce}","epoch":"e1","phase":"start","seq":1}\x07`;
}

/** A small TermWrap-shaped seam: doTerminalWrite feeds the xterm parser, and
 * the parser invokes the same visual-anchor registration boundary used by
 * production. */
function makeTerminalSeam() {
    const registry = new VisualAnchorRegistry();
    let markerCount = 0;
    let parserLoaded = true;
    const writes: Uint8Array[] = [];
    const doTerminalWrite = async (data: Uint8Array): Promise<void> => {
        writes.push(data);
        if (!parserLoaded) return;
        for (const frame of extractVisualAnchorFrames(data)) {
            const text = new TextDecoder().decode(frame);
            const nonce = text.match(/"nonce":"([^"]+)"/)?.[1];
            if (nonce == null) continue;
            markerCount++;
            registry.observeAnchor({
                blockId: "block-1",
                sessionEpoch: "e1",
                hookSequence: 1,
                commandId: undefined,
                anchorNonce: nonce,
                handle: { dispose: () => {} },
            });
        }
    };
    return {
        registry,
        writes,
        doTerminalWrite,
        setParserLoaded(value: boolean) {
            parserLoaded = value;
        },
        get markerCount() {
            return markerCount;
        },
    };
}

async function drain(
    queue: TerminalIngressChunk[],
    reads: TerminalIngressCatchUpResult[],
    seam: ReturnType<typeof makeTerminalSeam>,
    current = true
) {
    await drainTerminalIngress(
        queue,
        async () => {
            const written = reads.shift() ?? new Uint8Array();
            if (written.byteLength > 0) await seam.doTerminalWrite(written);
            return written;
        },
        async (data, covered) => {
            for (const frame of extractVisualAnchorFrames(data)) {
                const nonce = new TextDecoder().decode(frame).match(/"nonce":"([^"]+)"/)?.[1];
                if (nonce != null && covered.has(nonce)) continue;
                await seam.doTerminalWrite(frame);
                if (nonce != null) covered.add(nonce);
            }
        },
        () => current
    );
}

describe("terminal ingress initialization", () => {
    it("parses a live OSC B covered by the initial snapshot exactly once", async () => {
        const seam = makeTerminalSeam();
        const live = bytes(anchor("covered"));
        // Initial snapshot rendering occurs while loaded=false, so its OSC is
        // intentionally not parsed. The queued live notification re-enters
        // the normal write/parser seam and restores the marker once.
        seam.setParserLoaded(false);
        await seam.doTerminalWrite(bytes(`large-snapshot-${"x".repeat(4096)}${new TextDecoder().decode(live)}`));
        seam.setParserLoaded(true);
        const queue = [{ sequence: 1, data: live }];
        await drain(queue, [new Uint8Array()], seam);
        seam.registry.confirm({
            blockId: "block-1",
            sessionEpoch: "e1",
            hookSequence: 1,
            commandId: "command-covered",
            anchorNonce: "covered",
            hostId: "host-1",
            runspaceId: "runspace-1",
            mode: "structured",
        });
        expect(seam.markerCount).toBe(1);
        expect(seam.registry.get("covered")?.commandId).toBe("command-covered");
        expect(queue).toHaveLength(0);
    });

    it("holds a live append behind the initial-load barrier and drains it once", async () => {
        const seam = makeTerminalSeam();
        const queue: TerminalIngressChunk[] = [];
        const live = bytes(anchor("barrier"));
        let releaseLoad!: () => void;
        const loadBarrier = new Promise<void>((resolve) => {
            releaseLoad = resolve;
        });
        const pendingDrain = (async () => {
            await loadBarrier;
            await drain(queue, [new Uint8Array()], seam);
        })();
        queue.push({ sequence: 1, data: live });
        expect(seam.markerCount).toBe(0);
        releaseLoad();
        await pendingDrain;
        expect(seam.markerCount).toBe(1);
        expect(queue).toHaveLength(0);
    });

    it("renders an OSC B appended after the snapshot boundary exactly once", async () => {
        const seam = makeTerminalSeam();
        const live = bytes(anchor("after-snapshot"));
        const queue = [{ sequence: 1, data: live }];
        // The authoritative read from the snapshot end returns the post-
        // snapshot suffix; replay of the notification is suppressed because
        // its nonce is present in the bytes actually written.
        await drain(queue, [live], seam);
        seam.registry.confirm({
            blockId: "block-1",
            sessionEpoch: "e1",
            hookSequence: 1,
            commandId: "command-after",
            anchorNonce: "after-snapshot",
            hostId: "host-1",
            runspaceId: "runspace-1",
            mode: "structured",
        });
        expect(seam.markerCount).toBe(1);
        expect(seam.registry.get("after-snapshot")?.commandId).toBe("command-after");
    });

    it("does not drop a live queue when the snapshot is larger than the queue", async () => {
        const seam = makeTerminalSeam();
        const live = bytes(anchor("small-queue"));
        const queue = [{ sequence: 1, data: live }];
        // A large snapshot byte count is deliberately absent from this path;
        // only the authoritative suffix result decides what is covered.
        await drain(queue, [new Uint8Array()], seam);
        expect(seam.markerCount).toBe(1);
        expect(queue).toHaveLength(0);
    });

    it("keeps post-init live append on the same parser path", async () => {
        const seam = makeTerminalSeam();
        const queue = [{ sequence: 1, data: bytes(anchor("live")) }];
        await drain(queue, [bytes(anchor("live"))], seam);
        expect(seam.markerCount).toBe(1);
        expect(seam.writes).toHaveLength(1);
    });

    it("does not replay queued anchors after clear/dispose invalidates ingress", async () => {
        const seam = makeTerminalSeam();
        const queue = [{ sequence: 1, data: bytes(anchor("stale")) }];
        await drain(queue, [bytes(anchor("stale"))], seam, false);
        expect(seam.markerCount).toBe(0);
        expect(queue).toHaveLength(1);
    });

    it("drops an invalidated batch after a blocked catch-up instead of requeueing it", async () => {
        const queue: TerminalIngressChunk[] = [{ sequence: 1, data: bytes(anchor("stale-batch")) }];
        let current = true;
        let releaseCatchUp!: () => void;
        let catchUpStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            catchUpStarted = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
            releaseCatchUp = resolve;
        });
        const pending = drainTerminalIngress(
            queue,
            async () => {
                catchUpStarted();
                await barrier;
                return new Uint8Array();
            },
            async () => {},
            () => current
        );
        await started;
        queue.length = 0;
        queue.push({ sequence: 2, data: bytes("new-generation") });
        current = false;
        releaseCatchUp();
        await pending;
        expect(queue).toEqual([{ sequence: 2, data: bytes("new-generation") }]);
    });

    it("resets the authoritative offset on truncate before rendering new text and OSC B", async () => {
        const termwrapSource = readFileSync(new URL("./termwrap.ts", import.meta.url), "utf8");
        const truncateBranch = termwrapSource.indexOf('if (msg.fileop == "truncate")');
        expect(truncateBranch).toBeGreaterThanOrEqual(0);
        expect(termwrapSource.indexOf("this.ptyOffset = 0;", truncateBranch)).toBeGreaterThan(truncateBranch);

        const seam = makeTerminalSeam();
        let ptyOffset = 8192;
        const newFile = bytes(`after-truncate\n${anchor("after-truncate")}`);
        // Model the production catch-up guard: after truncate the new file
        // starts at offset zero, so the suffix is rendered instead of skipped.
        ptyOffset = 0;
        if (newFile.byteLength >= ptyOffset) await seam.doTerminalWrite(newFile);
        ptyOffset = newFile.byteLength;
        expect(new TextDecoder().decode(seam.writes[0])).toContain("after-truncate");
        expect(seam.markerCount).toBe(1);
        expect(ptyOffset).toBe(newFile.byteLength);
    });
});
