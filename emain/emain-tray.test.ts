// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type * as TrayModule from "./emain-tray";

/**
 * Tray module tests. The tray is created through electron's Tray/Menu APIs, so this exercises the
 * real module with those boundaries replaced, and asserts the parts the product contract depends on:
 * exactly the three menu actions, left click restoring the window, and "Quit" being a real quit
 * (user-confirmed + app.quit) rather than a hide.
 *
 * The module is transpiled and run in a vm context so the electron boundary can be replaced; the
 * declared return type keeps the assertions type-checked against the real module surface.
 */
function loadTrayModule(overrides: { trayThrows?: boolean; iconPath?: string } = {}): {
    mod: typeof TrayModule;
    clickHandlers: Record<string, Function>;
    emitMetricsChanged: () => void;
    metricHandlers: Record<string, Function>;
    metricListenerCount: () => number;
    menuTemplate: any[];
    quit: ReturnType<typeof vi.fn>;
    setUserConfirmedQuit: ReturnType<typeof vi.fn>;
    setImage: ReturnType<typeof vi.fn>;
} {
    const clickHandlers: Record<string, Function> = {};
    const menuTemplate: any[] = [];
    const quit = vi.fn();
    const setUserConfirmedQuit = vi.fn();
    const setImage = vi.fn();
    const metricHandlers: Record<string, Function> = {};
    const metricListeners: Function[] = [];

    class FakeTray {
        // Per-instance, like the real Tray: a destroyed tray must not make a later one look
        // destroyed, otherwise destroy/recreate tests cannot observe the recreated tray.
        destroyed = false;
        constructor(_image: any) {
            if (overrides.trayThrows) {
                throw new Error("no tray in this environment");
            }
        }
        setToolTip() {}
        setImage(image: any) {
            setImage(image);
        }
        setContextMenu(menu: any) {
            menuTemplate.push(...(menu?.template ?? []));
        }
        on(event: string, cb: Function) {
            clickHandlers[event] = cb;
        }
        isDestroyed() {
            return this.destroyed;
        }
        destroy() {
            this.destroyed = true;
        }
    }

    const electron = {
        app: { quit },
        Tray: FakeTray,
        Menu: {
            buildFromTemplate: (template: any[]) => ({ template }),
        },
        // `createFromPath` reports an empty image for anything the "build" does not ship, which is
        // how the real API behaves for a missing file -- the blank-tray-icon defect.
        nativeImage: {
            createFromPath: (p: string) =>
                overrides.iconPath && p === overrides.iconPath
                    ? { isEmpty: () => false, id: p }
                    : { isEmpty: () => true, id: p },
            createEmpty: () => ({ isEmpty: () => true }),
        },
        // Listener bookkeeping mirrors a real EventEmitter: attach/detach must balance, which is what
        // the destroy/recreate regression asserts.
        screen: {
            on: (event: string, cb: Function) => {
                metricHandlers[event] = cb;
                metricListeners.push(cb);
            },
            removeListener: (event: string, cb: Function) => {
                const idx = metricListeners.indexOf(cb);
                if (idx >= 0) {
                    metricListeners.splice(idx, 1);
                }
                if (metricListeners.length === 0) {
                    delete metricHandlers[event];
                }
            },
        },
    };
    /** Emits as electron would: only the currently attached listeners fire. */
    const emitMetricsChanged = () => {
        for (const cb of [...metricListeners]) {
            cb();
        }
    };

    const cache = new Map<string, any>();
    function load(name: string): any {
        if (name === "electron") return electron;
        if (name === "path") return require("path");
        if (name === "./emain-activity") return { getGlobalIsQuitting: () => false, setUserConfirmedQuit };
        if (name === "./emain-platform") return { getElectronAppBasePath: () => "/app" };
        if (cache.has(name)) return cache.get(name);
        throw new Error(`Unexpected dependency: ${name}`);
    }

    // Transpile the real module with the boundaries above.
    const ts = require("typescript");
    const { readFileSync } = require("fs");
    const vm = require("vm");
    const source = readFileSync(new URL("./emain-tray.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    const globals = {
        require: load,
        module,
        exports: module.exports,
        console,
        URL,
        // The real loader reads process.resourcesPath for the packaged icon copy.
        process: { ...process, resourcesPath: "C:\\app\\resources" },
    };
    vm.runInNewContext(code, globals, { filename: "emain-tray.ts" });
    return {
        mod: module.exports as typeof TrayModule,
        clickHandlers,
        emitMetricsChanged,
        metricHandlers,
        metricListenerCount: () => metricListeners.length,
        menuTemplate,
        quit,
        setUserConfirmedQuit,
        setImage,
    };
}

/** The packaged icon path the real loader tries first, given resourcesPath is stubbed. */
const PACKAGED_ICON = require("path").join("C:\\app\\resources", "icon.ico");
const DEV_ICON = require("path").join("/app", "build", "icon.ico");

describe("system tray", () => {
    it("creates a tray whose menu is exactly show, new window and quit", () => {
        const { mod, menuTemplate } = loadTrayModule({ iconPath: PACKAGED_ICON });
        const tray = mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        expect(tray).not.toBeNull();
        const labels = menuTemplate.filter((item) => item.type !== "separator").map((item) => item.label);
        expect(labels).toEqual(["Show Windows Block Terminal", "New Window", "Quit"]);
        expect(menuTemplate.some((item) => item.type === "separator")).toBe(true);
    });

    it("refuses to build a tray when no icon can be loaded", () => {
        // The reported defect: an empty NativeImage produced a tray entry with a blank icon. A tray
        // must never be created without a real image, because close-to-tray relies on the tray being
        // genuinely usable.
        const { mod } = loadTrayModule({ iconPath: undefined });
        expect(mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() })).toBeNull();
        expect(mod.isTrayAvailable()).toBe(false);
    });

    it("falls back to the repository icon when the packaged copy is missing", () => {
        const { mod } = loadTrayModule({ iconPath: DEV_ICON });
        expect(mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() })).not.toBeNull();
        expect(mod.isTrayAvailable()).toBe(true);
    });

    it("re-applies the icon when display metrics change, so a DPI move cannot leave it blank", () => {
        const { mod, emitMetricsChanged, metricListenerCount, setImage } = loadTrayModule({ iconPath: PACKAGED_ICON });
        mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        expect(metricListenerCount()).toBe(1);
        setImage.mockClear();
        emitMetricsChanged();
        expect(setImage).toHaveBeenCalledTimes(1);
    });

    it("balances the metrics listener across destroy and recreate", () => {
        // Regression: the handler used to stay attached after destroyTray(), so a recreate left two
        // listeners and one metrics change drove setImage twice.
        const { mod, emitMetricsChanged, metricListenerCount, setImage } = loadTrayModule({ iconPath: PACKAGED_ICON });
        mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        expect(metricListenerCount()).toBe(1);
        mod.destroyTray();
        expect(metricListenerCount()).toBe(0);
        expect(mod.isTrayAvailable()).toBe(false);

        mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        expect(metricListenerCount()).toBe(1);
        setImage.mockClear();
        emitMetricsChanged();
        expect(setImage).toHaveBeenCalledTimes(1);
    });

    it("drives only the current tray after a recreate", () => {
        const { mod, emitMetricsChanged, setImage } = loadTrayModule({ iconPath: PACKAGED_ICON });
        mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        mod.destroyTray();
        mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        setImage.mockClear();
        emitMetricsChanged();
        // Exactly one call proves the destroyed tray's handler is gone: a stale handler would add a
        // second call against the same (new) tray.
        expect(setImage).toHaveBeenCalledTimes(1);
    });

    it("restores the window on left click", () => {
        const { mod, clickHandlers } = loadTrayModule({ iconPath: PACKAGED_ICON });
        const showWindow = vi.fn();
        mod.createTray({ showWindow, openNewWindow: vi.fn() });
        expect(typeof clickHandlers["click"]).toBe("function");
        clickHandlers["click"]();
        expect(showWindow).toHaveBeenCalledTimes(1);
    });

    it("opens a new window from the menu without touching the session", () => {
        const { mod, menuTemplate } = loadTrayModule({ iconPath: PACKAGED_ICON });
        const openNewWindow = vi.fn();
        mod.createTray({ showWindow: vi.fn(), openNewWindow });
        const item = menuTemplate.find((entry) => entry.label === "New Window");
        item.click();
        expect(openNewWindow).toHaveBeenCalledTimes(1);
    });

    it("treats Quit as a real quit, not a hide", () => {
        const { mod, menuTemplate, quit, setUserConfirmedQuit } = loadTrayModule({ iconPath: PACKAGED_ICON });
        mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        const item = menuTemplate.find((entry) => entry.label === "Quit");
        item.click();
        // Marking the quit user-confirmed is what keeps the confirm-quit prompt from blocking a
        // quit the user explicitly asked for; app.quit() is the same exit path the rest of the app
        // uses, so before-quit runs and wavesrv is torn down with its stdin.
        expect(setUserConfirmedQuit).toHaveBeenCalledWith(true);
        expect(quit).toHaveBeenCalledTimes(1);
    });

    it("reports availability only while a live tray exists", () => {
        const { mod } = loadTrayModule({ iconPath: PACKAGED_ICON });
        expect(mod.isTrayAvailable()).toBe(false);
        mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        expect(mod.isTrayAvailable()).toBe(true);
        mod.destroyTray();
        expect(mod.isTrayAvailable()).toBe(false);
    });

    it("never claims availability when the tray constructor fails", () => {
        // Without a tray there is no way back from a hidden window, so the close path must keep the
        // plain quit behaviour. This is the signal emain-window.ts relies on.
        // A valid icon is supplied on purpose: otherwise the missing-icon path would short-circuit
        // before the constructor ever throws, and the test would pass without exercising it.
        const { mod, metricListenerCount } = loadTrayModule({ trayThrows: true, iconPath: PACKAGED_ICON });
        const tray = mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        expect(tray).toBeNull();
        expect(mod.isTrayAvailable()).toBe(false);
        // The constructor throws before the listener is attached, and nothing may be left behind.
        expect(metricListenerCount()).toBe(0);
    });

    it("does not create a second tray on repeated calls", () => {
        // Reaches the successful branch: with no icon the first call would return early and the
        // assertion would hold trivially.
        const { mod, menuTemplate } = loadTrayModule({ iconPath: PACKAGED_ICON });
        expect(mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() })).not.toBeNull();
        const firstCount = menuTemplate.length;
        expect(firstCount).toBeGreaterThan(0);
        mod.createTray({ showWindow: vi.fn(), openNewWindow: vi.fn() });
        expect(menuTemplate.length).toBe(firstCount);
        expect(mod.isTrayAvailable()).toBe(true);
    });
});
