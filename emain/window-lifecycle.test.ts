// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the real class/registered app handlers, replacing only native windows,
// service I/O and timers. This is not an Electron GUI or live session test.
function fixture(platform = "win32") {
    const settings: Record<string, unknown> = { "app:confirmquit": true, "window:savelastwindow": true };
    const pending: Promise<unknown>[] = [];
    const nativeWindows: NativeWindow[] = [];
    const builders: unknown[] = [];
    const env: Record<string, string> = {};
    let dead = false;
    let cursor = { x: 500, y: 300 };
    const primary = {
        bounds: { x: 0, y: 0, width: 3840, height: 2160 },
        workArea: { x: 0, y: 0, width: 3840, height: 2120 },
        workAreaSize: { width: 3840, height: 2120 },
    };
    const secondary = {
        bounds: { x: -1600, y: 0, width: 1600, height: 900 },
        workArea: { x: -1600, y: 0, width: 1600, height: 860 },
        workAreaSize: { width: 1600, height: 860 },
    };
    const showDialog = vi.fn(() => 0);
    const closeBackend = vi.fn();
    const stopUpdater = vi.fn();
    const updater = { status: "idle", stop: stopUpdater };
    const configRead = vi.fn(async () => ({ settings }));
    const cache = new Map<string, { exports: any }>();
    const event = () => ({
        defaultPrevented: false,
        preventDefault() {
            this.defaultPrevented = true;
        },
    });

    class NativeWindow extends EventEmitter {
        destroyed = false;
        options: any;
        normalBounds: any;
        contentView = { removeChildView: vi.fn() };
        constructor(options: any) {
            super();
            this.options = options;
            this.normalBounds = { ...options };
            nativeWindows.push(this);
        }
        setMenu() {}
        isDestroyed() {
            return this.destroyed;
        }
        getBounds() {
            return this.options;
        }
        getNormalBounds() {
            return this.normalBounds;
        }
        close() {
            if (this.destroyed) return;
            const e = event();
            this.emit("close", e);
            if (e.defaultPrevented) return;
            this.destroyed = true;
            this.emit("closed");
            if (!nativeWindows.some((w) => !w.destroyed) && builders.length === 0)
                runAppHandler("window-all-closed", event());
        }
        destroy() {
            this.destroyed = true;
        }
    }
    const electronApp = {
        on: (_name: string, callback: Function) => callback,
        quit: vi.fn(() => {
            const e = event();
            runAppHandler("before-quit", e);
            if (!e.defaultPrevented) for (const win of nativeWindows) if (!win.destroyed) win.close();
        }),
    };
    const electron = {
        BaseWindow: NativeWindow,
        app: electronApp,
        dialog: { showMessageBoxSync: showDialog },
        ipcMain: { on() {}, handle() {} },
        globalShortcut: {},
        webContents: { getAllWebContents: () => [] },
        screen: {
            getPrimaryDisplay: () => primary,
            getAllDisplays: () => [primary, secondary],
            getCursorScreenPoint: () => cursor,
            getDisplayMatching: (rect: any) => (rect.x < 0 ? secondary : primary),
            getDisplayNearestPoint: (point: any) => (point.x < 0 ? secondary : primary),
        },
    };
    const services = {
        ClientService: { FocusWindow: vi.fn() },
        ObjectService: {},
        WindowService: { CloseWindow: closeBackend },
        WorkspaceService: { GetWorkspace: async () => ({ tabids: ["one", "two"] }) },
    };
    const globals = {
        console: { log() {}, warn() {}, error() {} },
        process: { env, platform },
        setInterval: () => 1,
        clearInterval() {},
        setTimeout: () => 1,
        clearTimeout() {},
    };
    function load(name: string): any {
        if (name === "electron") return electron;
        if (name === "path") return path;
        if (name === "throttle-debounce") return { debounce: (_ms: number, fn: Function) => fn };
        if (name === "@/app/store/services") return services;
        if (name === "@/app/store/wps") return { waveEventSubscribeSingle() {} };
        if (name === "@/app/store/wshclientapi") return { RpcApi: { GetFullConfigCommand: configRead } };
        if (name === "@/util/util")
            return { fireAndForget: (fn: () => unknown) => pending.push(Promise.resolve().then(fn)) };
        if (name === "emain/emain-events") return { globalEvents: new EventEmitter() };
        if (name === "./emain-log") return { log() {} };
        if (name === "./emain-platform")
            return { unamePlatform: platform, isDev: false, getElectronAppBasePath: () => "/app" };
        if (name === "./emain-tabview") return {};
        if (name === "./emain-wsh") return { ElectronWshClient: {} };
        if (name === "./updater") return { updater };
        if (name === "./emain-wavesrv") return { getIsWaveSrvDead: () => dead };
        if (name === "./emain-builder") return { getAllBuilderWindows: () => builders };
        if (name === "../frontend/util/endpoints") return { getWebServerEndpoint: () => "http://unused" };
        if (!["./emain-window", "./emain-activity", "./emain-util", "./emain-quit"].includes(name)) {
            throw new Error(`Unexpected dependency: ${name}`);
        }
        if (cache.has(name)) return cache.get(name)!.exports;
        const module = { exports: {} };
        cache.set(name, module);
        const source = readFileSync(new URL(`${name}.ts`, import.meta.url), "utf8");
        const code = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText;
        vm.runInNewContext(code, { ...globals, require: load, module, exports: module.exports }, { filename: name });
        return module.exports;
    }
    const activity = load("./emain-activity");
    const windows = load("./emain-window");
    function runAppHandler(name: string, e: ReturnType<typeof event>) {
        const text = readFileSync(new URL("./emain.ts", import.meta.url), "utf8");
        const source = ts.createSourceFile("emain.ts", text, ts.ScriptTarget.Latest, true);
        const statement = source.statements.find(
            (s) =>
                ts.isExpressionStatement(s) &&
                ts.isCallExpression(s.expression) &&
                s.expression.expression.getText(source) === "electronApp.on" &&
                s.expression.arguments[0]?.getText(source) === JSON.stringify(name)
        );
        if (!statement) throw new Error(`Missing app event: ${name}`);
        const code = ts.transpileModule(statement.getText(source), {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        vm.runInNewContext(code, {
            ...globals,
            ...activity,
            electron,
            updater,
            unamePlatform: platform,
            electronApp: { ...electronApp, on: (_name: string, callback: Function) => callback(e) },
            confirmQuit: settings["app:confirmquit"] ?? true,
            confirmApplicationQuit: (enabled: boolean) => load("./emain-quit").confirmApplicationQuit(enabled),
            getAllWaveWindows: windows.getAllWaveWindows,
            getAllBuilderWindows: () => builders,
            getIsWaveSrvDead: () => dead,
            getWaveSrvProc: () => ({ kill() {} }),
            shutdownWshrpc() {},
            hideWindowWithCatch() {},
        });
    }
    return {
        settings,
        showDialog,
        closeBackend,
        configRead,
        activity,
        updater,
        env,
        primary,
        secondary,
        builders,
        electronApp,
        setDead: () => {
            dead = true;
        },
        setCursor: (value: typeof cursor) => {
            cursor = value;
        },
        create(size = { width: 0, height: 0 }, isnew = true, pos = { x: 0, y: 0 }) {
            return new windows.WaveBrowserWindow(
                { oid: `win-${nativeWindows.length}`, workspaceid: "ws", winsize: size, pos, isnew },
                { settings },
                { unamePlatform: platform }
            );
        },
        async flush() {
            while (pending.length) await Promise.all(pending.splice(0));
        },
    };
}

describe("Windows quit/close lifecycle — real handlers with native boundaries replaced", () => {
    it("cancels last-window X before any window or backend teardown", async () => {
        const f = fixture();
        const win = f.create();
        win.close();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(1);
        expect(win.isDestroyed()).toBe(false);
        expect(f.closeBackend).not.toHaveBeenCalled();
        expect(f.electronApp.quit).not.toHaveBeenCalled();
        expect(f.activity.getUserConfirmedQuit()).toBe(false);
    });
    it("confirms last-window X once, then actually quits without a tray", async () => {
        const f = fixture();
        f.showDialog.mockReturnValue(1);
        const win = f.create();
        win.close();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(1);
        expect(win.isDestroyed()).toBe(true);
        expect(f.electronApp.quit).toHaveBeenCalled();
    });
    it("closes without a quit prompt when confirmquit is false", async () => {
        const f = fixture();
        f.settings["app:confirmquit"] = false;
        const win = f.create();
        win.close();
        await f.flush();
        expect(f.showDialog).not.toHaveBeenCalled();
        expect(win.isDestroyed()).toBe(true);
    });
    it("closes one of several windows without quitting the remaining window", async () => {
        const f = fixture();
        const first = f.create();
        const second = f.create();
        first.close();
        await f.flush();
        expect(first.isDestroyed()).toBe(true);
        expect(second.isDestroyed()).toBe(false);
        expect(f.showDialog).not.toHaveBeenCalled();
        expect(f.electronApp.quit).not.toHaveBeenCalled();
    });
    it("does not lose the last-window confirmation on concurrent multi-window closes", async () => {
        const f = fixture();
        const first = f.create();
        const second = f.create();
        first.close();
        second.close();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(1);
        expect(second.isDestroyed()).toBe(false);
    });
    it("coalesces rapid X clicks and allows retry after Cancel", async () => {
        const f = fixture();
        const win = f.create();
        win.close();
        win.close();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(1);
        expect(win.isDestroyed()).toBe(false);
        f.showDialog.mockReturnValue(1);
        win.close();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(2);
        expect(win.isDestroyed()).toBe(true);
    });
    it("retains the last-window save policy after accepted quit", async () => {
        const f = fixture();
        f.showDialog.mockReturnValue(1);
        const win = f.create();
        win.close();
        await f.flush();
        expect(f.closeBackend).not.toHaveBeenCalled();
    });
    it("retains delete-on-close policy and unsaved-window Cancel", async () => {
        const f = fixture();
        f.settings["window:savelastwindow"] = false;
        f.settings["window:confirmclose"] = true;
        const win = f.create();
        win.close();
        await f.flush();
        expect(win.isDestroyed()).toBe(false);
        expect(f.closeBackend).not.toHaveBeenCalled();
    });
    it("preserves unsaved-window confirmation before the application quit gate", async () => {
        const f = fixture();
        f.settings["window:savelastwindow"] = false;
        f.settings["window:confirmclose"] = true;
        f.showDialog.mockReturnValueOnce(1).mockReturnValueOnce(0);
        const win = f.create();
        win.close();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(2);
        expect(win.isDestroyed()).toBe(false);
        expect(f.closeBackend).not.toHaveBeenCalled();
        expect(f.electronApp.quit).not.toHaveBeenCalled();
        f.showDialog.mockReturnValue(1);
        win.close();
        await f.flush();
        expect(win.isDestroyed()).toBe(true);
        expect(f.closeBackend).toHaveBeenCalledWith("win-0", true);
    });
    it("fails closed on config read failure and allows a later retry", async () => {
        const f = fixture();
        const win = f.create();
        f.configRead.mockRejectedValueOnce(new Error("configuration unavailable"));
        win.close();
        await expect(f.flush()).rejects.toThrow("configuration unavailable");
        expect(win.isDestroyed()).toBe(false);
        expect(f.closeBackend).not.toHaveBeenCalled();
        win.close();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(1);
    });
    it("defaults missing app:confirmquit to confirmation", async () => {
        const f = fixture();
        delete f.settings["app:confirmquit"];
        const win = f.create();
        win.close();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(1);
        expect(win.isDestroyed()).toBe(false);
    });
    it("honors disabled confirmation for explicit app Quit", async () => {
        const f = fixture();
        f.settings["app:confirmquit"] = false;
        const win = f.create();
        f.electronApp.quit();
        await f.flush();
        expect(f.showDialog).not.toHaveBeenCalled();
        expect(win.isDestroyed()).toBe(true);
    });
    it("preserves actual app Quit Cancel and Confirm across all windows", async () => {
        const f = fixture();
        const first = f.create();
        const second = f.create();
        f.electronApp.quit();
        await f.flush();
        expect(first.isDestroyed()).toBe(false);
        expect(second.isDestroyed()).toBe(false);
        expect(f.showDialog).toHaveBeenCalledTimes(1);
        f.showDialog.mockReturnValue(1);
        f.electronApp.quit();
        await f.flush();
        expect(f.showDialog).toHaveBeenCalledTimes(2);
        expect(first.isDestroyed()).toBe(true);
        expect(second.isDestroyed()).toBe(true);
    });
    for (const bypass of ["force", "relaunch", "update", "dead", "environment", "alreadyConfirmed"] as const) {
        it(`preserves the ${bypass} close bypass`, async () => {
            const f = fixture();
            const win = f.create();
            if (bypass === "force") f.activity.setForceQuit(true);
            if (bypass === "relaunch") f.activity.setGlobalIsRelaunching(true);
            if (bypass === "update") f.updater.status = "installing";
            if (bypass === "dead") f.setDead();
            if (bypass === "environment") f.env.WAVETERM_NOCONFIRMQUIT = "1";
            if (bypass === "alreadyConfirmed") f.activity.setUserConfirmedQuit(true);
            win.close();
            await f.flush();
            expect(f.showDialog).not.toHaveBeenCalled();
            expect(win.isDestroyed()).toBe(true);
        });
    }
    it("does not change macOS last-window close into app quit", async () => {
        const f = fixture("darwin");
        const win = f.create();
        win.close();
        await f.flush();
        expect(win.isDestroyed()).toBe(true);
        expect(f.showDialog).not.toHaveBeenCalled();
        expect(f.electronApp.quit).not.toHaveBeenCalled();
    });
    it("does not mistake a remaining Builder window for application exit", async () => {
        const f = fixture();
        f.builders.push({});
        const win = f.create();
        win.close();
        await f.flush();
        expect(f.showDialog).not.toHaveBeenCalled();
    });
});

describe("Windows New Window geometry — real constructor and bounds code", () => {
    it("uses a 1280x800 fallback on a large display", () => {
        const f = fixture();
        const win = f.create();
        expect(win.options.width).toBe(1280);
        expect(win.options.height).toBe(800);
    });
    it("clamps the fallback to a small work area", () => {
        const f = fixture();
        f.primary.workArea = { x: 0, y: 0, width: 1024, height: 768 };
        f.setCursor({ x: 100, y: 100 });
        const win = f.create();
        expect(win.options.width).toBe(1024);
        expect(win.options.height).toBe(768);
        expect(win.options.x).toBeGreaterThanOrEqual(0);
        expect(win.options.x + win.options.width).toBeLessThanOrEqual(1024);
        expect(win.options.y + win.options.height).toBeLessThanOrEqual(768);
    });
    it("clamps the fallback on a scaled (HiDPI) display", () => {
        // Electron reports work areas in device-independent pixels, so a 150%-scaled 1920x1200 panel
        // arrives as 1280x800 and the fallback must fit inside it, not overflow it.
        const f = fixture();
        f.primary.workArea = { x: 0, y: 0, width: 1280, height: 800 };
        f.setCursor({ x: 200, y: 200 });
        const win = f.create();
        expect(win.options.width).toBe(1280);
        expect(win.options.height).toBe(800);
        expect(win.options.x + win.options.width).toBeLessThanOrEqual(1280);
        expect(win.options.y + win.options.height).toBeLessThanOrEqual(800);
    });
    it("inherits normal bounds instead of maximized bounds", () => {
        const f = fixture();
        const first = f.create({ width: 1000, height: 650 }, false);
        first.normalBounds = { x: 50, y: 80, width: 1000, height: 650 };
        first.options = { x: 0, y: 0, width: 3840, height: 2120 };
        first.emit("focus");
        const next = f.create();
        expect(next.options.width).toBe(1000);
        expect(next.options.height).toBe(650);
    });
    it("gives explicit dimensions priority over inherited size", () => {
        const f = fixture();
        const first = f.create({ width: 1000, height: 650 }, false);
        first.emit("focus");
        f.settings["window:dimensions"] = "1200x800";
        const next = f.create();
        expect(next.options.width).toBe(1200);
        expect(next.options.height).toBe(800);
    });
    it("keeps explicitly saved restored geometry unchanged", () => {
        const f = fixture();
        f.settings["window:dimensions"] = "1200x800";
        const win = f.create({ width: 900, height: 600 }, false, { x: 200, y: 150 });
        expect([win.options.x, win.options.y, win.options.width, win.options.height]).toEqual([200, 150, 900, 600]);
    });
    it("puts a new window on the current display and inside its work area", () => {
        const f = fixture();
        f.setCursor({ x: -500, y: 100 });
        const win = f.create();
        expect(win.options.x).toBeGreaterThanOrEqual(-1600);
        expect(win.options.x + win.options.width).toBeLessThanOrEqual(0);
        expect(win.options.y + win.options.height).toBeLessThanOrEqual(860);
    });
    it("follows the focused secondary display rather than the cursor display", () => {
        const f = fixture();
        const first = f.create({ width: 1000, height: 650 }, false, { x: -1200, y: 40 });
        first.emit("focus");
        const next = f.create();
        expect(next.options.width).toBe(1000);
        expect(next.options.x).toBeLessThan(0);
        expect(next.options.x + next.options.width).toBeLessThanOrEqual(0);
    });
    it("clamps oversized explicit dimensions without occupying the taskbar", () => {
        const f = fixture();
        f.setCursor({ x: -500, y: 100 });
        f.settings["window:dimensions"] = "5000x3000";
        const next = f.create();
        expect([next.options.x, next.options.y, next.options.width, next.options.height]).toEqual([
            -1600, 0, 1600, 860,
        ]);
    });
    it("clamps even the native minimum size to a small work area", () => {
        const f = fixture();
        f.primary.workArea = { x: 0, y: 0, width: 700, height: 450 };
        const win = f.create();
        expect(win.options.width).toBe(700);
        expect(win.options.height).toBe(450);
        expect(win.options.minWidth).toBeLessThanOrEqual(700);
        expect(win.options.minHeight).toBeLessThanOrEqual(450);
    });
    it("keeps non-Windows defaults and the legacy bounds helper unchanged", () => {
        const f = fixture("linux");
        const win = f.create();
        expect(win.options.width).toBe(2000);
        expect(win.options.height).toBe(1200);
    });
});
