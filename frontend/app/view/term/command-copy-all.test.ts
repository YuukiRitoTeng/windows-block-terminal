import { beforeAll, describe, expect, it, vi } from "vitest";

const record = (overrides: Partial<RecordView> = {}): RecordView => ({
    id: "command-1",
    wave_block_id: "block-1",
    session_epoch: "epoch-1",
    start_hook_sequence: 1,
    finish_hook_sequence: 2,
    command: "Write-Output ok",
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

let copyCommandAndOutput: any;

beforeAll(async () => {
    try {
        copyCommandAndOutput = (await import("./command-copy-all")).copyCommandAndOutput;
    } catch {
        copyCommandAndOutput = undefined;
    }
});

describe("Copy All", () => {
    it("writes the command and safe authoritative Journal output as one clipboard value", async () => {
        // This fails if the operation is absent, gets output from another id, skips
        // the projection, or writes a different clipboard payload.
        expect(copyCommandAndOutput).toBeTypeOf("function");
        if (copyCommandAndOutput == null) return;
        const writeText = vi.fn().mockResolvedValue(undefined);
        const getOutput = vi
            .fn()
            .mockResolvedValue({
                data: "b2s=",
                total_bytes: 2,
                stored_bytes: 2,
                truncated: false,
                completeness: "complete",
                attribution: "exclusive",
                text_safety: "plain_text",
                output_state: "closed",
            });

        await expect(copyCommandAndOutput(record(), { GetOutput: getOutput }, { writeText })).resolves.toEqual({
            ok: true,
        });
        expect(getOutput).toHaveBeenCalledWith("command-1");
        expect(writeText).toHaveBeenCalledWith("Write-Output ok\nok");
    });

    it("rejects unsafe records before requesting or writing output", async () => {
        // This fails if a future caller treats untrusted terminal bytes as an
        // acceptable fallback for an interactive or otherwise unsafe record.
        const getOutput = vi.fn();
        const writeText = vi.fn();

        await expect(
            copyCommandAndOutput(record({ execution_mode: "interactive" }), { GetOutput: getOutput }, { writeText })
        ).resolves.toEqual({
            ok: false,
            reason: "Output copy disabled because the product data is incomplete, unsafe, or truncated.",
        });
        expect(getOutput).not.toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
    });
});
