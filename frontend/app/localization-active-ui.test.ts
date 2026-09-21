import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const activeCallers = [
    ["../../emain/emain-menu.ts", "../frontend/util/ui-locale"],
    ["./app.tsx", "@/util/ui-locale"],
    ["./workspace/workspace.tsx", "@/util/ui-locale"],
    ["./tab/tabbar.tsx", "@/util/ui-locale"],
    ["./tab/vtabbar.tsx", "@/util/ui-locale"],
    ["./tab/workspaceswitcher.tsx", "@/util/ui-locale"],
    ["./tab/tabcontent.tsx", "@/util/ui-locale"],
    ["./tab/tabcontextmenu.ts", "@/util/ui-locale"],
    ["./tab/tab.tsx", "@/util/ui-locale"],
    ["./tab/vtab.tsx", "@/util/ui-locale"],
    ["./element/search.tsx", "@/util/ui-locale"],
    ["./block/blockframe-header.tsx", "@/util/ui-locale"],
    ["./block/connstatusoverlay.tsx", "@/util/ui-locale"],
    ["./block/block.tsx", "@/util/ui-locale"],
    ["./block/connectionbutton.tsx", "@/util/ui-locale"],
    ["./block/durable-session-flyover.tsx", "@/util/ui-locale"],
    ["./element/quickelems.tsx", "@/util/ui-locale"],
    ["./view/term/term-model.ts", "@/util/ui-locale"],
    ["./view/term/terminal-clear-action.tsx", "@/util/ui-locale"],
    ["./view/term/term-tooltip.tsx", "@/util/ui-locale"],
    ["./view/term/command-navigation-rail.tsx", "@/util/ui-locale"],
    ["./view/term/command-history.tsx", "@/util/ui-locale"],
    ["./view/waveconfig/waveconfig.tsx", "@/util/ui-locale"],
    ["./view/waveconfig/waveconfig-model.ts", "@/util/ui-locale"],
    ["./view/waveconfig/secretscontent.tsx", "@/util/ui-locale"],
    ["./modals/modal.tsx", "@/util/ui-locale"],
    ["./modals/about.tsx", "@/util/ui-locale"],
    ["./modals/conntypeahead.tsx", "@/util/ui-locale"],
    ["./onboarding/onboarding.tsx", "@/util/ui-locale"],
    ["./onboarding/onboarding-features.tsx", "@/util/ui-locale"],
] as const;

function source(relativePath: string): string {
    return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("active WBT-owned localization callers", () => {
    it("keeps the traced active callers on the shared fixed locale helper", () => {
        for (const [relativePath, importPath] of activeCallers) {
            const text = source(relativePath);
            expect(text, relativePath).toContain(importPath);
            expect(text, relativePath).toContain("uiText(");
        }
    });

    it("keeps technical command and platform tokens literal in active onboarding and terminal copy", () => {
        expect(source("./onboarding/onboarding-features.tsx")).toContain("wsh view [filename]");
        expect(source("./onboarding/onboarding-features.tsx")).toContain("wsh edit [filename]");
        expect(source("../util/ui-locale.ts")).toContain("PowerShell");
        expect(source("./view/term/term-tooltip.tsx")).toContain("modKey");
    });

    it("wires all seven durable-session paragraphs through the existing helper", () => {
        const durable = source("./onboarding/onboarding-durable.tsx");
        for (const key of [
            "onboarding.durableSshSessions",
            "onboarding.sshProtected",
            "onboarding.closeLaptop",
            "onboarding.shellState",
            "onboarding.reconnect",
            "onboarding.bufferedOutput",
            "onboarding.tmuxDurability",
        ]) {
            expect(durable, key).toContain(`uiText("${key}")`);
        }
        expect(durable).not.toContain("All the persistence of tmux");
    });

    it("keeps the shared footer's four button labels inline and in Chinese", () => {
        const footer = source("./onboarding/onboarding-features-footer.tsx");
        expect(footer).toContain("&lt; 上一步");
        expect(footer).toContain("下一步");
        expect(footer).toContain("开始使用");
        expect(footer).toContain("跳过功能导览 &gt;");
        expect(footer).not.toContain("< Prev");
        expect(footer).not.toContain("Get Started");
        expect(footer).not.toContain("Skip Feature Tour");
    });

    it("covers the revision-43 residual copy seams", () => {
        const tabContextMenu = source("./tab/tabcontextmenu.ts");
        expect(tabContextMenu).toContain('uiText("tabBar.position")');
        expect(tabContextMenu).toContain('uiText("tab.rename")');

        const search = source("./element/search.tsx");
        expect(search).toContain('uiText("search.previousResult")');
        expect(search).toContain('uiText("search.regex")');
        expect(search).toContain('uiText("search.results")');

        const menu = source("../../emain/emain-menu.ts");
        expect(menu).toContain('label: uiText("menu.undo")');
        expect(menu).toContain('label: uiText("menu.close")');

        const waveConfigModel = source("./view/waveconfig/waveconfig-model.ts");
        expect(waveConfigModel).toContain('uiText("config.general")');
        expect(waveConfigModel).toContain('uiText("config.invalidJson",');
    });
});
