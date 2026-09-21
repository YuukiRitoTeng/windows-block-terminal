// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * "The user put input into this terminal."
 *
 * A Snap-created filler pane may only be reclaimed by a smaller preset while nobody has used it, so
 * every path that sends the user's input to a terminal has to record that fact.
 *
 * What does *not* count is the terminal's data channel: xterm answers the program's queries (device
 * attributes, cursor position, colours) through the same channel that carries typing, so keying this
 * marker off that channel made a shell that merely started look used. The marker is written from the
 * events only a user can produce instead - a key press, a paste, dropped files, composed text - and
 * from the places where the app itself turns a user action into terminal input.
 */

import { SNAP_TOUCHED_META_KEY, shouldMarkSnapTerminalTouched } from "@/app/workspace/snapReclaim";
import { globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

/**
 * Marks a terminal as used, once.
 *
 * Safe for any block: only blocks carrying the Snap provenance marker are ever written, and only the
 * first write goes out.
 */
export function markSnapTerminalTouched(blockId: string): void {
    if (blockId == null || blockId === "") {
        return;
    }
    const blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
    const meta = globalStore.get(blockAtom)?.meta;
    if (!shouldMarkSnapTerminalTouched(meta)) {
        return;
    }
    RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("block", blockId),
        meta: { [SNAP_TOUCHED_META_KEY]: true } as MetaType,
    });
}
