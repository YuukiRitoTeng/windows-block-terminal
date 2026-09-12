import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

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

beforeAll(async () => {
    try {
        const rail = await import("./command-navigation-rail");
        matchConfirmedAnchors = rail.matchConfirmedAnchors;
        RailRequestEpoch = rail.RailRequestEpoch;
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
        expect(termSource).toContain("<CommandNavigationRail");
        expect(termSource).not.toContain("<CommandHistory blockId={blockId} model={model} />");
        expect(railSource).toContain("termWrap.subscribeCommandAnchors");
        expect(railSource).toContain("CommandJournalService.ListVisibleRecords(blockId)");
        expect(railSource).toContain("copyCommandAndOutput");
        expect(railSource).toContain("canCopyOutput(record)");
    });
});
