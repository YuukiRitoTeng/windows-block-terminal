import { describe, expect, it, vi } from "vitest";
import { canCopyOutput, clearProductHistory, limitVisibleRecords, projectOutput, sanitizeTerminalText } from "./command-history";

const record = (overrides: Partial<RecordView> = {}): RecordView => ({
    id: "cmd-1", wave_block_id: "block-1", session_epoch: "epoch", start_hook_sequence: 1,
    finish_hook_sequence: 2, command: "Write-Output ok", cwd: "C:\\", state: "finished",
    completion_reason: "normal", visibility_generation: 1, output_total_bytes: 3,
    output_stored_bytes: 3, output_truncated: false, output_completeness: "complete",
    execution_mode: "structured", output_source: "hostStructured", runtime_host_id: "host", runtime_runspace_id: "runspace",
    capture_contract_version: 1, protocol_version: 1, output_attribution: "exclusive", output_text_safety: "plain_text", output_state: "closed", started_at_unix_ms: 1,
    finished_at_unix_ms: 2, success: true, exit_code: 0, ...overrides,
});

describe("command history product seam", () => {
    it("bounds history materialization", () => {
        const records = Array.from({ length: 101 }, (_, index) => record({ id: `cmd-${index}` }));
        expect(limitVisibleRecords(records)).toHaveLength(100);
        expect(limitVisibleRecords(records)[0].id).toBe("cmd-1");
    });

    it("projects safe output and rejects terminal bytes or truncation", () => {
        expect(projectOutput(record(), "b2s=")).toEqual({ kind: "safe", text: "ok" });
        expect(projectOutput(record(), "G1t") .kind).toBe("unsafe");
        expect(projectOutput(record({ output_truncated: true }), "b2s=").kind).toBe("unsafe");
        expect(canCopyOutput(record())).toBe(true);
        expect(canCopyOutput(record({ output_completeness: "incomplete" }))).toBe(false);
        expect(canCopyOutput(record({ execution_mode: "interactive" }))).toBe(false);
        expect(canCopyOutput(record({ output_attribution: "unknown" }))).toBe(false);
        expect(canCopyOutput(record({ output_text_safety: "unknown" }))).toBe(false);
        expect(projectOutput(record({ output_state: "pending" }), "b2s=").kind).toBe("unsafe");
    });

    it("strips ANSI styling while preserving ordinary command output", () => {
        expect(sanitizeTerminalText("\u001b[mmanual-success\u001b[0m\r\n")).toBe("manual-success\r\n");
        expect(sanitizeTerminalText("manual-success")).toBe("manual-success");
        expect(sanitizeTerminalText("bad\u0007output")).toBeNull();
    });

    it("clears the terminal only after backend success", async () => {
        const clearTerminal = vi.fn();
        const service = { ClearVisualHistory: vi.fn().mockResolvedValue({ generation: 2 }) };
        await clearProductHistory("block-1", service, clearTerminal);
        expect(service.ClearVisualHistory).toHaveBeenCalledWith("block-1");
        expect(clearTerminal).toHaveBeenCalledOnce();
        const failed = { ClearVisualHistory: vi.fn().mockRejectedValue(new Error("db")) };
        await expect(clearProductHistory("block-1", failed, clearTerminal)).rejects.toThrow("db");
        expect(clearTerminal).toHaveBeenCalledOnce();
    });
});
