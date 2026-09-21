// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { SNAP_TOUCHED_META_KEY, shouldMarkSnapTerminalTouched } from "@/app/workspace/snapReclaim";
import { appHandleKeyDown } from "@/app/store/keymodel";
import { modalsModel } from "@/app/store/modalmodel";
import type { TabModel } from "@/app/store/tab-model";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeFeBlockRouteId } from "@/app/store/wshrouter";
import { DefaultRouter, TabRpcClient } from "@/app/store/wshrpcutil";
import { TerminalView } from "@/app/view/term/term";
import { TermWshClient } from "@/app/view/term/term-wsh";
import { VDomModel } from "@/app/view/vdom/vdom-model";
import {
    atoms,
    createBlock,
    createBlockSplitHorizontally,
    createBlockSplitVertically,
    getAllBlockComponentModels,
    getApi,
    getBlockComponentModel,
    getBlockMetaKeyAtom,
    getBlockTermDurableAtom,
    getConnStatusAtom,
    getOverrideConfigAtom,
    getSettingsKeyAtom,
    globalStore,
    readAtom,
    recordTEvent,
    useBlockAtom,
    WOS,
} from "@/store/global";
import * as services from "@/store/services";
import * as keyutil from "@/util/keyutil";
import { isMacOS, isWindows } from "@/util/platformutil";
import { boundNumber, fireAndForget, stringToBase64 } from "@/util/util";
import { uiText } from "@/util/ui-locale";
import * as jotai from "jotai";
import * as React from "react";
import { clearProductHistoryForModel } from "./clear-product-history";
import { broadcastToOtherPanes } from "./multi-input";
import { markSnapTerminalTouched } from "./snap-touch";
import { computeTheme, DefaultTermTheme, trimTerminalSelection } from "./termutil";
import { TermWrap, WebGLSupported } from "./termwrap";

export class TermViewModel implements ViewModel {
    viewType: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    connected: boolean;
    termRef: React.RefObject<TermWrap> = { current: null };
    blockAtom: jotai.Atom<Block>;
    termMode: jotai.Atom<string>;
    blockId: string;
    viewIcon: jotai.Atom<IconButtonDecl>;
    viewName: jotai.Atom<string>;
    viewText: jotai.Atom<HeaderElem[]>;
    blockBg: jotai.Atom<MetaType>;
    manageConnection: jotai.Atom<boolean>;
    filterOutNowsh?: jotai.Atom<boolean>;
    connStatus: jotai.Atom<ConnStatus>;
    useTermHeader: jotai.Atom<boolean>;
    termWshClient: TermWshClient;
    vdomBlockId: jotai.Atom<string>;
    vdomToolbarBlockId: jotai.Atom<string>;
    vdomToolbarTarget: jotai.PrimitiveAtom<VDomTargetToolbar>;
    fontSizeAtom: jotai.Atom<number>;
    termThemeNameAtom: jotai.Atom<string>;
    termTransparencyAtom: jotai.Atom<number>;
    termBPMAtom: jotai.Atom<boolean>;
    noPadding: jotai.PrimitiveAtom<boolean>;
    endIconButtons: jotai.Atom<IconButtonDecl[]>;
    shellProcFullStatus: jotai.PrimitiveAtom<BlockControllerRuntimeStatus>;
    shellProcStatus: jotai.Atom<string>;
    shellProcStatusUnsubFn: () => void;
    blockJobStatusAtom: jotai.PrimitiveAtom<BlockJobStatusData>;
    blockJobStatusVersionTs: number;
    blockJobStatusUnsubFn: () => void;
    termBPMUnsubFn: () => void;
    termCursorUnsubFn: () => void;
    termCursorBlinkUnsubFn: () => void;
    isCmdController: jotai.Atom<boolean>;
    isRestarting: jotai.PrimitiveAtom<boolean>;
    termDurableStatus: jotai.Atom<BlockJobStatusData | null>;
    termConfigedDurable: jotai.Atom<null | boolean>;
    searchAtoms?: SearchAtoms;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.viewType = "term";
        this.blockId = blockId;
        this.tabModel = tabModel;
        this.termWshClient = new TermWshClient(blockId, this);
        DefaultRouter.registerRoute(makeFeBlockRouteId(blockId), this.termWshClient);
        this.nodeModel = nodeModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.vdomBlockId = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            return blockData?.meta?.["term:vdomblockid"];
        });
        this.vdomToolbarBlockId = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            return blockData?.meta?.["term:vdomtoolbarblockid"];
        });
        this.vdomToolbarTarget = jotai.atom<VDomTargetToolbar>(null) as jotai.PrimitiveAtom<VDomTargetToolbar>;
        this.termMode = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            return blockData?.meta?.["term:mode"] ?? "term";
        });
        this.isRestarting = jotai.atom(false);
        this.viewIcon = jotai.atom((get) => {
            const termMode = get(this.termMode);
            if (termMode == "vdom") {
                return { elemtype: "iconbutton", icon: "bolt" };
            }
            return { elemtype: "iconbutton", icon: "terminal" };
        });
        this.viewName = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const termMode = get(this.termMode);
            if (termMode == "vdom") {
                return "Wave App";
            }
            if (blockData?.meta?.controller == "cmd") {
                return "";
            }
            return "";
        });
        this.viewText = jotai.atom((get) => {
            const termMode = get(this.termMode);
            if (termMode == "vdom") {
                return [
                    {
                        elemtype: "iconbutton",
                        icon: "square-terminal",
                        title: uiText("terminal.switchToTerminal"),
                        click: () => {
                            this.setTermMode("term");
                        },
                    },
                ];
            }
            const vdomBlockId = get(this.vdomBlockId);
            const rtn: HeaderElem[] = [];
            if (vdomBlockId) {
                rtn.push({
                    elemtype: "iconbutton",
                    icon: "bolt",
                    title: uiText("terminal.switchToWaveApp"),
                    click: () => {
                        this.setTermMode("vdom");
                    },
                });
            }
            const isCmd = get(this.isCmdController);
            if (isCmd) {
                const blockMeta = get(this.blockAtom)?.meta;
                let cmdText = blockMeta?.["cmd"];
                const cmdArgs = blockMeta?.["cmd:args"];
                if (cmdArgs != null && Array.isArray(cmdArgs) && cmdArgs.length > 0) {
                    cmdText += " " + cmdArgs.join(" ");
                }
                rtn.push({
                    elemtype: "text",
                    text: cmdText,
                    noGrow: true,
                });
                const isRestarting = get(this.isRestarting);
                if (isRestarting) {
                    rtn.push({
                        elemtype: "iconbutton",
                        icon: "refresh",
                        iconColor: "var(--success-color)",
                        iconSpin: true,
                                title: uiText("terminal.restartingCommand"),
                        noAction: true,
                    });
                } else {
                    const fullShellProcStatus = get(this.shellProcFullStatus);
                    if (fullShellProcStatus?.shellprocstatus == "done") {
                        if (fullShellProcStatus?.shellprocexitcode == 0) {
                            rtn.push({
                                elemtype: "iconbutton",
                                icon: "check",
                                iconColor: "var(--success-color)",
                                title: uiText("terminal.commandExited"),
                                noAction: true,
                            });
                        } else {
                            rtn.push({
                                elemtype: "iconbutton",
                                icon: "xmark-large",
                                iconColor: "var(--error-color)",
                                title: uiText("terminal.exitCode", { code: fullShellProcStatus?.shellprocexitcode ?? "" }),
                                noAction: true,
                            });
                        }
                    }
                }
            }
            const isMI = get(this.tabModel.isTermMultiInput);
            if (isMI && this.isBasicTerm(get)) {
                rtn.push({
                    elemtype: "textbutton",
                    text: uiText("terminal.multiInputOn"),
                    className: "yellow !py-[2px] !px-[10px] text-[11px] font-[500]",
                        title: uiText("terminal.broadcastInput"),
                    onClick: () => {
                        globalStore.set(this.tabModel.isTermMultiInput, false);
                    },
                });
            }
            return rtn;
        });
        this.manageConnection = jotai.atom((get) => {
            const termMode = get(this.termMode);
            if (termMode == "vdom") {
                return false;
            }
            const isCmd = get(this.isCmdController);
            if (isCmd) {
                return false;
            }
            return true;
        });
        this.useTermHeader = jotai.atom((get) => {
            const termMode = get(this.termMode);
            if (termMode == "vdom") {
                return false;
            }
            const isCmd = get(this.isCmdController);
            if (isCmd) {
                return false;
            }
            return true;
        });
        this.filterOutNowsh = jotai.atom(false);
        this.termBPMAtom = getOverrideConfigAtom(blockId, "term:allowbracketedpaste");
        this.termThemeNameAtom = useBlockAtom(blockId, "termthemeatom", () => {
            return jotai.atom<string>((get) => {
                return get(getOverrideConfigAtom(this.blockId, "term:theme")) ?? DefaultTermTheme;
            });
        });
        this.termTransparencyAtom = useBlockAtom(blockId, "termtransparencyatom", () => {
            return jotai.atom<number>((get) => {
                const value = get(getOverrideConfigAtom(this.blockId, "term:transparency")) ?? 0.5;
                return boundNumber(value, 0, 1);
            });
        });
        this.blockBg = jotai.atom((get) => {
            const fullConfig = get(atoms.fullConfigAtom);
            const themeName = get(this.termThemeNameAtom);
            const termTransparency = get(this.termTransparencyAtom);
            const [_, bgcolor] = computeTheme(fullConfig, themeName, termTransparency);
            if (bgcolor != null) {
                return { bg: bgcolor };
            }
            return null;
        });
        this.connStatus = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const connName = blockData?.meta?.connection;
            const connAtom = getConnStatusAtom(connName);
            return get(connAtom);
        });
        this.fontSizeAtom = useBlockAtom(blockId, "fontsizeatom", () => {
            return jotai.atom<number>((get) => {
                const blockData = get(this.blockAtom);
                const fsSettingsAtom = getSettingsKeyAtom("term:fontsize");
                const settingsFontSize = get(fsSettingsAtom);
                const connName = blockData?.meta?.connection;
                const fullConfig = get(atoms.fullConfigAtom);
                const connFontSize = fullConfig?.connections?.[connName]?.["term:fontsize"];
                const rtnFontSize = blockData?.meta?.["term:fontsize"] ?? connFontSize ?? settingsFontSize ?? 12;
                if (typeof rtnFontSize != "number" || isNaN(rtnFontSize) || rtnFontSize < 4 || rtnFontSize > 64) {
                    return 12;
                }
                return rtnFontSize;
            });
        });
        this.noPadding = jotai.atom(true);
        this.endIconButtons = jotai.atom((get) => {
            const blockData = get(this.blockAtom);
            const shellProcStatus = get(this.shellProcStatus);
            const connStatus = get(this.connStatus);
            const isCmd = get(this.isCmdController);
            const rtn: IconButtonDecl[] = [];

            if (get(getSettingsKeyAtom("debug:webglstatus"))) {
                const webglButton = this.getWebGlIconButton(get);
                if (webglButton) {
                    rtn.push(webglButton);
                }
            }

            if (blockData?.meta?.["controller"] != "cmd" && shellProcStatus != "done") {
                return rtn;
            }
            if (connStatus?.status != "connected") {
                return rtn;
            }
            let iconName: string = null;
            let title: string = null;
            const noun = isCmd ? "Command" : "Shell";
            if (shellProcStatus == "init") {
                iconName = "play";
                title = uiText("terminal.clickToStart", { noun: isCmd ? "命令" : noun });
            } else if (shellProcStatus == "running") {
                iconName = "refresh";
                title = uiText("terminal.runningRestart", { noun: isCmd ? "命令" : noun });
            } else if (shellProcStatus == "done") {
                iconName = "refresh";
                title = uiText("terminal.exitedRestart", { noun: isCmd ? "命令" : noun });
            }
            if (iconName != null) {
                const buttonDecl: IconButtonDecl = {
                    elemtype: "iconbutton",
                    icon: iconName,
                    click: () => fireAndForget(() => this.forceRestartController()),
                    title: title,
                };
                rtn.push(buttonDecl);
            }
            return rtn;
        });
        this.isCmdController = jotai.atom((get) => {
            const controllerMetaAtom = getBlockMetaKeyAtom(this.blockId, "controller");
            return get(controllerMetaAtom) == "cmd";
        });
        this.shellProcFullStatus = jotai.atom(null) as jotai.PrimitiveAtom<BlockControllerRuntimeStatus>;
        const initialShellProcStatus = services.BlockService.GetControllerStatus(blockId);
        initialShellProcStatus.then((rts) => {
            this.updateShellProcStatus(rts);
        });
        this.shellProcStatusUnsubFn = waveEventSubscribeSingle({
            eventType: "controllerstatus",
            scope: WOS.makeORef("block", blockId),
            handler: (event) => {
                this.updateShellProcStatus(event.data);
            },
        });
        this.shellProcStatus = jotai.atom((get) => {
            const fullStatus = get(this.shellProcFullStatus);
            return fullStatus?.shellprocstatus ?? "init";
        });
        this.termDurableStatus = jotai.atom((get) => {
            const isDurable = get(getBlockTermDurableAtom(this.blockId));
            if (!isDurable) {
                return null;
            }
            const blockJobStatus = get(this.blockJobStatusAtom);
            if (blockJobStatus?.jobid == null || blockJobStatus?.status == null) {
                return null;
            }
            return blockJobStatus;
        });
        this.termConfigedDurable = getBlockTermDurableAtom(this.blockId);
        this.blockJobStatusAtom = jotai.atom(null) as jotai.PrimitiveAtom<BlockJobStatusData>;
        this.blockJobStatusVersionTs = 0;
        const initialBlockJobStatus = RpcApi.BlockJobStatusCommand(TabRpcClient, blockId);
        initialBlockJobStatus
            .then((status) => {
                this.handleBlockJobStatusUpdate(status);
            })
            .catch((error) => {
                console.log("error getting initial block job status", error);
            });
        this.blockJobStatusUnsubFn = waveEventSubscribeSingle({
            eventType: "block:jobstatus",
            scope: `block:${blockId}`,
            handler: (event) => {
                this.handleBlockJobStatusUpdate(event.data);
            },
        });
        this.termBPMUnsubFn = globalStore.sub(this.termBPMAtom, () => {
            if (this.termRef.current?.terminal) {
                const allowBPM = globalStore.get(this.termBPMAtom) ?? true;
                this.termRef.current.terminal.options.ignoreBracketedPasteMode = !allowBPM;
            }
        });
        const termCursorAtom = getOverrideConfigAtom(blockId, "term:cursor");
        this.termCursorUnsubFn = globalStore.sub(termCursorAtom, () => {
            if (this.termRef.current?.terminal) {
                this.termRef.current.setCursorStyle(globalStore.get(termCursorAtom));
            }
        });
        const termCursorBlinkAtom = getOverrideConfigAtom(blockId, "term:cursorblink");
        this.termCursorBlinkUnsubFn = globalStore.sub(termCursorBlinkAtom, () => {
            if (this.termRef.current?.terminal) {
                this.termRef.current.setCursorBlink(globalStore.get(termCursorBlinkAtom) ?? false);
            }
        });
    }

    getWebGlIconButton(get: jotai.Getter): IconButtonDecl | null {
        if (!WebGLSupported) {
            return {
                elemtype: "iconbutton",
                icon: "microchip",
                iconColor: "var(--error-color)",
                title: uiText("terminal.webglUnsupported"),
                noAction: true,
            };
        }
        if (!this.termRef.current?.webglEnabledAtom) {
            return null;
        }
        const webglEnabled = get(this.termRef.current.webglEnabledAtom);
        if (webglEnabled) {
            return {
                elemtype: "iconbutton",
                icon: "microchip",
                iconColor: "var(--success-color)",
                title: uiText("terminal.webglEnabled"),
                click: () => this.toggleWebGl(),
            };
        }
        return {
            elemtype: "iconbutton",
            icon: "microchip",
            iconColor: "var(--secondary-text-color)",
            title: uiText("terminal.webglDisabled"),
            click: () => this.toggleWebGl(),
        };
    }

    get viewComponent(): ViewComponent {
        return TerminalView as ViewComponent;
    }

    isBasicTerm(getFn: jotai.Getter): boolean {
        const termMode = getFn(this.termMode);
        if (termMode == "vdom") {
            return false;
        }
        const blockData = getFn(this.blockAtom);
        if (blockData?.meta?.controller == "cmd") {
            return false;
        }
        return true;
    }

    multiInputHandler(data: string) {
        // A broadcast types into the other panes on purpose, so those panes are being used; the panes
        // themselves record that in sendUserInputToController. The targets are resolved here, when the
        // input is produced, so a pane created after multi-input was switched on is included.
        broadcastToOtherPanes(getAllBasicTermModels(), this, (atom) => globalStore.get(atom), data);
    }

    /**
     * Sends input the *user* produced, recording that this terminal has been used first.
     *
     * This is the path for every place the app itself turns a user action into terminal input - a
     * rewritten key press, a multi-input broadcast, a sticker's click command - because those return
     * false from the terminal's key handler and therefore never reach xterm's own key event.
     */
    sendUserInputToController(data: string) {
        this.markSnapTerminalTouched();
        this.sendDataToController(data);
    }

    /**
     * Low-level send to the block's controller.
     *
     * Do not call this for user input: it is also the terminal's data channel, which carries the
     * answers xterm generates for the program's queries. Use `sendUserInputToController` instead.
     */
    sendDataToController(data: string) {
        const b64data = stringToBase64(data);
        RpcApi.ControllerInputCommand(TabRpcClient, { blockid: this.blockId, inputdata64: b64data });
    }

    /**
     * Marks this terminal as used, the first time the user sends it input.
     *
     * Only terminals the Snap Bar created carry the provenance marker, and only those are ever
     * eligible for reclamation by a smaller preset. Writing this marker means "somebody typed here",
     * which disqualifies the pane for good - so a preset that would have to remove a pane can never
     * remove one that was used, even if the command journal never recorded a command for it.
     */
    markSnapTerminalTouched() {
        markSnapTerminalTouched(this.blockId);
    }

    setTermMode(mode: "term" | "vdom") {
        if (mode == "term") {
            mode = null;
        }
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: { "term:mode": mode },
        });
    }

    getTermRenderer(): "webgl" | "dom" {
        return this.termRef.current?.getTermRenderer() ?? "dom";
    }

    isWebGlEnabled(): boolean {
        return this.termRef.current?.isWebGlEnabled() ?? false;
    }

    toggleWebGl() {
        if (!this.termRef.current) {
            return;
        }
        const renderer = this.termRef.current.getTermRenderer() === "webgl" ? "dom" : "webgl";
        this.termRef.current.setTermRenderer(renderer);
    }

    triggerRestartAtom() {
        globalStore.set(this.isRestarting, true);
        setTimeout(() => {
            globalStore.set(this.isRestarting, false);
        }, 300);
    }

    handleBlockJobStatusUpdate(status: BlockJobStatusData) {
        if (status?.versionts == null) {
            return;
        }
        if (status.versionts <= this.blockJobStatusVersionTs) {
            return;
        }
        this.blockJobStatusVersionTs = status.versionts;
        globalStore.set(this.blockJobStatusAtom, status);
    }

    updateShellProcStatus(fullStatus: BlockControllerRuntimeStatus) {
        if (fullStatus == null) {
            return;
        }
        const curStatus = globalStore.get(this.shellProcFullStatus);
        if (curStatus == null || curStatus.version < fullStatus.version) {
            globalStore.set(this.shellProcFullStatus, fullStatus);
        }
    }

    getVDomModel(): VDomModel {
        const vdomBlockId = globalStore.get(this.vdomBlockId);
        if (!vdomBlockId) {
            return null;
        }
        const bcm = getBlockComponentModel(vdomBlockId);
        if (!bcm) {
            return null;
        }
        return bcm.viewModel as VDomModel;
    }

    getVDomToolbarModel(): VDomModel {
        const vdomToolbarBlockId = globalStore.get(this.vdomToolbarBlockId);
        if (!vdomToolbarBlockId) {
            return null;
        }
        const bcm = getBlockComponentModel(vdomToolbarBlockId);
        if (!bcm) {
            return null;
        }
        return bcm.viewModel as VDomModel;
    }

    dispose() {
        DefaultRouter.unregisterRoute(makeFeBlockRouteId(this.blockId));
        this.shellProcStatusUnsubFn?.();
        this.blockJobStatusUnsubFn?.();
        this.termBPMUnsubFn?.();
        this.termCursorUnsubFn?.();
        this.termCursorBlinkUnsubFn?.();
    }

    giveFocus(): boolean {
        if (this.searchAtoms && globalStore.get(this.searchAtoms.isOpen)) {
            console.log("search is open, not giving focus");
            return true;
        }
        const termMode = globalStore.get(this.termMode);
        if (termMode == "term") {
            if (this.termRef?.current?.terminal) {
                this.termRef.current.terminal.focus();
                return true;
            }
        }
        return false;
    }

    keyDownHandler(waveEvent: WaveKeyboardEvent): boolean {
        if (keyutil.checkKeyPressed(waveEvent, "Ctrl:r")) {
            const shellIntegrationStatus = readAtom(this.termRef?.current?.shellIntegrationStatusAtom);
            if (shellIntegrationStatus === "ready") {
                recordTEvent("action:term", { "action:type": "term:ctrlr" });
            }
            // just for telemetry, we allow this keybinding through, back to the terminal
            return false;
        }
        if (keyutil.checkKeyPressed(waveEvent, "Cmd:Escape")) {
            const blockAtom = WOS.getWaveObjectAtom<Block>(`block:${this.blockId}`);
            const blockData = globalStore.get(blockAtom);
            const newTermMode = blockData?.meta?.["term:mode"] == "vdom" ? null : "vdom";
            const vdomBlockId = globalStore.get(this.vdomBlockId);
            if (newTermMode == "vdom" && !vdomBlockId) {
                return;
            }
            this.setTermMode(newTermMode);
            return true;
        }
        if (keyutil.checkKeyPressed(waveEvent, "Shift:End")) {
            if (this.termRef?.current?.terminal) {
                this.termRef.current.terminal.scrollToBottom();
            }
            return true;
        }
        if (keyutil.checkKeyPressed(waveEvent, "Shift:Home")) {
            if (this.termRef?.current?.terminal) {
                this.termRef.current.terminal.scrollToLine(0);
            }
            return true;
        }
        if (isMacOS() && keyutil.checkKeyPressed(waveEvent, "Cmd:End")) {
            if (this.termRef?.current?.terminal) {
                this.termRef.current.terminal.scrollToBottom();
            }
            return true;
        }
        if (isMacOS() && keyutil.checkKeyPressed(waveEvent, "Cmd:Home")) {
            if (this.termRef?.current?.terminal) {
                this.termRef.current.terminal.scrollToLine(0);
            }
            return true;
        }
        if (keyutil.checkKeyPressed(waveEvent, "Shift:PageDown")) {
            if (this.termRef?.current?.terminal) {
                this.termRef.current.terminal.scrollPages(1);
            }
            return true;
        }
        if (keyutil.checkKeyPressed(waveEvent, "Shift:PageUp")) {
            if (this.termRef?.current?.terminal) {
                this.termRef.current.terminal.scrollPages(-1);
            }
            return true;
        }
        const blockData = globalStore.get(this.blockAtom);
        if (blockData.meta?.["term:mode"] == "vdom") {
            const vdomModel = this.getVDomModel();
            return vdomModel?.keyDownHandler(waveEvent);
        }
        return false;
    }

    shouldHandleCtrlVPaste(): boolean {
        // macOS never uses Ctrl-V for paste (uses Cmd-V)
        if (isMacOS()) {
            return false;
        }

        // Get the app:ctrlvpaste setting
        const ctrlVPasteAtom = getSettingsKeyAtom("app:ctrlvpaste");
        const ctrlVPasteSetting = globalStore.get(ctrlVPasteAtom);

        // If setting is explicitly set, use it
        if (ctrlVPasteSetting != null) {
            return ctrlVPasteSetting;
        }

        // Default behavior: Windows=true, Linux/other=false
        return isWindows();
    }

    handleTerminalKeydown(event: KeyboardEvent): boolean {
        const waveEvent = keyutil.adaptFromReactOrNativeKeyEvent(event);
        if (waveEvent.type != "keydown") {
            return true;
        }

        if (this.keyDownHandler(waveEvent)) {
            event.preventDefault();
            event.stopPropagation();
            return false;
        }

        if (isMacOS()) {
            if (keyutil.checkKeyPressed(waveEvent, "Cmd:ArrowLeft")) {
                this.sendUserInputToController("\x01"); // Ctrl-A (beginning of line)
                event.preventDefault();
                event.stopPropagation();
                return false;
            }
            if (keyutil.checkKeyPressed(waveEvent, "Cmd:ArrowRight")) {
                this.sendUserInputToController("\x05"); // Ctrl-E (end of line)
                event.preventDefault();
                event.stopPropagation();
                return false;
            }
        }
        if (keyutil.checkKeyPressed(waveEvent, "Shift:Enter")) {
            const shiftEnterNewlineAtom = getOverrideConfigAtom(this.blockId, "term:shiftenternewline");
            const shiftEnterNewlineEnabled = globalStore.get(shiftEnterNewlineAtom) ?? true;
            if (shiftEnterNewlineEnabled) {
                this.sendUserInputToController("\n");
                event.preventDefault();
                event.stopPropagation();
                return false;
            }
        }

        // Check for Ctrl-V paste (platform-dependent)
        if (this.shouldHandleCtrlVPaste() && keyutil.checkKeyPressed(waveEvent, "Ctrl:v")) {
            event.preventDefault();
            event.stopPropagation();
            getApi().nativePaste();
            return false;
        }

        if (keyutil.checkKeyPressed(waveEvent, "Ctrl:Shift:v")) {
            event.preventDefault();
            event.stopPropagation();
            getApi().nativePaste();
            // this.termRef.current?.pasteHandler();
            return false;
        } else if (keyutil.checkKeyPressed(waveEvent, "Ctrl:Shift:c")) {
            event.preventDefault();
            event.stopPropagation();
            let sel = this.termRef.current?.terminal.getSelection();
            if (!sel) {
                return false;
            }
            if (globalStore.get(getSettingsKeyAtom("term:trimtrailingwhitespace")) !== false) {
                sel = trimTerminalSelection(sel);
            }
            navigator.clipboard.writeText(sel);
            return false;
        } else if (keyutil.checkKeyPressed(waveEvent, "Cmd:k")) {
            event.preventDefault();
            event.stopPropagation();
            fireAndForget(() => clearProductHistoryForModel(this));
            return false;
        }
        const shellProcStatus = globalStore.get(this.shellProcStatus);
        if ((shellProcStatus == "done" || shellProcStatus == "init") && keyutil.checkKeyPressed(waveEvent, "Enter")) {
            fireAndForget(() => this.forceRestartController());
            return false;
        }
        const appHandled = appHandleKeyDown(waveEvent);
        if (appHandled) {
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
        return true;
    }

    setTerminalTheme(themeName: string) {
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: { "term:theme": themeName },
        });
    }

    async forceRestartController() {
        if (globalStore.get(this.isRestarting)) {
            return;
        }
        this.triggerRestartAtom();
        await RpcApi.ControllerDestroyCommand(TabRpcClient, this.blockId);
        const termsize = {
            rows: this.termRef.current?.terminal?.rows,
            cols: this.termRef.current?.terminal?.cols,
        };
        await RpcApi.ControllerResyncCommand(TabRpcClient, {
            tabid: globalStore.get(atoms.staticTabId),
            blockid: this.blockId,
            forcerestart: true,
            rtopts: { termsize: termsize },
        });
    }

    async restartSessionWithDurability(isDurable: boolean) {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: { "term:durable": isDurable },
        });
        await RpcApi.ControllerDestroyCommand(TabRpcClient, this.blockId);
        const termsize = {
            rows: this.termRef.current?.terminal?.rows,
            cols: this.termRef.current?.terminal?.cols,
        };
        await RpcApi.ControllerResyncCommand(TabRpcClient, {
            tabid: globalStore.get(atoms.staticTabId),
            blockid: this.blockId,
            forcerestart: true,
            rtopts: { termsize: termsize },
        });
    }

    getContextMenuItems(): ContextMenuItem[] {
        const menu: ContextMenuItem[] = [];
        const hasSelection = this.termRef.current?.terminal?.hasSelection();
        const selection = hasSelection ? this.termRef.current?.terminal.getSelection() : null;

        if (hasSelection) {
            menu.push({
            label: uiText("terminal.copy"),
                click: () => {
                    if (selection) {
                        const text =
                            globalStore.get(getSettingsKeyAtom("term:trimtrailingwhitespace")) !== false
                                ? trimTerminalSelection(selection)
                                : selection;
                        navigator.clipboard.writeText(text);
                    }
                },
            });
            menu.push({ type: "separator" });
        }

        const hoveredLinkUri = this.termRef.current?.hoveredLinkUri;
        if (hoveredLinkUri) {
            let hoveredURL: URL = null;
            try {
                hoveredURL = new URL(hoveredLinkUri);
            } catch (e) {
                // not a valid URL
            }
            if (hoveredURL) {
                menu.push({
            label: uiText("terminal.openUrlExternal"),
                    click: () => {
                        getApi().openExternal(hoveredURL.toString());
                    },
                });
                menu.push({ type: "separator" });
            }
        }

        menu.push({
            label: uiText("terminal.paste"),
            click: () => {
                getApi().nativePaste();
            },
        });

        menu.push({
            label: uiText("terminal.clearVisualHistory"),
            click: () => fireAndForget(() => clearProductHistoryForModel(this)),
        });

        menu.push({ type: "separator" });

        const magnified = globalStore.get(this.nodeModel.isMagnified);
        menu.push({
            label: magnified ? uiText("block.unmagnify") : uiText("block.magnify"),
            click: () => {
                this.nodeModel.toggleMagnify();
            },
        });

        menu.push({ type: "separator" });

        const settingsItems = this.getSettingsMenuItems();
        menu.push(...settingsItems);

        return menu;
    }

    getSettingsMenuItems(): ContextMenuItem[] {
        const fullConfig = globalStore.get(atoms.fullConfigAtom);
        const termThemes = fullConfig?.termthemes ?? {};
        const termThemeKeys = Object.keys(termThemes);
        const curThemeName = globalStore.get(getBlockMetaKeyAtom(this.blockId, "term:theme"));
        const defaultFontSize = globalStore.get(getSettingsKeyAtom("term:fontsize")) ?? 12;
        const defaultAllowBracketedPaste = globalStore.get(getSettingsKeyAtom("term:allowbracketedpaste")) ?? true;
        const transparencyMeta = globalStore.get(getBlockMetaKeyAtom(this.blockId, "term:transparency"));
        const blockData = globalStore.get(this.blockAtom);
        const overrideFontSize = blockData?.meta?.["term:fontsize"];

        termThemeKeys.sort((a, b) => {
            return (termThemes[a]["display:order"] ?? 0) - (termThemes[b]["display:order"] ?? 0);
        });
        const defaultTermBlockDef: BlockDef = {
            meta: {
                view: "term",
                controller: "shell",
            },
        };

        const fullMenu: ContextMenuItem[] = [];
        fullMenu.push({
                label: uiText("terminal.splitHorizontal"),
            click: () => {
                const blockData = globalStore.get(this.blockAtom);
                const blockDef: BlockDef = {
                    meta: blockData?.meta || defaultTermBlockDef.meta,
                };
                createBlockSplitHorizontally(blockDef, this.blockId, "after");
            },
        });
        fullMenu.push({
                label: uiText("terminal.splitVertical"),
            click: () => {
                const blockData = globalStore.get(this.blockAtom);
                const blockDef: BlockDef = {
                    meta: blockData?.meta || defaultTermBlockDef.meta,
                };
                createBlockSplitVertically(blockDef, this.blockId, "after");
            },
        });
        fullMenu.push({ type: "separator" });

        fullMenu.push({
                label: uiText("terminal.saveSession"),
            click: () => {
                if (this.termRef.current) {
                    const content = this.termRef.current.getScrollbackContent();
                    if (content) {
                        fireAndForget(async () => {
                            try {
                                const success = await getApi().saveTextFile("session.log", content);
                                if (!success) {
                                    console.log("Save scrollback cancelled by user");
                                }
                            } catch (error) {
                                console.error("Failed to save scrollback:", error);
                                const errorMessage = error?.message || "An unknown error occurred";
                                modalsModel.pushModal("MessageModal", {
                                    children: uiText("terminal.saveFailed", { detail: errorMessage }),
                                });
                            }
                        });
                    } else {
                        modalsModel.pushModal("MessageModal", {
                            children: uiText("terminal.noScrollback"),
                        });
                    }
                }
            },
        });
        fullMenu.push({ type: "separator" });

        const submenu: ContextMenuItem[] = termThemeKeys.map((themeName) => {
            return {
                label: termThemes[themeName]["display:name"] ?? themeName,
                type: "checkbox",
                checked: curThemeName == themeName,
                click: () => this.setTerminalTheme(themeName),
            };
        });
        submenu.unshift({
            label: uiText("terminal.default"),
            type: "checkbox",
            checked: curThemeName == null,
            click: () => this.setTerminalTheme(null),
        });
        const transparencySubMenu: ContextMenuItem[] = [];
        transparencySubMenu.push({
            label: uiText("terminal.default"),
            type: "checkbox",
            checked: transparencyMeta == null,
            click: () => {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", this.blockId),
                    meta: { "term:transparency": null },
                });
            },
        });
        transparencySubMenu.push({
            label: uiText("terminal.transparentBackground"),
            type: "checkbox",
            checked: transparencyMeta == 0.5,
            click: () => {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", this.blockId),
                    meta: { "term:transparency": 0.5 },
                });
            },
        });
        transparencySubMenu.push({
            label: uiText("terminal.noTransparency"),
            type: "checkbox",
            checked: transparencyMeta == 0,
            click: () => {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", this.blockId),
                    meta: { "term:transparency": 0 },
                });
            },
        });

        const fontSizeSubMenu: ContextMenuItem[] = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(
            (fontSize: number) => {
                return {
                    label: fontSize.toString() + "px",
                    type: "checkbox",
                    checked: overrideFontSize == fontSize,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "term:fontsize": fontSize },
                        });
                    },
                };
            }
        );
        fontSizeSubMenu.unshift({
            label: uiText("terminal.defaultWithValue", { value: defaultFontSize + "px" }),
            type: "checkbox",
            checked: overrideFontSize == null,
            click: () => {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", this.blockId),
                    meta: { "term:fontsize": null },
                });
            },
        });
        const overrideCursor = blockData?.meta?.["term:cursor"] as string | null | undefined;
        const overrideCursorBlink = blockData?.meta?.["term:cursorblink"] as boolean | null | undefined;
        const isCursorDefault = overrideCursor == null && overrideCursorBlink == null;
        // normalize for comparison: null/undefined/"block" all mean "block"
        const effectiveCursor = overrideCursor === "underline" || overrideCursor === "bar" ? overrideCursor : "block";
        const effectiveCursorBlink = overrideCursorBlink === true;
        const cursorSubMenu: ContextMenuItem[] = [
            {
                label: uiText("terminal.cursorDefault"),
                type: "checkbox",
                checked: isCursorDefault,
                click: () => {
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", this.blockId),
                        meta: { "term:cursor": null, "term:cursorblink": null },
                    });
                },
            },
            {
                label: uiText("terminal.cursorBlock"),
                type: "checkbox",
                checked: !isCursorDefault && effectiveCursor === "block" && !effectiveCursorBlink,
                click: () => {
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", this.blockId),
                        meta: { "term:cursor": "block", "term:cursorblink": false },
                    });
                },
            },
            {
                label: uiText("terminal.cursorBlockBlink"),
                type: "checkbox",
                checked: !isCursorDefault && effectiveCursor === "block" && effectiveCursorBlink,
                click: () => {
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", this.blockId),
                        meta: { "term:cursor": "block", "term:cursorblink": true },
                    });
                },
            },
            {
                label: uiText("terminal.cursorBar"),
                type: "checkbox",
                checked: !isCursorDefault && effectiveCursor === "bar" && !effectiveCursorBlink,
                click: () => {
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", this.blockId),
                        meta: { "term:cursor": "bar", "term:cursorblink": false },
                    });
                },
            },
            {
                label: uiText("terminal.cursorBarBlink"),
                type: "checkbox",
                checked: !isCursorDefault && effectiveCursor === "bar" && effectiveCursorBlink,
                click: () => {
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", this.blockId),
                        meta: { "term:cursor": "bar", "term:cursorblink": true },
                    });
                },
            },
            {
                label: uiText("terminal.cursorUnderline"),
                type: "checkbox",
                checked: !isCursorDefault && effectiveCursor === "underline" && !effectiveCursorBlink,
                click: () => {
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", this.blockId),
                        meta: { "term:cursor": "underline", "term:cursorblink": false },
                    });
                },
            },
            {
                label: uiText("terminal.cursorUnderlineBlink"),
                type: "checkbox",
                checked: !isCursorDefault && effectiveCursor === "underline" && effectiveCursorBlink,
                click: () => {
                    RpcApi.SetMetaCommand(TabRpcClient, {
                        oref: WOS.makeORef("block", this.blockId),
                        meta: { "term:cursor": "underline", "term:cursorblink": true },
                    });
                },
            },
        ];
        fullMenu.push({
            label: uiText("terminal.themes"),
            submenu: submenu,
        });
        fullMenu.push({
            label: uiText("terminal.fontSize"),
            submenu: fontSizeSubMenu,
        });
        fullMenu.push({
            label: uiText("terminal.cursor"),
            submenu: cursorSubMenu,
        });
        fullMenu.push({
            label: uiText("terminal.transparency"),
            submenu: transparencySubMenu,
        });
        fullMenu.push({ type: "separator" });
        const advancedSubmenu: ContextMenuItem[] = [];
        const allowBracketedPaste = blockData?.meta?.["term:allowbracketedpaste"];
        advancedSubmenu.push({
            label: uiText("terminal.allowBracketedPaste"),
            submenu: [
                {
                    label: uiText("terminal.defaultWithValue", { value: defaultAllowBracketedPaste ? uiText("menu.on") : uiText("menu.off") }),
                    type: "checkbox",
                    checked: allowBracketedPaste == null,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "term:allowbracketedpaste": null },
                        });
                    },
                },
                {
                    label: uiText("menu.on"),
                    type: "checkbox",
                    checked: allowBracketedPaste === true,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "term:allowbracketedpaste": true },
                        });
                    },
                },
                {
                    label: uiText("menu.off"),
                    type: "checkbox",
                    checked: allowBracketedPaste === false,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "term:allowbracketedpaste": false },
                        });
                    },
                },
            ],
        });
        advancedSubmenu.push({
            label: uiText("terminal.forceRestartController"),
            click: () => fireAndForget(() => this.forceRestartController()),
        });
        const isClearOnStart = blockData?.meta?.["cmd:clearonstart"];
        advancedSubmenu.push({
            label: uiText("terminal.clearOutputOnRestart"),
            submenu: [
                {
                    label: uiText("menu.on"),
                    type: "checkbox",
                    checked: isClearOnStart,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "cmd:clearonstart": true },
                        });
                    },
                },
                {
                    label: uiText("menu.off"),
                    type: "checkbox",
                    checked: !isClearOnStart,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "cmd:clearonstart": false },
                        });
                    },
                },
            ],
        });
        const runOnStart = blockData?.meta?.["cmd:runonstart"];
        advancedSubmenu.push({
            label: uiText("terminal.runOnStartup"),
            submenu: [
                {
                    label: uiText("menu.on"),
                    type: "checkbox",
                    checked: runOnStart,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "cmd:runonstart": true },
                        });
                    },
                },
                {
                    label: uiText("menu.off"),
                    type: "checkbox",
                    checked: !runOnStart,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "cmd:runonstart": false },
                        });
                    },
                },
            ],
        });
        const debugConn = blockData?.meta?.["term:conndebug"];
        advancedSubmenu.push({
            label: uiText("terminal.debugConnection"),
            submenu: [
                {
                    label: uiText("menu.off"),
                    type: "checkbox",
                    checked: !debugConn,
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "term:conndebug": null },
                        });
                    },
                },
                {
                    label: uiText("terminal.info"),
                    type: "checkbox",
                    checked: debugConn == "info",
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "term:conndebug": "info" },
                        });
                    },
                },
                {
                    label: uiText("terminal.verbose"),
                    type: "checkbox",
                    checked: debugConn == "debug",
                    click: () => {
                        RpcApi.SetMetaCommand(TabRpcClient, {
                            oref: WOS.makeORef("block", this.blockId),
                            meta: { "term:conndebug": "debug" },
                        });
                    },
                },
            ],
        });

        const isDurable = globalStore.get(getBlockTermDurableAtom(this.blockId));
        if (isDurable) {
            advancedSubmenu.push({
            label: uiText("terminal.sessionDurability"),
                submenu: [
                    {
                        label: uiText("terminal.restartStandard"),
                        click: () => fireAndForget(() => this.restartSessionWithDurability(false)),
                    },
                ],
            });
        } else if (isDurable === false) {
            advancedSubmenu.push({
                label: uiText("terminal.sessionDurability"),
                submenu: [
                    {
                        label: uiText("terminal.restartDurable"),
                        click: () => fireAndForget(() => this.restartSessionWithDurability(true)),
                    },
                ],
            });
        }

        fullMenu.push({
            label: uiText("terminal.advanced"),
            submenu: advancedSubmenu,
        });
        if (blockData?.meta?.["term:vdomtoolbarblockid"]) {
            fullMenu.push({ type: "separator" });
            fullMenu.push({
                label: uiText("terminal.closeToolbar"),
                click: () => {
                    RpcApi.DeleteSubBlockCommand(TabRpcClient, { blockid: blockData.meta["term:vdomtoolbarblockid"] });
                },
            });
        }
        return fullMenu;
    }
}

export function getAllBasicTermModels(): TermViewModel[] {
    const termModels: TermViewModel[] = [];
    const bcms = getAllBlockComponentModels();
    for (const bcm of bcms) {
        if (bcm?.viewModel?.viewType == "term") {
            const tvm = bcm.viewModel as TermViewModel;
            if (tvm.isBasicTerm((atom) => globalStore.get(atom))) {
                termModels.push(tvm);
            }
        }
    }
    return termModels;
}
