// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Rail session scope and causal re-arm.
 *
 * The product contract is that Rail / Copy All serve the current live terminal session only. A
 * durable record from an earlier app run is history, not a region of this terminal, so it must not
 * become a navigable entry; and a command executed now must be discovered as soon as its confirmed
 * anchor arrives, even when every record fetched at startup was already settled.
 */

import { describe, expect, it, vi } from "vitest";
import { RailRecordPoller, currentSessionAnchorIds, currentSessionEpoch } from "./command-navigation-rail";

function anchor(commandId: string, sessionEpoch: string) {
    return Object.freeze({ commandId, sessionEpoch });
}

describe("Rail session scope", () => {
    it("is empty before any confirmed anchor, so a restart starts at 0/0", () => {
        expect(currentSessionEpoch([])).toBeNull();
        expect(currentSessionAnchorIds([])).toEqual([]);
    });

    it("scopes ids to the newest anchor's session and ignores earlier epochs", () => {
        const anchors = [anchor("old-1", "epoch-old"), anchor("old-2", "epoch-old"), anchor("live-1", "epoch-live")];
        expect(currentSessionEpoch(anchors)).toBe("epoch-live");
        expect(currentSessionAnchorIds(anchors)).toEqual(["live-1"]);
    });

    it("keeps every anchor of the current session", () => {
        const anchors = [anchor("a", "e1"), anchor("b", "e1"), anchor("c", "e1")];
        expect(currentSessionAnchorIds(anchors)).toEqual(["a", "b", "c"]);
    });
});

describe("RailRecordPoller causal re-arm", () => {
    const settled = (id: string) => ({ id, state: "finished", output_state: "closed" }) as never;

    it("keeps a bounded wait going when a tracked anchor's record has not arrived yet", async () => {
        vi.useFakeTimers();
        const answers: unknown[][] = [[settled("old-1"), settled("old-2")], [settled("old-1"), settled("new-1")]];
        let calls = 0;
        const poller = new RailRecordPoller(
            async () => {
                const answer = answers[Math.min(calls, answers.length - 1)];
                calls += 1;
                return answer as never;
            },
            () => {},
            750
        );
        poller.setTracked(["new-1"]);
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toBe(1);
        // The tracked id was not in the first answer, so the poller keeps asking instead of
        // stopping because every record it saw was already settled.
        await vi.advanceTimersByTimeAsync(800);
        expect(calls).toBeGreaterThan(1);
        poller.dispose();
        vi.useRealTimers();
    });

    it("re-arms immediately on a confirmed anchor instead of waiting for the timer", async () => {
        const query = vi.fn(async () => [settled("new-1")] as never);
        const poller = new RailRecordPoller(query, () => {}, 60000);
        poller.setTracked(["new-1"]);
        await Promise.resolve();
        const before = query.mock.calls.length;
        poller.rearm();
        await Promise.resolve();
        expect(query.mock.calls.length).toBeGreaterThan(before);
        poller.dispose();
    });

    it("stops once the tracked record is visible and settled", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const poller = new RailRecordPoller(
            async () => {
                calls += 1;
                return [settled("new-1")] as never;
            },
            () => {},
            750
        );
        poller.setTracked(["new-1"]);
        await vi.advanceTimersByTimeAsync(0);
        const afterFirst = calls;
        await vi.advanceTimersByTimeAsync(5000);
        expect(calls).toBe(afterFirst);
        poller.dispose();
        vi.useRealTimers();
    });
});
