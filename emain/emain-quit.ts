// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { dialog } from "electron";
import { getForceQuit, getGlobalIsQuitting, getGlobalIsRelaunching, getUserConfirmedQuit } from "./emain-activity";
import { getIsWaveSrvDead } from "./emain-wavesrv";
import { updater } from "./updater";

// UI gate only. Call before any destructive close or shutdown side effect.
export function confirmApplicationQuit(enabled: boolean): boolean {
    if (
        !enabled ||
        getForceQuit() ||
        getUserConfirmedQuit() ||
        getGlobalIsQuitting() ||
        getGlobalIsRelaunching() ||
        updater?.status === "installing" ||
        getIsWaveSrvDead() ||
        process.env.WAVETERM_NOCONFIRMQUIT
    ) {
        return true;
    }
    return (
        dialog.showMessageBoxSync({
            type: "question",
            buttons: ["取消", "退出"],
            title: "确认退出",
            message: "确定要退出 Windows Block Terminal 吗？",
            defaultId: 0,
            cancelId: 0,
        }) === 1
    );
}
