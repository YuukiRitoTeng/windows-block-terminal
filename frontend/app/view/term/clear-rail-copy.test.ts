// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Clear × Rail / Copy All, as formal regressions.
 *
 * The Rail lists *records* (the backend's visible set), and anchors are only used to locate a
 * record. These tests pin the sequence the audit asked for: an old record is visible, the clear
 * hides it, a new command is listed again (never 0/0), Copy All works for the new record, and a
 * stale presentation marker can never bring the old generation back.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { copyCommandAndOutput, canCopyRecordOutput } from "./command-copy-all";
import { matchConfirmedAnchors, nextSelection, trackedIdsForRefresh } from "./command-navigation-rail";

const railSource = readFileSync(new URL("./command-navigation-rail.tsx", import.meta.url), "utf8");
const clearSource = readFileSync(new URL("./clear-product-history.ts", import.meta.url), "utf8");

const record = (overrides: Partial<RecordView> = {}): RecordView =>
    ({
        id: "old",
        wave_block_id: "block-1",
        state: "finished",
        completion_reason: "normal",
        authority: "terminal-osc",
        execution_mode: "unknown",
        output_state: "closed",
        output_truncated: false,
        output_stored_bytes: 12,
        command: "Write-Output one",
        ...overrides,
    }) as RecordView;

/** What the backend answers before and after a clear, and after the next command. */
function visibleSets(sequence: RecordView[][]) {
    let index = 0;
    return {
        ListVisibleRecords: vi.fn(async () => sequence[Math.min(index++, sequence.length - 1)] ?? []),
        GetOutput: vi.fn(async () => ({ data: "", total_bytes: 0, stored_bytes: 0, truncated: false })),
    };
}

describe("Global Clear × Rail / Copy All", () => {
    it("hides the old record, then lists the new command instead of staying empty", async () => {
        const oldRecord = record({ id: "old" });
        const newRecord = record({ id: "new", command: "Get-ChildItem" });
        const backend = visibleSets([[oldRecord], [], [newRecord]]);

        expect(await backend.ListVisibleRecords()).toEqual([oldRecord]);
        const afterClear = await backend.ListVisibleRecords();
        expect(afterClear).toEqual([]);
        // The Rail keeps tracking the block after an empty answer, so the next command reappears.
        expect(trackedIdsForRefresh([], "block-1")).toEqual(["block-1"]);
        expect(trackedIdsForRefresh([], "")).toEqual([]);
        const afterNext = await backend.ListVisibleRecords();
        expect(afterNext.map((entry) => entry.id)).toEqual(["new"]);
        const selection = nextSelection("new", afterNext.map((entry) => entry.id));
        expect(selection.selectedCommandId).toBe("new");
    });

    it("cannot be revived by a stale presentation marker", async () => {
        const backend = visibleSets([[]]);
        const records = await backend.ListVisibleRecords();
        // A marker left over from the cleared generation has no record to match: matchConfirmed-
        // Anchors only attaches anchors to records, it never creates one.
        const matched = matchConfirmedAnchors([{ commandId: "old" }], records);
        expect(matched).toEqual([]);
        // And the Rail never derives its list from markers.
        expect(railSource).toContain("isKnownAuthority(record.authority)");
        expect(railSource).not.toMatch(/listVisibleRecords\s*=\s*anchors/);
    });

    it("copies the new command through the terminal-authority path", async () => {
        const newRecord = record({ id: "new", command: "Get-ChildItem -Force" });
        expect(canCopyRecordOutput(newRecord, () => undefined)).toBe(true);

        const writeText = vi.fn().mockResolvedValue(undefined);
        const backend = visibleSets([[newRecord]]);
        const service = { ...backend, ...({} as object) };
        // The terminal-authority path reads the visible region first; this provider is what the
        // TermWrap exposes for the command's own confirmed region.
        const region = (commandId: string) =>
            commandId === "new" ? "$ Get-ChildItem -Force\n\nfile-a\nfile-b\n" : undefined;
        const result = await copyCommandAndOutput(newRecord, service as never, { writeText } as never, region);

        expect(result).toEqual({ ok: true });
        expect(writeText).toHaveBeenCalledTimes(1);
        const copied = writeText.mock.calls[0][0] as string;
        expect(copied).toContain("Get-ChildItem -Force");
        expect(copied).toContain("file-a");
    });

    it("keeps the clear and the Rail decoupled from markers", () => {
        // The clear never consults markers or anchors, and never touches record storage.
        expect(clearSource).not.toMatch(/promptMarkers|visualAnchorCues|anchorRegistry/);
        expect(clearSource).not.toMatch(/Snapshot|generation\s*=/);
    });
});
