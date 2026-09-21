// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, createStore } from "jotai";
import { assert, test, vi } from "vitest";
import { LayoutModel } from "@/layout/lib/layoutModel";
import { newLayoutNode } from "@/layout/lib/layoutNode";
import { makeViewModel } from "@/app/block/blockregistry";

const mockLayoutState = vi.hoisted(() => ({
    atoms: new Map<string, unknown>(),
}));

vi.mock("@/app/store/global", () => ({
    WOS: {
        makeORef: (type: string, oid: string) => `${type}:${oid}`,
        getWaveObjectAtom: (oref: string) => mockLayoutState.atoms.get(oref),
        setObjectValue: vi.fn(),
    },
    getSettingsKeyAtom: () => undefined,
}));
vi.mock("@/app/store/services", () => ({
    BlockService: {
        CleanupOrphanedBlocks: vi.fn(async () => undefined),
    },
}));
vi.mock("@/app/store/focusManager", () => ({
    FocusManager: {
        getInstance: () => ({
            focusType: {},
            requestNodeFocus: vi.fn(),
        }),
    },
}));

vi.mock("@/app/view/launcher/launcher", () => ({ LauncherViewModel: class {} }));
vi.mock("@/app/view/tsunami/tsunami", () => ({ TsunamiViewModel: class {} }));
vi.mock("@/app/view/vdom/vdom-model", () => ({ VDomModel: class {} }));
vi.mock("@/app/view/quicktipsview/quicktipsview", () => ({ QuickTipsViewModel: class {} }));
vi.mock("@/app/view/waveconfig/waveconfig-model", () => ({ WaveConfigViewModel: class {} }));
vi.mock("@/view/helpview/helpview", () => ({ HelpViewModel: class {} }));
vi.mock("@/view/term/term-model", () => ({
    TermViewModel: class {
        viewType = "term";
        viewComponent = () => null;
    },
}));
vi.mock("@/app/block/blockutil", () => ({ blockViewToIcon: () => "", blockViewToName: () => "" }));

test("restore activation keeps valid Terminal split nodes with a stale removed view", async () => {
    const staleNode = newLayoutNode(undefined, undefined, undefined, { blockId: "stale-preview" });
    const terminalNode = newLayoutNode(undefined, undefined, undefined, { blockId: "terminal" });
    const root = newLayoutNode(undefined, undefined, [staleNode, terminalNode]);

    const tabAtom = atom({ oid: "tab-restore", layoutstate: "layout-restore", blockids: ["stale-preview", "terminal"] } as any);
    const layoutStateAtom = atom({ rootnode: root, focusednodeid: terminalNode.id } as any);
    mockLayoutState.atoms.set("layout:layout-restore", layoutStateAtom);

    const store = createStore();
    const layoutModel = new LayoutModel(tabAtom, store.get, store.set);
    layoutModel.registerTileLayout({
        tabId: "tab-restore",
        gapSizePx: 3,
        renderContent: () => null,
        renderPreview: () => null,
        onNodeDelete: async () => undefined,
    } as any);

    const restoredRoot = layoutModel.treeState.rootNode;
    assert.equal(restoredRoot?.children?.length, 2);
    assert.equal(restoredRoot?.children?.[0].data?.blockId, "stale-preview");
    assert.equal(restoredRoot?.children?.[1].data?.blockId, "terminal");

    const staleNodeModel = layoutModel.getNodeModel(staleNode);
    const terminalNodeModel = layoutModel.getNodeModel(terminalNode);
    const staleView = makeViewModel("stale-preview", "preview", staleNodeModel, {} as any, {} as any);
    const terminalView = makeViewModel("terminal", "term", terminalNodeModel, {} as any, {} as any);

    assert.isNull(staleView.viewComponent);
    assert.isFunction(terminalView.viewComponent);
});
