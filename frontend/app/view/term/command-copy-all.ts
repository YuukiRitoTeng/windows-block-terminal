// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import type { TerminalRegionProvider } from "./command-output-region";
import { MAX_PRESENTATION_BYTES, canCopyOutput, projectOutput, projectTerminalAuthorityOutput } from "./command-history";

export type CopyAllResult = { ok: true } | { ok: false; reason: string };

/**
 * The terminal authority's output is the terminal itself: the region the
 * integration's markers delimit is exactly what the user saw, so it is used
 * instead of the journal copy, whose completeness the in-band byte stream cannot
 * prove. Every other authority keeps reading the journal.
 */
function terminalAuthorityOutput(record: RecordView, region?: TerminalRegionProvider): string | undefined {
    if (record.authority !== "terminal-osc" || region == null) return undefined;
    return region(record.id);
}

/**
 * The terminal authority's output text.
 *
 * The terminal region the integration's markers delimit is what the user saw, so it
 * wins while it is readable. When it is not (the buffer was cleared, or the marker
 * scrolled away) the finished record still holds the bytes the command printed, and
 * that journal copy is used instead - the record, not the marker, is the identity.
 */
async function terminalAuthorityText(
    record: RecordView,
    service: Pick<services.CommandJournalServiceType, "GetOutput">,
    region?: TerminalRegionProvider
): Promise<string | undefined> {
    const regionText = terminalAuthorityOutput(record, region);
    if (regionText !== undefined) return regionText;
    if (!terminalAuthorityRecordUsable(record)) return undefined;
    if (record.output_stored_bytes === 0 && record.output_total_bytes === 0) return "";
    let output: OutputView;
    try {
        output = await service.GetOutput(record.id);
    } catch {
        return undefined;
    }
    const projection = projectTerminalAuthorityOutput(record, output?.data ?? "");
    return projection.kind === "safe" ? projection.text : undefined;
}

export function canCopyRecordOutput(record: RecordView, region?: TerminalRegionProvider): boolean {
    if (record.authority === "terminal-osc") {
        // A readable region only decides which authoritative source the copy uses. It never
        // bypasses record safety: the button is enabled by the same gate the copy path applies.
        return terminalAuthorityRecordUsable(record);
    }
    return canCopyOutput(record);
}

/**
 * The record-only gate for the terminal authority. It is the projection's own gate, so
 * the button can never be enabled for a copy the projection would refuse.
 */
function terminalAuthorityRecordUsable(record: RecordView): boolean {
    return (
        record.state !== "running" &&
        record.output_state === "closed" &&
        record.execution_mode !== "interactive" &&
        !record.output_truncated &&
        record.output_stored_bytes <= MAX_PRESENTATION_BYTES
    );
}

export async function copyCommandAndOutput(
    record: RecordView,
    service: Pick<services.CommandJournalServiceType, "GetOutput"> = services.CommandJournalService,
    clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
    region?: TerminalRegionProvider
): Promise<CopyAllResult> {
    if (record.authority === "terminal-osc") {
        // Fail closed before any source is read: the region is authoritative for the *text*, not
        // for whether copying this record is allowed.
        if (!terminalAuthorityRecordUsable(record)) {
            return {
                ok: false,
                reason: "Output copy disabled because the product data is incomplete, unsafe, or truncated.",
            };
        }
        const text = await terminalAuthorityText(record, service, region);
        if (text === undefined) {
            return { ok: false, reason: "Terminal output unavailable for this command." };
        }
        try {
            await clipboard.writeText(`${record.command}\n${text}`);
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: `Clipboard unavailable: ${String(error)}` };
        }
    }
    if (!canCopyOutput(record)) {
        return {
            ok: false,
            reason: "Output copy disabled because the product data is incomplete, unsafe, or truncated.",
        };
    }
    let output: OutputView;
    try {
        output = await service.GetOutput(record.id);
    } catch (error) {
        return { ok: false, reason: `Output unavailable: ${String(error)}` };
    }
    const projection = projectOutput(record, output?.data ?? "");
    if (projection.kind !== "safe") return { ok: false, reason: projection.reason };
    try {
        await clipboard.writeText(`${record.command}\n${projection.text}`);
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: `Clipboard unavailable: ${String(error)}` };
    }
}

/** Copies only the command's output, from the same source as Copy All. */
export async function copyCommandOutput(
    record: RecordView,
    service: Pick<services.CommandJournalServiceType, "GetOutput"> = services.CommandJournalService,
    clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
    region?: TerminalRegionProvider
): Promise<CopyAllResult> {
    if (record.authority === "terminal-osc") {
        // Fail closed before any source is read: the region is authoritative for the *text*, not
        // for whether copying this record is allowed.
        if (!terminalAuthorityRecordUsable(record)) {
            return {
                ok: false,
                reason: "Output copy disabled because the product data is incomplete, unsafe, or truncated.",
            };
        }
        const text = await terminalAuthorityText(record, service, region);
        if (text === undefined) {
            return { ok: false, reason: "Terminal output unavailable for this command." };
        }
        try {
            await clipboard.writeText(text);
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: `Clipboard unavailable: ${String(error)}` };
        }
    }
    if (!canCopyOutput(record)) {
        return {
            ok: false,
            reason: "Output copy disabled because the product data is incomplete, unsafe, or truncated.",
        };
    }
    let output: OutputView;
    try {
        output = await service.GetOutput(record.id);
    } catch (error) {
        return { ok: false, reason: `Output unavailable: ${String(error)}` };
    }
    const projection = projectOutput(record, output?.data ?? "");
    if (projection.kind !== "safe") return { ok: false, reason: projection.reason };
    try {
        await clipboard.writeText(projection.text);
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: `Clipboard unavailable: ${String(error)}` };
    }
}
