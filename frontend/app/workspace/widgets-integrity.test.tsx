import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { uiText } from "../../util/ui-locale";
import { shouldIncludeWidgetForWorkspace } from "./widgetfilter";

// Native floating portal and application I/O are unavailable in SSR. Keep the
// actual widget and flyout implementation, React and locale/filter logic real.
function fixture() {
    const createBlock = vi.fn(),
        pushModal = vi.fn();
    const env = {
        isDev: () => true,
        atoms: {
            fullConfigAtom: { settings: { "feature:waveappbuilder": true }, widgets: {} },
            hasConfigErrors: false,
            workspaceId: "ws",
        },
        createBlock,
        showContextMenu: vi.fn(),
    };
    const require = createRequire(import.meta.url);
    const source =
        readFileSync(new URL("./widgets.tsx", import.meta.url), "utf8") + "\nexport { SettingsFloatingWindow };";
    const code = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    const module = { exports: {} as any };
    vm.runInNewContext(code, {
        console,
        module,
        exports: module.exports,
        require: (name: string) => {
            if (name === "@/app/element/tooltip") return { Tooltip: ({ children }: any) => children };
            if (name === "@/app/store/wshrpcutil") return { TabRpcClient: {} };
            if (name === "@/app/waveenv/waveenv") return { useWaveEnv: () => env };
            if (name === "@/app/workspace/widgetfilter") return { shouldIncludeWidgetForWorkspace };
            if (name === "@/store/modalmodel") return { modalsModel: { pushModal } };
            if (name === "@/util/util")
                return {
                    isBlank: (v: any) => !v,
                    makeIconClass: (v: string) => v,
                    fireAndForget: (fn: Function) => fn(),
                };
            if (name === "@/util/ui-locale") return { uiText };
            if (name === "jotai") return { useAtomValue: (value: any) => value };
            if (name === "@floating-ui/react")
                return {
                    FloatingPortal: ({ children }: any) => children,
                    autoUpdate() {},
                    offset() {},
                    shift() {},
                    useDismiss() {},
                    useFloating: () => ({ refs: { setFloating() {} }, floatingStyles: {}, context: {} }),
                    useInteractions: () => ({ getFloatingProps: () => ({}) }),
                };
            return require(name);
        },
    });
    return { ...module.exports, createBlock, pushModal };
}

describe("WBT widget strip and Settings flyout", () => {
    it("does not render local WaveApp launchers even in dev with legacy flag", () => {
        const f = fixture();
        const html = renderToStaticMarkup(React.createElement(f.Widgets));
        expect(html).not.toContain(">apps<");
        expect(html).not.toContain("Running Wave Dev Build");
        expect(html).toContain("设置");
    });
    it("renders localized retained settings actions and preserves error indicator", () => {
        const f = fixture();
        const html = renderToStaticMarkup(
            React.createElement(f.SettingsFloatingWindow, {
                isOpen: true,
                onClose() {},
                referenceElement: null,
                hasConfigErrors: true,
            })
        );
        for (const label of ["设置", "使用提示", "密钥", "发行说明", "帮助"]) expect(html).toContain(label);
        expect(html).toContain("circle-exclamation");
    });
    it("preserves exact config, tips, secrets, release notes and help destinations", () => {
        const f = fixture(),
            close = vi.fn();
        const tree = f.SettingsFloatingWindow.type({ isOpen: true, onClose: close, referenceElement: null });
        const actions: any[] = [];
        function walk(node: any) {
            if (!node || typeof node !== "object") return;
            if (node.props?.onClick) actions.push(node);
            React.Children.forEach(node.props?.children, walk);
        }
        walk(tree);
        actions.forEach((node) => node.props.onClick());
        expect(f.createBlock.mock.calls).toEqual([
            [{ meta: { view: "waveconfig" } }, false, true],
            [{ meta: { view: "tips" } }, true, true],
            [{ meta: { view: "waveconfig", file: "secrets" } }, false, true],
            [{ meta: { view: "help" } }],
        ]);
        expect(f.pushModal).toHaveBeenCalledWith("UpgradeOnboardingPatch", { isReleaseNotes: true });
        expect(close).toHaveBeenCalledTimes(5);
    });
});
