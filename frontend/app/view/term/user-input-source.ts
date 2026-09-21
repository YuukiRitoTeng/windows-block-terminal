// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tells the terminal's user input apart from the answers it generates itself.
 *
 * xterm delivers both through the same `onData` event, so the data cannot say where it came from -
 * but xterm does know, and it says so at the only place every emission passes through:
 * `CoreService.triggerDataEvent(data, wasUserInput)`. User input is emitted with the flag set:
 *
 *   - a key press                       `CoreBrowserTerminal` → `triggerDataEvent(result, true)`
 *   - a paste                           `Clipboard` → `triggerDataEvent(text, true)`
 *   - text composed with an IME         `CompositionHelper` → `triggerDataEvent(input, true)`, and
 *                                       that one is deferred through `setTimeout(..., 0)`
 *   - the public `Terminal.input()`     `CoreTerminal` → `triggerDataEvent(data, wasUserInput)`
 *
 * while the answers xterm produces for a program come through with the flag unset - device
 * attributes, cursor position, focus reports, colour replies (`CoreBrowserTerminal` lines 217, 271,
 * 295, 1295, 1297, 1310, 1315 all call `triggerDataEvent(...)` without it).
 *
 * Seaming there means no timing assumption (a deferred composition is still flagged) and no payload
 * inspection: the classification is xterm's own.
 */

import type { Terminal } from "@xterm/xterm";

export interface UserInputSeam {
    /** False when this xterm version does not expose the seam; nothing is reported then. */
    installed: boolean;
    /** Restores the original method. */
    uninstall(): void;
}

/**
 * Reports every emission xterm classifies as user input.
 *
 * `onUserInput` receives the exact data being sent to the terminal. The data is still delivered to
 * xterm unchanged, so this only observes.
 */
export function installUserInputSeam(terminal: Terminal, onUserInput: (data: string) => void): UserInputSeam {
    const coreService = (terminal as any)?._core?.coreService;
    const original = coreService?.triggerDataEvent;
    if (typeof original !== "function") {
        return { installed: false, uninstall: () => {} };
    }

    const seam = (data: string, wasUserInput: boolean = false) => {
        if (wasUserInput === true && typeof data === "string" && data.length > 0) {
            onUserInput(data);
        }
        return original.call(coreService, data, wasUserInput);
    };
    coreService.triggerDataEvent = seam;

    return {
        installed: true,
        uninstall: () => {
            // Only ever undo this seam, and put the original method back as it was found.
            if (coreService.triggerDataEvent === seam) {
                coreService.triggerDataEvent = original;
            }
        },
    };
}
