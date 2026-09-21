// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, expect, test, vi } from "vitest";
import { WorkspaceLayoutModel } from "./workspace-layout-model";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");

test("Terminal workspace source contract lists surviving tab refs and renderer integration", async () => {
    const workspace = await readSource("frontend/app/workspace/workspace.tsx");
    const layoutModel = await readSource("frontend/app/workspace/workspace-layout-model.ts");

    // The assertions verify the renderer wiring by source because this unit
    // environment does not mount react-resizable-panels or execute browser
    // refs. The model behavior checks below exercise the available layout
    // seams directly; real Electron/browser rendering remains separate.
    assert.include(workspace, "outerPanelGroupRef");
    assert.include(workspace, "vtabPanelRef");
    assert.include(workspace, "vtabPanelWrapperRef");
    assert.include(workspace, "panelContainerRef");
    assert.include(workspace, "workspaceLayoutModel.registerTerminalRefs");
    assert.include(workspace, "onLayout={workspaceLayoutModel.handleTerminalPanelLayout}");
    assert.include(workspace, "workspaceLayoutModel.syncVTabWidthFromMeta");
    assert.include(layoutModel, "registerTerminalRefs");
    assert.include(layoutModel, 'meta: { "layout:vtabbarwidth": width }');
});

test("default top tabbar commits a single-panel layout", () => {
    const setLayout = vi.fn();
    const model = {
        outerPanelGroupRef: { setLayout },
        getTerminalLeftGroupInitialPercentage: () => 0,
        vtabVisible: false,
        inResize: false,
    } as any;

    WorkspaceLayoutModel.prototype["commitTerminalLayout"].call(model, 1200);

    expect(setLayout).toHaveBeenCalledOnce();
    expect(setLayout).toHaveBeenCalledWith([100]);
    expect(setLayout.mock.calls[0][0]).toHaveLength(1);
});

test("Terminal panel resize persists the surviving VTab width", () => {
    vi.stubGlobal("window", { innerWidth: 1200 });
    const persistWidth = vi.fn();
    const model = {
        inResize: false,
        vtabVisible: true,
        vtabWidth: 220,
        debouncedPersistVTabWidth: persistWidth,
    } as any;

    WorkspaceLayoutModel.prototype.handleTerminalPanelLayout.call(model, [20, 80]);

    expect(model.vtabWidth).toBe(240);
    expect(persistWidth).toHaveBeenCalledOnce();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});
