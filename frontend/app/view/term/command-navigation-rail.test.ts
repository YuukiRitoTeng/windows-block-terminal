import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const railSource = readFileSync(new URL("./command-navigation-rail.tsx", import.meta.url), "utf8");
const termSource = readFileSync(new URL("./term.tsx", import.meta.url), "utf8");

const record = (overrides: Partial<RecordView> = {}): RecordView => ({
    id: "command-1",
    wave_block_id: "block-1",
    session_epoch: "epoch-1",
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

beforeAll(async () => {
    try {
        const rail = await import("./command-navigation-rail");
        matchConfirmedAnchors = rail.matchConfirmedAnchors;
        RailRequestEpoch = rail.RailRequestEpoch;
        RailRecordPoller = rail.RailRecordPoller;
        subscribeCommandAnchors = rail.subscribeCommandAnchors;
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
        expect(railSource).toContain("canCopyOutput(selectedRecord)");
    });

    it("waits a full polling interval between unsettled Journal queries", async () => {
        // This fails if a response-array update can immediately schedule another
        // IPC request instead of waiting for the bounded poll interval.
        expect(RailRecordPoller).toBeTypeOf("function");
        if (RailRecordPoller == null) return;
        vi.useFakeTimers();
        try {
            const query = vi.fn().mockResolvedValue([]);
            const setRecords = vi.fn();
            const poller = new RailRecordPoller(query, setRecords, 750);

            poller.setAnchors([{ commandId: "command-1" }]);
            await Promise.resolve();
            await Promise.resolve();
            expect(query).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(749);
            expect(query).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(query).toHaveBeenCalledTimes(2);

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
            const query = vi.fn().mockResolvedValueOnce([]).mockReturnValueOnce(slow).mockResolvedValue([]);
            const poller = new RailRecordPoller(query, vi.fn(), 750);

            poller.setAnchors([{ commandId: "command-1" }]);
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(750);
            expect(query).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(749);
            resolveSlow([]);
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1);
            expect(query).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(748);
            expect(query).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(query).toHaveBeenCalledTimes(3);

            poller.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops polling when the matched record settles and when anchor subscription reports removal", async () => {
        // This fails if a closed matched record or an invalidated anchor leaves
        // a timer alive that continues querying the Journal.
        expect(RailRecordPoller).toBeTypeOf("function");
        expect(subscribeCommandAnchors).toBeTypeOf("function");
        if (RailRecordPoller == null || subscribeCommandAnchors == null) return;
        vi.useFakeTimers();
        try {
            const query = vi.fn().mockResolvedValue([record()]);
            const setRecords = vi.fn();
            const poller = new RailRecordPoller(query, setRecords, 750);
            let listener: (() => void) | undefined;
            const unsubscribe = vi.fn();
            const termWrap = {
                getCommandAnchorSnapshot: vi
                    .fn()
                    .mockReturnValueOnce([{ commandId: "command-1" }])
                    .mockReturnValueOnce([]),
                subscribeCommandAnchors: vi.fn((next) => {
                    listener = next;
                    return unsubscribe;
                }),
            };

            const stopSubscription = subscribeCommandAnchors(termWrap, (anchors) => poller.setAnchors(anchors));
            await Promise.resolve();
            await Promise.resolve();
            expect(query).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1000);
            expect(query).toHaveBeenCalledTimes(1);

            listener?.();
            expect(setRecords).toHaveBeenLastCalledWith([]);
            await vi.advanceTimersByTimeAsync(1000);
            expect(query).toHaveBeenCalledTimes(1);
            stopSubscription();
            expect(unsubscribe).toHaveBeenCalledTimes(1);
            poller.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("requeries after an anchor change invalidates an in-flight response", async () => {
        // This fails if a subscription update while one request is pending drops
        // the new confirmed command until some unrelated future event occurs.
        expect(RailRecordPoller).toBeTypeOf("function");
        if (RailRecordPoller == null) return;
        let resolveFirst: (records: RecordView[]) => void = () => {};
        const first = new Promise<RecordView[]>((resolve) => {
            resolveFirst = resolve;
        });
        const query = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce([]);
        const poller = new RailRecordPoller(query, vi.fn(), 750);

        poller.setAnchors([{ commandId: "command-1" }]);
        poller.setAnchors([{ commandId: "command-2" }]);
        resolveFirst([]);
        await Promise.resolve();
        await Promise.resolve();

        expect(query).toHaveBeenCalledTimes(2);
        poller.dispose();
    });
});
