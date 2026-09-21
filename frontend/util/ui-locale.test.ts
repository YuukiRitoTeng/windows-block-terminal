// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { uiText, uiTextDictionary } from "./ui-locale";

describe("fixed zh-CN UI text", () => {
    test("resolves every dictionary entry to non-empty text", () => {
        for (const [key, value] of Object.entries(uiTextDictionary)) {
            expect(value, key).toBeTypeOf("string");
            expect(value.trim(), key).not.toBe("");
        }
    });

    test("interpolates dynamic detail without rewriting it", () => {
        const detail = "SSH:alice@example.com /srv/项目 with spaces";

        expect(uiText("connection.error", { detail })).toBe(`连接错误：${detail}`);
    });

    test("keeps technical values and shortcut notation exact", () => {
        const connection = "wsl://Ubuntu-22.04";
        const shortcut = "Ctrl+Shift+P";

        expect(uiText("connection.connected", { connection })).toContain(connection);
        expect(uiText("shortcut.openCommandPalette", { shortcut })).toContain(shortcut);
    });

    test("keeps the approved durable-session keys and resolves the tmux paragraph", () => {
        expect(uiTextDictionary["onboarding.durableSshSessions"]).toBe("持久 SSH 会话");
        expect(uiTextDictionary["onboarding.sshProtected"]).toBe("SSH 会话，受到保护");
        expect(uiTextDictionary["onboarding.closeLaptop"]).toBe("合上笔记本、切换网络或重启 Wave，你的远程会话仍会继续运行。");
        expect(uiTextDictionary["onboarding.shellState"]).toBe("Shell 状态、运行中的程序和终端历史都会保留");
        expect(uiTextDictionary["onboarding.reconnect"]).toBe("连接恢复后，会话会自动重新连接");
        expect(uiTextDictionary["onboarding.bufferedOutput"]).toBe("缓冲的输出会流回，不会错过任何一行");
        expect(uiText("onboarding.tmuxDurability")).toBe(
            "tmux 的持久性能力已内置于终端。找到盾牌图标，即可为任意 SSH 会话启用持久性。"
        );
    });

    test("makes an unknown runtime key visible", () => {
        expect(uiText("missing.runtime.key" as never)).toBe("[missing.runtime.key]");
    });

    test("preserves revision-43 dynamic values and shortcut notation", () => {
        expect(uiText("search.previousResult")).toContain("Shift+Enter");
        expect(uiText("search.nextResult")).toContain("Enter");
        expect(uiText("search.close")).toContain("Esc");
        expect(uiText("connection.errorConnecting", { connection: "wsl://Ubuntu-22.04", detail: "raw error" })).toContain(
            "wsl://Ubuntu-22.04"
        );
        expect(uiText("config.saveShortcut", { shortcut: "Ctrl+S" })).toContain("Ctrl+S");
    });
});
