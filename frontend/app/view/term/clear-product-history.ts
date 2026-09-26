// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as services from "@/store/services";
import type { TermViewModel } from "./term-model";


export type ProductClearOutcome = "cleared" | "unsupported";

/** The terminal side of a product clear: it owns the boundary and the display mutation. */
export type ProductClearHost = {
    withProductClearBoundary<T>(
        run: (session: { prepare(): boolean; apply(): Promise<void> }) => Promise<T>
    ): Promise<T | null>;
};

/**
 * Global Clear is a display-only terminal transaction behind a backend visibility transaction.
 *
 * Order: preflight the buffer state -> backend `ClearVisualHistory` -> xterm's own clear().
 * Nothing is ever sent to the shell. When the buffer state cannot be cleared safely (upstream
 * xterm.js#5992: cursor at home with content), the whole clear is refused: the backend
 * generation does not advance and the screen is left untouched.
 */
export async function clearProductHistory(
    blockId: string,
    service: Pick<services.CommandJournalServiceType, "ClearVisualHistory">,
    host: ProductClearHost | null
): Promise<ProductClearOutcome> {
    if (host == null) {
        return "unsupported";
    }
    const outcome = await host.withProductClearBoundary(async (session) => {
        // Fail-safe first: a buffer state the public clear cannot handle must not commit the
        // backend visibility transaction either.
        if (!session.prepare()) {
            return "unsupported" as ProductClearOutcome;
        }
        await service.ClearVisualHistory(blockId);
        await session.apply();
        return "cleared" as ProductClearOutcome;
    });
    return outcome ?? "unsupported";
}

export function clearProductHistoryForModel(model: Pick<TermViewModel, "blockId" | "termRef">): Promise<ProductClearOutcome> {
    const wrap = model.termRef.current;
    return clearProductHistory(model.blockId, services.CommandJournalService, wrap == null ? null : (wrap as ProductClearHost));
}
