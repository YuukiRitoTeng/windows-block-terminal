// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type TerminalIngressChunk = {
    sequence: number;
    /** The event payload is retained for ordering/debugging, but never used
     * as an overlap boundary. The authoritative file read supplies bytes. */
    data: Uint8Array;
};

export type TerminalIngressCatchUpResult = Uint8Array;

const visualAnchorPrefix = new TextEncoder().encode("\x1b]16162;B;");

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
    outer: for (let index = from; index <= haystack.length - needle.length; index++) {
        for (let needleIndex = 0; needleIndex < needle.length; needleIndex++) {
            if (haystack[index + needleIndex] !== needle[needleIndex]) continue outer;
        }
        return index;
    }
    return -1;
}

/** Extract complete visual-anchor OSC frames from a queued append payload. */
export function extractVisualAnchorFrames(data: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < data.length) {
        const start = indexOfBytes(data, visualAnchorPrefix, offset);
        if (start < 0) break;
        let end = start + visualAnchorPrefix.length;
        let terminated = false;
        while (end < data.length && data[end] !== 0x07) {
            if (data[end] === 0x1b && data[end + 1] === 0x5c) {
                end += 2;
                terminated = true;
                break;
            }
            end++;
        }
        if (!terminated && end < data.length && data[end] === 0x07) {
            end++;
            terminated = true;
        }
        if (!terminated) break;
        frames.push(data.slice(start, end));
        offset = end;
    }
    return frames;
}

/** Return the nonce values carried by complete visual-anchor OSC frames. */
export function extractVisualAnchorNonces(data: Uint8Array): Set<string> {
    const nonces = new Set<string>();
    const decoder = new TextDecoder();
    for (const frame of extractVisualAnchorFrames(data)) {
        const match = decoder.decode(frame).match(/"nonce"\s*:\s*"([^"]+)"/);
        if (match?.[1]) nonces.add(match[1]);
    }
    return nonces;
}

/**
 * Drains append notifications in source order. The callback must obtain the
 * authoritative suffix from the terminal file and write that suffix through
 * the normal terminal path. Event payload bytes are deliberately not used for
 * overlap arithmetic because WS file events do not carry a common offset.
 */
export async function drainTerminalIngress(
    queue: TerminalIngressChunk[],
    catchUp: () => Promise<TerminalIngressCatchUpResult>,
    replayMissingAnchors: (data: Uint8Array, coveredAnchorNonces: Set<string>) => Promise<void>,
    isCurrent: () => boolean
): Promise<void> {
    const coveredAnchorNonces = new Set<string>();
    while (queue.length > 0 && isCurrent()) {
        const batch = queue.splice(0, queue.length);
        for (let index = 0; index < batch.length; index++) {
            if (!isCurrent()) {
                return;
            }
            try {
                const written = await catchUp();
                if (!isCurrent()) {
                    // Clear/dispose invalidated this batch. Do not put its
                    // notifications back into a queue that now belongs to a
                    // newer ingress generation.
                    return;
                }
                for (const nonce of extractVisualAnchorNonces(written)) {
                    coveredAnchorNonces.add(nonce);
                }
                await replayMissingAnchors(batch[index].data, coveredAnchorNonces);
            } catch (e) {
                if (!isCurrent()) {
                    return;
                }
                queue.unshift(...batch.slice(index));
                throw e;
            }
        }
    }
}
