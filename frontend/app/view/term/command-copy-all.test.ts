import { beforeAll, describe, expect, it, vi } from "vitest";

const record = (overrides: Partial<RecordView> = {}): RecordView => ({
    id: "command-1",
    wave_block_id: "block-1",
    session_epoch: "epoch-1",
    authority: "hosted-sidechannel",
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

    it("uses the terminal region for the terminal authority instead of the journal copy", async () => {
        // The in-band authority cannot prove where a command's last byte landed, so
        // its output comes from the terminal the user actually saw - and the journal
        // is not consulted at all.
        const getOutput = vi.fn();
        const writeText = vi.fn().mockResolvedValue(undefined);
        const region = vi.fn().mockReturnValue("first line\nlast line");
        const terminalRecord = record({
            authority: "terminal-osc",
            execution_mode: "unknown",
            output_completeness: "unknown",
            output_attribution: "unknown",
            output_text_safety: "unknown",
            output_source: "pty",
            runtime_host_id: "",
            runtime_runspace_id: "",
            capture_contract_version: 0,
        });

        await expect(
            copyCommandAndOutput(terminalRecord, { GetOutput: getOutput }, { writeText }, region)
        ).resolves.toEqual({ ok: true });
        expect(region).toHaveBeenCalledWith("command-1");
        expect(getOutput).not.toHaveBeenCalled();
        expect(writeText).toHaveBeenCalledWith("Write-Output ok\nfirst line\nlast line");
    });

    it("falls back to the finished record when the terminal region is gone", async () => {
        // A Global Clear removes the markers (and the scrollback) while the record stays:
        // the record is then the only evidence of what the command printed, so its copy
        // is used instead of refusing outright.
        const getOutput = vi.fn().mockResolvedValue({ data: "b2s=", total_bytes: 2, stored_bytes: 2, truncated: false });
        const writeText = vi.fn().mockResolvedValue(undefined);
        const terminalRecord = record({
            authority: "terminal-osc",
            execution_mode: "unknown",
            output_completeness: "unknown",
            output_attribution: "unknown",
            output_text_safety: "unknown",
            output_source: "pty",
        });

        await expect(
            copyCommandAndOutput(terminalRecord, { GetOutput: getOutput }, { writeText }, () => undefined)
        ).resolves.toEqual({ ok: true });
        expect(getOutput).toHaveBeenCalledWith("command-1");
        expect(writeText).toHaveBeenCalledWith("Write-Output ok\nok");
    });

    it("refuses the terminal authority while its command is unfinished or truncated", async () => {
        const getOutput = vi.fn();
        const writeText = vi.fn();
        for (const overrides of [{ state: "running" as const }, { output_state: "pending" as const }, { output_truncated: true }]) {
            await expect(
                copyCommandAndOutput(
                    record({ authority: "terminal-osc", execution_mode: "unknown", ...overrides }),
                    { GetOutput: getOutput },
                    { writeText },
                    () => undefined
                )
            ).resolves.toEqual({ ok: false, reason: "Output copy disabled because the product data is incomplete, unsafe, or truncated." });
        }
        expect(getOutput).not.toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
    });

    it("copies only the output from the same source", async () => {
        const copyCommandOutput = (await import("./command-copy-all")).copyCommandOutput;
        expect(copyCommandOutput).toBeTypeOf("function");
        const writeText = vi.fn().mockResolvedValue(undefined);
        const region = vi.fn().mockReturnValue("terminal text");

        await expect(
            copyCommandOutput(
                record({ authority: "terminal-osc", execution_mode: "unknown" }),
                { GetOutput: vi.fn() },
                { writeText },
                region
            )
        ).resolves.toEqual({ ok: true });
        expect(writeText).toHaveBeenCalledWith("terminal text");
    });

    it("keeps the gate and the projection in step for a large terminal fallback", async () => {
        // The button must not be enabled for a copy the projection refuses: a record past
        // the presentation budget is not copyable through the record fallback either.
        const canCopyRecordOutput = (await import("./command-copy-all")).canCopyRecordOutput;
        const largeRecord = record({
            authority: "terminal-osc",
            execution_mode: "unknown",
            output_stored_bytes: 64 * 1024 + 1,
            output_total_bytes: 64 * 1024 + 1,
        });
        expect(canCopyRecordOutput(largeRecord, () => undefined)).toBe(false);

        const writeText = vi.fn();
        const getOutput = vi.fn().mockResolvedValue({ data: "", total_bytes: 0, stored_bytes: 0, truncated: false });
        await expect(
            copyCommandAndOutput(largeRecord, { GetOutput: getOutput }, { writeText }, () => undefined)
        ).resolves.toEqual({ ok: false, reason: "Output copy disabled because the product data is incomplete, unsafe, or truncated." });
        expect(getOutput).not.toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
    });

    it("gates copy on the same source the copy would use", async () => {
        const canCopyRecordOutput = (await import("./command-copy-all")).canCopyRecordOutput;
        expect(canCopyRecordOutput).toBeTypeOf("function");
        const terminalRecord = record({ authority: "terminal-osc", execution_mode: "unknown", output_completeness: "unknown" });

        expect(canCopyRecordOutput(terminalRecord, () => "text")).toBe(true);
        // No readable region: the finished record itself carries the copy.
        expect(canCopyRecordOutput(terminalRecord, () => undefined)).toBe(true);
        expect(canCopyRecordOutput(terminalRecord)).toBe(true);
        // …but never while the command is still running or its output is unfinished.
        expect(canCopyRecordOutput({ ...terminalRecord, state: "running" }, () => undefined)).toBe(false);
        expect(canCopyRecordOutput({ ...terminalRecord, output_state: "pending" }, () => undefined)).toBe(false);
        // The journal authority keeps its own gate.
        expect(canCopyRecordOutput(record())).toBe(true);
    });
});
