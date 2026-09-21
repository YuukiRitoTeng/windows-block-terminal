import { describe, expect, it, vi } from "vitest";
import { instantiateAppMenu } from "./emain-menu";

const f = vi.hoisted(() => {
    const wc = { send: vi.fn(), reloadIgnoringCache: vi.fn(), toggleDevTools: vi.fn() };
    class Window {
        activeTabView = { webContents: wc };
        close = vi.fn();
        switchWorkspace = vi.fn();
    }
    const window = new Window();
    return {
        Window,
        window,
        wc,
        newWindow: vi.fn(),
        createWorkspace: vi.fn(),
        relaunch: vi.fn(),
        setConfig: vi.fn(),
        zoom: vi.fn(),
        ipc: new Map<string, Function>(),
        templates: [] as any[],
    };
});
vi.mock("electron", () => ({
    BrowserWindow: class {},
    MenuItem: class {
        constructor(value: any) {
            Object.assign(this, value);
        }
    },
    Menu: {
        buildFromTemplate: (items: any[]) => {
            const menu = { items, popup: vi.fn() };
            f.templates.push(menu);
            return menu;
        },
    },
    ipcMain: { on: (name: string, fn: Function) => f.ipc.set(name, fn) },
    app: { dock: { setMenu: vi.fn() } },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetFullConfigCommand: async () => ({
            settings: { "feature:waveappbuilder": true, "window:fullscreenonlaunch": false },
        }),
        WorkspaceListCommand: async () => [{ workspacedata: { name: "my-Wave-project", oid: "ws-2" } }],
        SetConfigCommand: (...args: any[]) => f.setConfig(...args),
    },
}));
vi.mock("../frontend/util/util", () => ({ fireAndForget: (fn: Function) => fn() }));
vi.mock("./emain-builder", () => ({ focusedBuilderWindow: null, getBuilderWindowById: () => null }));
vi.mock("./emain-ipc", () => ({ openBuilderWindow: vi.fn() }));
vi.mock("./emain-platform", () => ({ isDev: true, unamePlatform: "win32" }));
vi.mock("./emain-tabview", () => ({ clearTabCache: vi.fn() }));
vi.mock("./emain-util", () => ({
    decreaseZoomLevel: vi.fn(),
    increaseZoomLevel: vi.fn(),
    resetZoomLevel: (...args: any[]) => f.zoom(...args),
}));
vi.mock("./emain-window", () => ({
    WaveBrowserWindow: f.Window,
    focusedWaveWindow: f.window,
    createNewWaveWindow: f.newWindow,
    createWorkspace: f.createWorkspace,
    relaunchBrowserWindows: f.relaunch,
    getAllWaveWindows: () => [f.window],
    getWaveWindowByWorkspaceId: () => f.window,
}));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));
vi.mock("./updater", () => ({ updater: { checkForUpdates: vi.fn() } }));

describe("Windows menu product surface and retained actions", () => {
    it("does not expose retired Builder despite legacy feature flag and dev mode", async () => {
        const menu = (await instantiateAppMenu("ws")) as any;
        expect(
            menu.items
                .find((item: any) => item.role === "fileMenu")
                .submenu.some((item: any) => /Builder|WaveApp/.test(item.label))
        ).toBe(false);
    });
    it("identifies WBT and localizes Quit without replacing its native role", async () => {
        const menu = (await instantiateAppMenu("ws")) as any;
        const app = menu.items.find((item: any) => item.role === "appMenu");
        expect(app.label).toBe("Windows Block Terminal");
        expect(app.submenu.find((item: any) => item.role === "quit")).toMatchObject({ label: "退出", role: "quit" });
    });
    it("preserves standard roles, accelerators and native window routing", async () => {
        const menu = (await instantiateAppMenu("ws")) as any;
        const file = menu.items.find((item: any) => item.role === "fileMenu").submenu;
        const newWindow = file.find((item: any) => item.accelerator === "CommandOrControl+Shift+N");
        newWindow.click();
        expect(f.newWindow).toHaveBeenCalled();
        file.find((item: any) => item.role === "close").click();
        expect(f.window.close).toHaveBeenCalled();
        const edit = menu.items.find((item: any) => item.role === "editMenu").submenu;
        expect(edit.filter((item: any) => item.role).map((item: any) => item.role)).toEqual([
            "undo",
            "redo",
            "cut",
            "copy",
            "paste",
            "pasteAndMatchStyle",
            "delete",
            "selectAll",
        ]);
        expect(edit.find((item: any) => item.role === "paste").accelerator).toBe("Control+V");
        expect(
            menu.items
                .find((item: any) => item.role === "windowMenu")
                .submenu.map((item: any) => item.role)
                .filter(Boolean)
        ).toEqual(["minimize", "zoom", "front"]);
    });
    it("preserves user workspace names and workspace click routing", async () => {
        const menu = (await instantiateAppMenu("ws")) as any;
        const workspace = menu.items.find((item: any) => item.id === "workspace-menu").submenu;
        const target = workspace.find((item: any) => item.label === "my-Wave-project");
        expect(target.accelerator).toBe("Alt+Control+1");
        target.click(null, f.window);
        expect(f.window.switchWorkspace).toHaveBeenCalledWith("ws-2");
    });
    it("preserves view submenu config writes and zoom target", async () => {
        const menu = (await instantiateAppMenu("ws")) as any;
        const view = menu.items.find((item: any) => item.role === "viewMenu").submenu;
        view.find((item: any) => item.accelerator === "CommandOrControl+0").click(null, f.window);
        expect(f.zoom).toHaveBeenCalledWith(f.wc);
        view.find((item: any) => item.submenu)?.submenu[0].click();
        expect(f.setConfig).toHaveBeenCalledWith({}, { "window:fullscreenonlaunch": true });
        expect(view.find((item: any) => item.role === "togglefullscreen")).toBeDefined();
    });
    it("retains nested context menu click identity and checked state", () => {
        const event = { returnValue: false };
        f.ipc.get("contextmenu-show")!(event, "ws", [
            { label: "parent", submenu: [{ id: "child-id", label: "child", type: "checkbox", checked: true }] },
        ]);
        const menu = f.templates.at(-1);
        const child = menu.items[0].submenu.items[0];
        expect(child.checked).toBe(true);
        child.click();
        expect(f.wc.send).toHaveBeenCalledWith("contextmenu-click", "child-id");
        expect(event.returnValue).toBe(true);
    });
});
