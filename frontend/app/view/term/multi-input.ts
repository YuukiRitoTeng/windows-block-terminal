// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-input: one switch for the tab, honoured by every basic terminal in it.
 *
 * The switch is a mode of the tab, not a property of whichever pane happened to be focused when it was
 * flipped. So the decision to broadcast is taken **when input is produced**, from the live switch, and
 * any basic terminal that produces user input broadcasts it to the other basic terminals:
 *
 *   - a terminal whose wrapper is re-created after the switch was turned on (any change to the
 *     terminal settings, the font size, the connection, or the block) still broadcasts, because the
 *     switch is read per emission rather than baked into the wrapper when it was armed;
 *   - the pane the user actually types in is the pane that broadcasts. Nothing depends on which pane
 *     held the layout focus at the moment the switch was flipped, and nothing is lost when focus moves.
 *
 * Nothing here inspects the payload: the terminal's own classification of its emissions (see
 * `user-input-source.ts`) decides what counts as user input, and this module only decides where it goes.
 */

export type Getter = (atom: any) => any;

/** The key that toggles the tab's multi-input mode. */
export const MultiInputToggleKey = "Ctrl:Shift:i";

/** A terminal that can take part: it can be typed into, and input can be sent to it. */
export interface MultiInputPane {
    isBasicTerm(getFn: Getter): boolean;
    sendUserInputToController(data: string): void;
}

/** The part of a terminal wrapper this module arms. */
export interface MultiInputTerminal {
    multiInputCallback: ((data: string) => void) | null;
}

/**
 * The state the switch should have after it is pressed.
 *
 * Turning multi-input off is always allowed; turning it on needs two or more basic terminals, since
 * one terminal has nothing to broadcast to.
 */
export function nextMultiInputState(current: boolean, basicTermCount: number): boolean {
    if (current) {
        return false;
    }
    return basicTermCount > 1;
}

/** Every other basic terminal in the tab: the panes a broadcast types into, in layout order. */
export function multiInputTargets<T extends MultiInputPane>(panes: T[], source: T, getFn: Getter): T[] {
    return panes.filter((pane) => pane !== source && pane.isBasicTerm(getFn));
}

/**
 * Sends user input to the other basic terminals.
 *
 * A broadcast types into those panes on purpose, which is why the panes mark themselves as used -
 * that is the callers' business (`sendUserInputToController`), not this function's.
 *
 * @returns how many panes were typed into.
 */
export function broadcastToOtherPanes<T extends MultiInputPane>(
    panes: T[],
    source: T,
    getFn: Getter,
    data: string
): number {
    const targets = multiInputTargets(panes, source, getFn);
    for (const target of targets) {
        target.sendUserInputToController(data);
    }
    return targets.length;
}

/**
 * Arms one terminal to broadcast its own user input while the switch is on.
 *
 * `isOn` and `isBasicTerm` are asked at the moment input is produced, never cached, so arming once per
 * terminal wrapper is enough - including a wrapper created long after the switch was turned on.
 *
 * @returns a detach function that only undoes this arming.
 */
export function armMultiInputBroadcast(options: {
    terminal: MultiInputTerminal;
    isOn: () => boolean;
    isBasicTerm: () => boolean;
    broadcast: (data: string) => void;
}): () => void {
    const { terminal, isOn, isBasicTerm, broadcast } = options;
    const callback = (data: string) => {
        if (!isOn() || !isBasicTerm()) {
            return;
        }
        broadcast(data);
    };
    terminal.multiInputCallback = callback;
    return () => {
        if (terminal.multiInputCallback === callback) {
            terminal.multiInputCallback = null;
        }
    };
}
