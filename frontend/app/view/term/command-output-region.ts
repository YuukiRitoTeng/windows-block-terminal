// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The user-visible output of a command on the terminal authority.
 *
 * The in-band integration cannot prove where a command's last byte landed: the
 * host may write a command's rendered output after the finish frame it also
 * writes. What is exact is the terminal itself - the marker the integration emits
 * when the command starts, and the marker of the next command (or the live cursor
 * line for the newest one). The region between them is what the user sees, and it
 * is the source of truth for that authority's output.
 *
 * Both markers sit on a prompt line: the command's own line carries the prompt
 * and the echoed command, and the next command's line carries the next prompt and
 * its echo. Reading starts after the command's line and stops before the next
 * command's line, so neither the prompt text nor the next command's input can end
 * up in the region.
 *
 * A marker is only usable as a boundary when its identity was confirmed by its own
 * authority: a raw `B` mark is written by whatever produced the bytes, so an
 * unconfirmed, rejected or foreign-authority mark must never decide where a
 * command's output ends.
 */

import { isKnownAuthority } from "./visual-anchor";

export type TerminalRegionProvider = (commandId: string) => string | undefined;

/**
 * One marker in the terminal buffer, together with what is known about it. The
 * identity fields are present only when the anchor registry confirmed that the
 * mark belongs to a command (authority, session and command id all agree).
 */
export type CommandRegionMark = {
    line: number;
    authority?: string;
    sessionEpoch?: string;
    commandId?: string;
};

export type CommandRegionBoundary = {
    /** Buffer line of the command's own confirmed marker. */
    startLine: number;
    /** Buffer line of the next command's confirmed marker, when one exists. */
    nextLine?: number;
};

/**
 * Decides where a command's output region starts and ends, or refuses to decide.
 *
 * `undefined` means the boundary cannot be proven: the command has no confirmed
 * mark of its own, or a mark that is not a confirmed anchor of the same authority
 * and session sits between the command and its end - the region would then be
 * truncated at a place the product cannot justify, so the output is reported as
 * unavailable instead.
 */
export function commandRegionBoundary(
    marks: readonly CommandRegionMark[],
    commandId: string
): CommandRegionBoundary | undefined {
    if (commandId === "") return undefined;
    const own = marks.filter((mark) => mark.commandId === commandId && isKnownAuthority(mark.authority));
    if (own.length === 0) return undefined;
    const startLine = Math.min(...own.map((mark) => mark.line));
    const authority = own[0].authority;
    const sessionEpoch = own[0].sessionEpoch;

    let nextLine: number | undefined;
    const unprovenLines: number[] = [];
    for (const mark of marks) {
        if (mark.line <= startLine) continue;
        const confirmed =
            isKnownAuthority(mark.authority) && mark.authority === authority && mark.sessionEpoch === sessionEpoch;
        if (confirmed && mark.commandId === commandId) {
            // Another confirmed mark of this very command says nothing about where its
            // output ends: the boundary is the next command.
            continue;
        }
        if (confirmed) {
            nextLine = nextLine == null ? mark.line : Math.min(nextLine, mark.line);
        } else {
            // A pending, rejected or foreign-authority mark: it must not bound the region.
            unprovenLines.push(mark.line);
        }
    }
    if (nextLine == null) {
        if (unprovenLines.length > 0) return undefined;
        return { startLine };
    }
    if (unprovenLines.some((line) => line < nextLine)) return undefined;
    return { startLine, nextLine };
}

export type CommandRegionBounds = {
    /** Buffer line of the command's own marker. */
    startLine: number;
    /** Buffer line of the next command's marker, when one exists. */
    nextLine?: number;
    /** Live cursor line, used as the end for the newest command. */
    cursorLine: number;
};

export type CommandRegionValidity = {
    /** The command's own marker is alive in the buffer generation the terminal is showing. */
    markerValid: boolean;
    /** The next command's marker, when one is used, is alive in that same generation. */
    nextValid: boolean;
    /** Lines the active buffer can still read (older lines were trimmed away). */
    bufferLength: number;
};

/**
 * A region may only be read when both boundaries are provably still in the active
 * buffer. Scrollback eviction, a cleared buffer or a disposed marker all invalidate
 * a region: the caller then reports the output as unavailable instead of copying a
 * clamped, truncated region.
 */
export function commandRegionReadable(bounds: CommandRegionBounds, validity: CommandRegionValidity): boolean {
    if (!validity.markerValid) return false;
    const { start, end } = commandRegionRange(bounds);
    if (validity.bufferLength <= 0) return false;
    if (bounds.startLine < 0 || bounds.cursorLine < 0) return false;
    if (bounds.nextLine != null && bounds.nextLine < 0) return false;
    if (start < 0 || end < 0) return false;
    if (start > validity.bufferLength || end > validity.bufferLength) return false;
    if (bounds.nextLine != null) {
        if (!validity.nextValid) return false;
        if (bounds.nextLine > validity.bufferLength) return false;
    }
    return true;
}

/** Resolves the half-open buffer-line range that holds a command's output. */
export function commandRegionRange(bounds: CommandRegionBounds): { start: number; end: number } {
    const start = bounds.startLine + 1;
    const end = bounds.nextLine ?? bounds.cursorLine;
    return { start, end: end > start ? end : start };
}

/** Joins the region's lines, dropping the blank tail the boundary lines leave. */
export function commandRegionText(lines: string[]): string {
    const trimmed = [...lines];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === "") trimmed.pop();
    while (trimmed.length > 0 && trimmed[0].trim() === "") trimmed.shift();
    return trimmed.join("\n");
}
