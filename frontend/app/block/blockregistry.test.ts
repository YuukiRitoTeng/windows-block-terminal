// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { makeViewModel } from "./blockregistry";

vi.mock("@/app/view/aifilediff/aifilediff", () => ({
    AiFileDiffViewModel: class {
        viewComponent = () => null;
    },
}));
vi.mock("@/app/view/launcher/launcher", () => ({ LauncherViewModel: class {} }));
vi.mock("@/app/view/preview/preview-model", () => ({
    PreviewModel: class {
        viewComponent = () => null;
    },
}));
vi.mock("@/app/view/processviewer/processviewer", () => ({
    ProcessViewerViewModel: class {
        viewComponent = () => null;
    },
}));
vi.mock("@/app/view/sysinfo/sysinfo", () => ({
    SysinfoViewModel: class {
        viewComponent = () => null;
    },
}));
vi.mock("@/app/view/tsunami/tsunami", () => ({ TsunamiViewModel: class {} }));
vi.mock("@/app/view/vdom/vdom-model", () => ({ VDomModel: class {} }));
vi.mock("@/app/view/quicktipsview/quicktipsview", () => ({ QuickTipsViewModel: class {} }));
vi.mock("@/app/view/waveconfig/waveconfig-model", () => ({ WaveConfigViewModel: class {} }));
vi.mock("@/view/helpview/helpview", () => ({ HelpViewModel: class {} }));
vi.mock("@/view/term/term-model", () => ({ TermViewModel: class {} }));
vi.mock("@/view/webview/webview", () => ({ WebViewModel: class {} }));
vi.mock("@/app/block/blockutil", () => ({ blockViewToIcon: () => "", blockViewToName: () => "" }));

describe("restored product views", () => {
    it("keeps removed product blocks inert instead of mounting a product view", () => {
        const nodeModel = {
            isFocused: atom(true),
            focusNode: () => {},
        } as any;

        for (const viewType of ["waveai", "aifilediff", "preview", "web", "sysinfo", "cpuplot", "processviewer"]) {
            const viewModel = makeViewModel(`stale-${viewType}-block`, viewType, nodeModel, {} as any, {} as any);
            expect(viewModel.viewComponent, viewType).toBeNull();
        }
    });
});
