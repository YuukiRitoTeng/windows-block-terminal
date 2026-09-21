// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import { canCopyOutput, projectOutput } from "./command-history";

export type CopyAllResult = { ok: true } | { ok: false; reason: string };

export async function copyCommandAndOutput(
    record: RecordView,
    service: Pick<services.CommandJournalServiceType, "GetOutput"> = services.CommandJournalService,
    clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard
): Promise<CopyAllResult> {
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
