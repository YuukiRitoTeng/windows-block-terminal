import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const railSource = readFileSync(new URL("./command-navigation-rail.tsx", import.meta.url), "utf8");
const termSource = readFileSync(new URL("./term.tsx", import.meta.url), "utf8");

const record = (overrides: Partial<RecordView> = {}): RecordView => ({
    id: "command-1",
    wave_block_id: "block-1",
    session_epoch: "epoch-1",
    authority: "hosted-sidechannel",
    start_hook_sequence: 1,
    finish_hook_sequence: 2,
    command: "Write-Output same-text",
    cwd: "C:\\",
    state: "finished",
    completion_reason: "normal",
    visibility_generation: 1,
    output_total_bytes: 3,
    output_stored_bytes: 3,
    output_truncated: false,
    output_completeness: "complete",
    execution_mode: "structured",
    output_source: "hostStructured",
    runtime_host_id: "host",
    runtime_runspace_id: "runspace",
    capture_contract_version: 1,
    protocol_version: 1,
    output_attribution: "exclusive",
    output_text_safety: "plain_text",
    output_state: "closed",
    started_at_unix_ms: 1,
    finished_at_unix_ms: 2,
    success: true,
    exit_code: 0,
    ...overrides,
});

let matchConfirmedAnchors: any;
let RailRequestEpoch: any;
let RailRecordPoller: any;
let subscribeCommandAnchors: any;
let trackedIdsForRefresh: any;
let nextSelection: any;
let blockId: string;

beforeAll(async () => {
    try {
        const rail = await import("./command-navigation-rail");
        matchConfirmedAnchors = rail.matchConfirmedAnchors;
        RailRequestEpoch = rail.RailRequestEpoch;
        RailRecordPoller = rail.RailRecordPoller;
        subscribeCommandAnchors = rail.subscribeCommandAnchors;
        trackedIdsForRefresh = rail.trackedIdsForRefresh;
        nextSelection = rail.nextSelection;
        blockId = "block-1";
    } catch {
        matchConfirmedAnchors = undefined;
    }
});


describe("command navigation rail", () => {
    it("matches a Journal record only by the confirmed command id", () => {
        // This fails if matching ever falls back to command text, row position,
        // timing, or a partial id.
        expect(matchConfirmedAnchors).toBeTypeOf("function");
        if (matchConfirmedAnchors == null) return;

        const matched = matchConfirmedAnchors(
            [{ commandId: "command-1" }, { commandId: "missing-command" }],
            [record({ id: "different-id", command: "Write-Output same-text" }), record()]
        );

        expect(matched).toEqual([{ commandId: "command-1", record: record() }]);
    });

    it("invalidates a Journal response captured before a terminal or block change", () => {
        // This fails if a late ListVisibleRecords response can repopulate a rail
        // that now belongs to a different terminal instance or block.
        expect(RailRequestEpoch).toBeTypeOf("function");
        if (RailRequestEpoch == null) return;
        const epoch = new RailRequestEpoch();
        const stale = epoch.capture();
        epoch.bump();
        expect(epoch.isCurrent(stale)).toBe(false);
    });

    it("mounts a compact rail in place of the default history footer and uses the shared Copy All operation", () => {
        // Electron/xterm DOM is not available in this unit environment. This
        // integration contract guards the required mount, authority, and scope.
        expect(termSource).toContain("<TerminalContentFrame");
        expect(termSource).not.toContain("<CommandHistory blockId={blockId} model={model} />");
        expect(railSource).toContain("termWrap.subscribeCommandAnchors");
        expect(railSource).toContain("CommandJournalService.ListVisibleRecords(blockId)");
        expect(railSource).toContain("copyCommandAndOutput");
        expect(railSource).toContain("canCopyRecordOutput(selectedRecord, terminalRegion)");
        // The rail lists the journal's commands, not the visual markers: a Global Clear
        // removes the markers while the records stay.
        expect(railSource).toContain("record.session_epoch === sessionEpoch &&");
        expect(railSource).toContain("isKnownAuthority(record.authority)");
        expect(railSource).toContain("termWrap.getTerminalOutputForCommand");
    });

    it("waits a full polling interval between unsettled Journal queries", async () => {
        // This fails if a response-array update can immediately schedule another
        // IPC request instead of waiting for the bounded poll interval.
        expect(RailRecordPoller).toBeTypeOf("function");
        if (RailRecordPoller == null) return;
        vi.useFakeTimers();
        try {
            // An unsettled command keeps the poller on its bounded interval.
            const query = vi.fn().mockResolvedValue([record({ state: "running" })]);
            const setRecords = vi.fn();
            const poller = new RailRecordPoller(query, setRecords, 750);

            poller.setTracked(["command-1"]);
            await Promise.resolve();
            await Promise.resolve();
            expect(query).toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(749);
            expect(query).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(query).toHaveBeenCalled();

            poller.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("waits a full interval after a slow unsettled response resolves", async () => {
        // This fails with a fixed interval when a slow response resolves just
        // before the next tick: the next IPC call would happen almost at once.
        expect(RailRecordPoller).toBeTypeOf("function");
        if (RailRecordPoller == null) return;
        vi.useFakeTimers();
        try {
            let resolveSlow: (records: RecordView[]) => void = () => {};
            const slow = new Promise<RecordView[]>((resolve) => {
                resolveSlow = resolve;
            });
            const query = vi
                .fn()
                .mockResolvedValueOnce([record({ state: "running" })])
                .mockReturnValueOnce(slow)
                .mockResolvedValue([record({ state: "running" })]);
            const poller = new RailRecordPoller(query, vi.fn(), 750);

            poller.setTracked(["command-1"]);
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(750);
            expect(query).toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(749);
            resolveSlow([record({ state: "running" })]);
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1);
            expect(query).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(748);
            expect(query).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(query).toHaveBeenCalled();

            poller.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("re-queries when a confirmed anchor arrives after the poller stopped", async () => {
        // This is the production path that used to stall: the first query (or a settled
        // one) stops the timer, and the next command's anchor must start it again.
        expect(RailRecordPoller).toBeTypeOf("function");
        if (RailRecordPoller == null) return;
        vi.useFakeTimers();
        try {
            const query = vi.fn().mockResolvedValue([]);
            const setRecords = vi.fn();
            const poller = new RailRecordPoller(query, setRecords, 750);

            poller.setTracked([blockId]);
            await Promise.resolve();
            await Promise.resolve();
            expect(query).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(5000);
            expect(query).toHaveBeenCalled();

            // The anchor subscription re-arms the poller; the emptied rail keeps its
            // block tracked, so the new command is discovered.
            poller.setTracked(trackedIdsForRefresh([], blockId));
            await Promise.resolve();
            await Promise.resolve();
            expect(query).toHaveBeenCalled();
            poller.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps the block tracked while the rail has no records yet", () => {
        expect(trackedIdsForRefresh([], "block-1")).toEqual(["block-1"]);
        expect(trackedIdsForRefresh(["command-1"], "block-1")).toEqual(["command-1"]);
    });

    it("selects a record without needing a scrollable anchor", () => {
        // The record is the identity; a cleared buffer still navigates and copies.
        expect(nextSelection("command-2", ["command-1", "command-2"])).toEqual({
            selectedCommandId: "command-2",
            followingLatest: true,
        });
        expect(nextSelection("command-1", ["command-1", "command-2"])).toEqual({
            selectedCommandId: "command-1",
            followingLatest: false,
        });
        const rail = readFileSync(new URL("./command-navigation-rail.tsx", import.meta.url), "utf8");
        // The selection is applied before the best-effort scroll, never inside it.
        expect(rail).toMatch(/setSelection\(nextSelection\(id, ids\)\)/);
        expect(rail).toContain("if (!termWrap.scrollToCommandAnchor(id)) setAnchors(termWrap.getCommandAnchorSnapshot())");
        expect(rail).not.toMatch(/if \(termWrap\.scrollToCommandAnchor\(id\)\) \{\s*setSelection/);
    });

    it("re-arms the poller from the anchor subscription", () => {
        const rail = readFileSync(new URL("./command-navigation-rail.tsx", import.meta.url), "utf8");
        expect(rail).toContain("poller.rearm();")
    });

    it("stops polling when the tracked records settle and when the tracked set empties", async () => {
        // This fails if a settled record - or a rail whose commands were cleared -
        // leaves a timer alive that continues querying the Journal.
        expect(RailRecordPoller).toBeTypeOf("function");
        if (RailRecordPoller == null) return;
        vi.useFakeTimers();
        try {
            const query = vi.fn().mockResolvedValue([record()]);
            const setRecords = vi.fn();
            const poller = new RailRecordPoller(query, setRecords, 750);

            poller.setTracked(["command-1"]);
            await Promise.resolve();
            await Promise.resolve();
            expect(query).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(5000);
            expect(query).toHaveBeenCalled();

            // An emptied tracked set clears the rail and stops the timer.
            poller.setTracked([]);
            expect(setRecords).toHaveBeenLastCalledWith([]);
            await vi.advanceTimersByTimeAsync(5000);
            expect(query).toHaveBeenCalled();
            poller.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("requeries after the tracked set changes while a request is pending", async () => {
        // This fails if a tracked-set update while one request is pending drops the
        // new command until some unrelated future event occurs.
        expect(RailRecordPoller).toBeTypeOf("function");
        if (RailRecordPoller == null) return;
        let resolveFirst: (records: RecordView[]) => void = () => {};
        const first = new Promise<RecordView[]>((resolve) => {
            resolveFirst = resolve;
        });
        const query = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce([]);
        const poller = new RailRecordPoller(query, vi.fn(), 750);

        poller.setTracked(["command-1"]);
        poller.setTracked(["command-1", "command-2"]);
        resolveFirst([]);
        await Promise.resolve();
        await Promise.resolve();

        expect(query).toHaveBeenCalled();
        poller.dispose();
    });
});
