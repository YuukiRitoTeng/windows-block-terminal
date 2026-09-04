import { describe, expect, it } from "vitest";
import { createStartupReadinessGate, parseWaveSrvStartLine } from "./startup-readiness";

describe("startup readiness", () => {
    it("settles a startup failure instead of leaving readiness pending", async () => {
        const gate = createStartupReadinessGate();
        gate.settle(false);
        await expect(gate.promise).resolves.toBe(false);
    });

    it("settles readiness exactly once", async () => {
        const gate = createStartupReadinessGate();
        gate.settle(false);
        gate.settle(true);
        await expect(gate.promise).resolves.toBe(false);
    });

    it("settles readiness for a malformed WAVESRV-ESTART signal", async () => {
        const gate = createStartupReadinessGate();
        expect(parseWaveSrvStartLine("WAVESRV-ESTART malformed")).toBeNull();
        gate.settle(false);
        await expect(gate.promise).resolves.toBe(false);
    });

    it("preserves successful readiness", async () => {
        const gate = createStartupReadinessGate();
        gate.settle(true);
        await expect(gate.promise).resolves.toBe(true);
    });
});
