import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
    commandRegionBoundary,
    commandRegionRange,
    commandRegionReadable,
    commandRegionText,
    type CommandRegionMark,
} from "./command-output-region";

const termwrapSource = readFileSync(new URL("./termwrap.ts", import.meta.url), "utf8");

/** A mark whose identity the anchor registry confirmed. */
const confirmed = (line: number, commandId: string, authority = "terminal-osc", sessionEpoch = "epoch-1"): CommandRegionMark => ({
    line,
    authority,
    sessionEpoch,
    commandId,
});

/** A mark that is registered but not confirmed (pending), or was refused by the registry. */
const unconfirmed = (line: number): CommandRegionMark => ({ line });

describe("terminal command region boundary", () => {
    it("ends at the next confirmed anchor of the same authority and session", () => {
        const marks = [confirmed(10, "command-a"), confirmed(14, "command-b")];
        expect(commandRegionBoundary(marks, "command-a")).toEqual({ startLine: 10, nextLine: 14 });
    });

    it("refuses a boundary from an unconfirmed next anchor", () => {
        // The raw `B` mark of command B is in the buffer but its identity was never
        // confirmed: it must not truncate command A's output.
        const marks = [confirmed(10, "command-a"), unconfirmed(14)];
        expect(commandRegionBoundary(marks, "command-a")).toBeUndefined();
    });

    it("refuses a boundary from another authority's confirmed anchor", () => {
        const marks = [confirmed(10, "command-a"), confirmed(14, "command-b", "hosted-sidechannel")];
        expect(commandRegionBoundary(marks, "command-a")).toBeUndefined();
    });

    it("refuses a boundary from another session", () => {
        const marks = [confirmed(10, "command-a"), confirmed(14, "command-b", "terminal-osc", "epoch-2")];
        expect(commandRegionBoundary(marks, "command-a")).toBeUndefined();
    });

    it("refuses an unproven mark that sits before a proven boundary", () => {
        // Command C's confirmed anchor exists, but an unconfirmed mark lies between A
        // and C: the end of A's region cannot be proven.
        const marks = [confirmed(10, "command-a"), unconfirmed(12), confirmed(16, "command-c")];
        expect(commandRegionBoundary(marks, "command-a")).toBeUndefined();
    });

    it("ignores earlier and later marks that are outside the boundary decision", () => {
        const marks = [confirmed(4, "command-0"), confirmed(10, "command-a"), confirmed(14, "command-b"), unconfirmed(20)];
        // The pending mark after the proven boundary does not affect A's region.
        expect(commandRegionBoundary(marks, "command-a")).toEqual({ startLine: 10, nextLine: 14 });
    });

    it("allows the newest command to end at the live cursor line", () => {
        const marks = [confirmed(10, "command-a"), confirmed(14, "command-b")];
        // No later mark at all: the region ends at the cursor line (the caller's bound).
        expect(commandRegionBoundary(marks, "command-b")).toEqual({ startLine: 14 });
    });

    it("refuses a command whose own mark is not confirmed", () => {
        expect(commandRegionBoundary([unconfirmed(10)], "command-a")).toBeUndefined();
        expect(commandRegionBoundary([], "command-a")).toBeUndefined();
        expect(commandRegionBoundary([confirmed(10, "command-a")], "")).toBeUndefined();
    });

    it("takes the earliest confirmed mark of the command itself", () => {
        const marks = [confirmed(12, "command-a"), confirmed(10, "command-a"), confirmed(18, "command-b")];
        expect(commandRegionBoundary(marks, "command-a")).toEqual({ startLine: 10, nextLine: 18 });
    });

    it("is what the production reader uses for its boundary", () => {
        // The production path must hand the registry's confirmation state to the
        // boundary decision instead of trusting every marker line.
        expect(termwrapSource).toContain("commandRegionBoundary(marks, commandId)");
        expect(termwrapSource).toContain("this.visualAnchorRegistry.get(nonce)");
        expect(termwrapSource).toMatch(/trusted\s*\?\s*\{/);
        expect(termwrapSource).not.toMatch(/lines\.filter\(\(line\) => line > marker\.line\)/);
    });
});

describe("terminal command output region", () => {
    it("starts after the command's own line and stops before the next command's line", () => {
        // Both boundary lines carry prompt text and an echoed command; the region is
        // exactly the lines between them.
        expect(commandRegionRange({ startLine: 10, nextLine: 14, cursorLine: 20 })).toEqual({ start: 11, end: 14 });
    });

    it("uses the live cursor line for the newest command", () => {
        expect(commandRegionRange({ startLine: 4, cursorLine: 9 })).toEqual({ start: 5, end: 9 });
    });

    it("collapses to an empty region when nothing was printed", () => {
        // The next command starts on the very next line: no output lines exist.
        expect(commandRegionRange({ startLine: 10, nextLine: 11, cursorLine: 20 })).toEqual({ start: 11, end: 11 });
        // A cursor that has not moved past the command line is still an empty region,
        // never an inverted one.
        expect(commandRegionRange({ startLine: 10, cursorLine: 10 })).toEqual({ start: 11, end: 11 });
        expect(commandRegionRange({ startLine: 10, cursorLine: 4 })).toEqual({ start: 11, end: 11 });
    });

    it("joins the region and drops the blank boundary lines", () => {
        expect(commandRegionText(["", "first", "second", ""])).toBe("first\nsecond");
        expect(commandRegionText([])).toBe("");
        expect(commandRegionText(["", ""])).toBe("");
    });

    it("keeps blank lines inside the output", () => {
        expect(commandRegionText(["first", "", "third"])).toBe("first\n\nthird");
    });

    it("is only readable while both boundary markers are in the active buffer", () => {
        const bounds = { startLine: 10, nextLine: 14, cursorLine: 20 };
        const readable = { markerValid: true, nextValid: true, bufferLength: 40 };
        expect(commandRegionReadable(bounds, readable)).toBe(true);

        // The command's own marker was disposed (cleared buffer, evicted scrollback).
        expect(commandRegionReadable(bounds, { ...readable, markerValid: false })).toBe(false);
        // The next command's marker is gone, so the end of the region is unknown.
        expect(commandRegionReadable(bounds, { ...readable, nextValid: false })).toBe(false);
        // The region reaches past what the buffer can still read.
        expect(commandRegionReadable(bounds, { ...readable, bufferLength: 12 })).toBe(false);
        expect(commandRegionReadable(bounds, { ...readable, bufferLength: 0 })).toBe(false);
        // The newest command (no next marker) still needs a readable command marker
        // and a cursor line inside the buffer.
        expect(commandRegionReadable({ startLine: 4, cursorLine: 9 }, { markerValid: true, nextValid: false, bufferLength: 12 })).toBe(true);
        expect(commandRegionReadable({ startLine: 4, cursorLine: 9 }, { markerValid: false, nextValid: false, bufferLength: 12 })).toBe(false);
    });
});
