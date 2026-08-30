// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import type { TermViewModel } from "./term-model";

export async function clearProductHistory(
    blockId: string,
    service: Pick<services.CommandJournalServiceType, "ClearVisualHistory">,
    clearTerminal: () => void
): Promise<void> {
    // The terminal is cleared only after the product visibility transaction succeeds.
    await service.ClearVisualHistory(blockId);
    clearTerminal();
}

export function clearProductHistoryForModel(model: Pick<TermViewModel, "blockId" | "termRef">): Promise<void> {
    return clearProductHistory(model.blockId, services.CommandJournalService, () => model.termRef.current?.clearVisualBuffer());
}
