// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type TerminalIngressChunk = {
    sequence: number;
    data: Uint8Array;
};

/**
 * Removes bytes already covered by the initial terminal snapshot while
 * preserving the order and sequence of any remaining live append data.
 */
export function trimTerminalIngressPrefix(queue: TerminalIngressChunk[], byteCount: number): void {
    let remaining = Math.max(0, byteCount);
    while (remaining > 0 && queue.length > 0) {
        const chunk = queue[0];
        if (remaining >= chunk.data.byteLength) {
            remaining -= chunk.data.byteLength;
            queue.shift();
            continue;
        }
        queue[0] = { ...chunk, data: chunk.data.slice(remaining) };
        remaining = 0;
    }
}

/**
 * Drains queued terminal appends in source order. New appends arriving while
 * a write is pending are handled on the next loop without overlapping writes.
 */
export async function drainTerminalIngress(
    queue: TerminalIngressChunk[],
    write: (data: Uint8Array) => Promise<void>,
    isCurrent: () => boolean
): Promise<void> {
    while (queue.length > 0 && isCurrent()) {
        const batch = queue.splice(0, queue.length);
        for (let index = 0; index < batch.length; index++) {
            if (!isCurrent()) {
                return;
            }
            try {
                await write(batch[index].data);
            } catch (e) {
                queue.unshift(...batch.slice(index));
                throw e;
            }
        }
    }
}
