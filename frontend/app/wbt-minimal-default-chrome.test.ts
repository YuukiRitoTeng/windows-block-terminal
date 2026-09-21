// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, test } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");

test("does not ship a default setting for the removed AI button", async () => {
    const settings = JSON.parse(await readSource("pkg/wconfig/defaultconfig/settings.json"));

    assert.notProperty(settings, "app:hideaibutton");
});

test("terms acceptance keeps the AI panel closed", async () => {
    const source = await readSource("frontend/app/onboarding/onboarding.tsx");

    assert.notInclude(source, "WorkspaceLayoutModel.getInstance().setAIPanelVisible(true)");
    assert.include(source, "services.ClientService.AgreeTos()");
    assert.include(source, 'setPageName(telemetryEnabled ? "features" : "notelemetrystar")');
});

test("workspace renders the terminal surface without AI or widget sidebars", async () => {
    const source = await readSource("frontend/app/workspace/workspace.tsx");
    const menu = await readSource("emain/emain-menu.ts");

    assert.include(source, "<TabContent");
    assert.notInclude(source, "<AIPanel");
    assert.notInclude(source, "<Widgets");
    assert.notInclude(source, "setWaveAIOpen");
    assert.notInclude(menu, "Toggle Widgets Bar");
});

test("tab bars do not expose an AI product control", async () => {
    const tabbar = await readSource("frontend/app/tab/tabbar.tsx");
    const vtabbar = await readSource("frontend/app/tab/vtabbar.tsx");

    assert.notInclude(tabbar, "WaveAIButton");
    assert.notInclude(tabbar, "hideaibutton");
    assert.notInclude(vtabbar, "VTabBarAIButton");
    assert.notInclude(vtabbar, "hideaibutton");
});

test("terminal keyboard and context paths do not route into AI", async () => {
    const termModel = await readSource("frontend/app/view/term/term-model.ts");
    const keyModel = await readSource("frontend/app/store/keymodel.ts");

    assert.notInclude(termModel, "Send to Wave AI");
    assert.notInclude(keyModel, "waveai");
});

test("the terminal default chrome does not expose Wave AI shell status", async () => {
    const termModel = await readSource("frontend/app/view/term/term-model.ts");

    assert.notInclude(termModel, "getShellIntegrationIconButton");
    assert.notInclude(termModel, "Wave AI unable");
});

test("removed view callers do not recreate stale product surfaces", async () => {
    const app = await readSource("frontend/app/app.tsx");
    const global = await readSource("frontend/app/store/global.ts");
    const termModel = await readSource("frontend/app/view/term/term-model.ts");
    const preview = await readSource("frontend/util/previewutil.ts");
    const webview = await readSource("frontend/app/view/webview/webview.tsx");
    const server = await readSource("pkg/wshrpc/wshserver/wshserver.go");
    const widgets = JSON.parse(await readSource("pkg/wconfig/defaultconfig/widgets.json"));

    assert.notInclude(app, 'view: "web"');
    assert.notInclude(global, 'view: "web"');
    assert.notInclude(termModel, 'view: "web"');
    assert.notInclude(termModel, 'view: "preview"');
    assert.notInclude(preview, 'view: "preview"');
    assert.notInclude(webview, 'view: "preview"');
    assert.notInclude(server, 'MetaKey_View: "preview"');
    assert.deepEqual(Object.keys(widgets), ["defwidget@terminal"]);
});

test("shipped view, editor, and web open callers keep external handling without internal views", async () => {
    const view = await readSource("cmd/wsh/cmd/wshcmd-view.go");
    const editor = await readSource("cmd/wsh/cmd/wshcmd-editor.go");
    const web = await readSource("cmd/wsh/cmd/wshcmd-web.go");

    for (const source of [view, web]) {
        assert.notInclude(source, "CreateBlockCommand");
        assert.notInclude(source, "CommandCreateBlockData");
    }
    assert.include(view, "OpenExternal: true");
    assert.include(editor, "OpenExternal: true");
    assert.include(editor, "buildRemoteEditorBlockData");
    assert.notInclude(editor, 'MetaKey_View: "preview"');
    assert.include(web, "openExternalTarget(tabId, args[0])");
});

test("the Electron shell does not track removed AI panel activity", async () => {
    const main = await readSource("emain/emain.ts");
    const window = await readSource("emain/emain-window.ts");
    const tabView = await readSource("emain/emain-tabview.ts");
    const preload = await readSource("emain/preload.ts");

    assert.notInclude(main, "isWaveAIOpen");
    assert.notInclude(window, "set-waveai-open");
    assert.notInclude(tabView, "isWaveAIOpen");
    assert.notInclude(preload, "setWaveAIOpen");
});

test("feature tour routes durable, magnify, and files as three consistent steps", async () => {
    const features = await readSource("frontend/app/onboarding/onboarding-features.tsx");
    const durable = await readSource("frontend/app/onboarding/onboarding-durable.tsx");

    assert.include(features, 'type FeaturePageName = "durable" | "magnify" | "files";');
    assert.include(features, 'useState<FeaturePageName>("durable")');
    assert.include(features, 'if (currentPage === "durable") {\n            setCurrentPage("magnify")');
    assert.include(features, '} else if (currentPage === "magnify") {\n            setCurrentPage("files")');
    assert.notInclude(features, 'setCurrentPage("waveai")');
    assert.notInclude(features, 'case "waveai":');
    assert.notInclude(features, "export const WaveAIPage");
    assert.notInclude(features, 'from "./fakechat"');
    assert.include(durable, "<OnboardingFooter currentStep={1} totalSteps={3}");
    assert.include(features, "<OnboardingFooter currentStep={2} totalSteps={3}");
    assert.include(features, "<OnboardingFooter currentStep={3} totalSteps={3}");
});
