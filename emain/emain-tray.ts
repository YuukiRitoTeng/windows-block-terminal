// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Windows / tray shell integration.
 *
 * Closing the last visible window hides it to the tray instead of tearing the application down, so
 * the terminal sessions and the backend keep running. The tray then offers the three actions the
 * product needs and nothing more:
 *
 *  - restore / show the most recent window and focus it,
 *  - open a new window,
 *  - quit for real.
 *
 * "Quit" must be a real exit: it goes through the same `setUserConfirmedQuit(true)` + `app.quit()`
 * path the rest of the application uses, so `before-quit` runs and wavesrv is torn down with its
 * stdin. Nothing here invents a second shutdown path, and nothing here touches the window close
 * confirmation logic -- the close handler still asks its questions and only then decides to hide.
 */

import { app, Menu, nativeImage, screen, Tray } from "electron";
import * as path from "path";
import { getGlobalIsQuitting, setUserConfirmedQuit } from "./emain-activity";
import { getElectronAppBasePath } from "./emain-platform";

let tray: Tray | null = null;

/** Provided by emain-window so this module does not have to import it (which would be circular). */
export type TrayActionHandlers = {
    /** Show the most recent window, creating one only when none exists. */
    showWindow: () => void;
    /** Open an additional window. */
    openNewWindow: () => void;
};

/**
 * Candidate icon paths, most authoritative first. The tray icon has to be a real file on disk: the
 * notification area belongs to Explorer, so it cannot read an image that only exists inside app.asar.
 * `process.resourcesPath/icon.ico` is the packaged copy declared in electron-builder.config.cjs
 * (extraResources); the repo path covers a development run.
 */
function trayIconCandidates(): string[] {
    return [
        path.join(process.resourcesPath ?? "", "wbt-tray.png"),
        path.join(process.resourcesPath ?? "", "icon.ico"),
        path.join(getElectronAppBasePath(), "build", "wbt-tray.png"),
        path.join(getElectronAppBasePath(), "build", "icon.ico"),
    ];
}

/**
 * Load the tray image, refusing to fall back to an empty image.
 *
 * Returning an empty NativeImage produced a tray entry with no visible icon, which is exactly the
 * blank-icon defect reported from a real Windows session. A Tray needs *some* image, so a failure
 * here has to surface as "no tray" instead of "invisible tray", which also keeps the close-to-tray
 * guard honest (no tray means the window keeps the ordinary quit behaviour).
 */
function loadTrayImage(): Electron.NativeImage {
    const tried: string[] = [];
    for (const candidate of trayIconCandidates()) {
        if (!candidate) {
            continue;
        }
        tried.push(candidate);
        try {
            const image = nativeImage.createFromPath(candidate);
            if (!image.isEmpty()) {
                return image;
            }
        } catch (_) {
            // try the next candidate
        }
    }
    console.log(`tray: no usable tray icon found (tried: ${tried.join(", ")})`);
    return null;
}

/**
 * Registered with `screen` while a tray exists, and removed again when it is destroyed.
 *
 * The handler is stored rather than anonymous so it can be unregistered: leaving it attached after
 * `destroyTray()` meant a recreate would accumulate listeners, and both the stale and the new
 * handler would drive the new tray on a single metrics change.
 */
let metricsHandler: ((...args: any[]) => void) | null = null;

function detachMetricsHandler(): void {
    if (metricsHandler == null) {
        return;
    }
    try {
        screen?.removeListener?.("display-metrics-changed", metricsHandler);
    } catch (_) {
        // a host without the full screen API simply has nothing to detach
    }
    metricsHandler = null;
}

function attachMetricsHandler(): void {
    detachMetricsHandler();
    metricsHandler = () => {
        const current = tray;
        if (current == null || current.isDestroyed()) {
            return;
        }
        const refreshed = loadTrayImage();
        if (refreshed != null) {
            current.setImage(refreshed);
        }
    };
    try {
        screen?.on?.("display-metrics-changed", metricsHandler);
    } catch (e) {
        console.log("tray: could not subscribe to display metric changes:", e?.message ?? e);
        metricsHandler = null;
    }
}

export function createTray(handlers: TrayActionHandlers): Tray | null {
    if (tray != null) {
        return tray;
    }
    try {
        const image = loadTrayImage();
        if (image == null) {
            tray = null;
            return null;
        }
        tray = new Tray(image);
        tray.setToolTip("Windows Block Terminal");
        // Re-apply the icon when the notification area moves to a different display scale: Windows
        // picks the size from the current DPI, and a stale image can render blank after a move.
        attachMetricsHandler();
        const menu = Menu.buildFromTemplate([
            {
                label: "Show Windows Block Terminal",
                click: () => handlers.showWindow(),
            },
            {
                label: "New Window",
                click: () => handlers.openNewWindow(),
            },
            { type: "separator" },
            {
                label: "Quit",
                click: () => quitFromTray(),
            },
        ]);
        tray.setContextMenu(menu);
        // Left click restores and focuses, which is the conventional tray behaviour.
        tray.on("click", () => handlers.showWindow());
        tray.on("double-click", () => handlers.showWindow());
        return tray;
    } catch (e) {
        console.log("tray: could not create tray icon:", e?.message ?? e);
        // A failure after the listener was attached (for example a constructor or menu failure) must
        // not leave a handler pointing at a tray that does not exist.
        detachMetricsHandler();
        if (tray != null && !tray.isDestroyed()) {
            tray.destroy();
        }
        tray = null;
        return null;
    }
}

export function getTray(): Tray | null {
    return tray;
}

/**
 * Whether closing the last window should hide to the tray rather than exit. Without a live tray icon
 * the user would have no way back, so a missing tray keeps the plain quit behaviour.
 */
export function isTrayAvailable(): boolean {
    return tray != null && !tray.isDestroyed();
}

export function destroyTray(): void {
    // Detach before destroying so a recreate cannot inherit a handler aimed at this tray.
    detachMetricsHandler();
    if (tray != null && !tray.isDestroyed()) {
        tray.destroy();
    }
    tray = null;
}

/**
 * Real quit. Marking the quit as user-confirmed is what the existing window close and single
 * instance paths do, and it makes the confirm-quit prompt skip itself for a user-initiated quit.
 */
export function quitFromTray(): void {
    setUserConfirmedQuit(true);
    app.quit();
}

export function isQuitting(): boolean {
    return getGlobalIsQuitting();
}
