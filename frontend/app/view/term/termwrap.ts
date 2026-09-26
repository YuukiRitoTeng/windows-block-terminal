// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setBadge } from "@/app/store/badge";
import { getFileSubject, waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    fetchWaveFile,
    getApi,
    getOverrideConfigAtom,
    getSettingsKeyAtom,
    globalStore,
    isDev,
    openLink,
    WOS,
} from "@/store/global";
import * as services from "@/store/services";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { base64ToArray, fireAndForget } from "@/util/util";
import { installUserInputSeam, UserInputSeam } from "./user-input-source";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import * as TermTypes from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import debug from "debug";
import * as jotai from "jotai";
import { debounce } from "throttle-debounce";
import {
    handleOsc16162Command,
    handleOsc52Command,
    handleOsc7Command,
    isClaudeCodeCommand,
    type ShellIntegrationStatus,
} from "./osc-handlers";
import {
    drainTerminalIngress,
    extractVisualAnchorFrames,
    extractVisualAnchorNonces,
    type TerminalIngressChunk,
} from "./terminal-ingress";
import {
    commandRegionBoundary,
    commandRegionRange,
    commandRegionReadable,
    commandRegionText,
    type CommandRegionMark,
} from "./command-output-region";
import {
    bufferLinesToText,
    createTempFileFromBlob,
    extractAllClipboardData,
    normalizeCursorStyle,
    quoteForPosixShell,
    trimTerminalSelection,
} from "./termutil";
import { authorityForMark, isKnownAuthority, VisualAnchorRegistry } from "./visual-anchor";

const dlog = debug("wave:termwrap");

const TermFileName = "term";
const TermCacheFileName = "cache:term:full";
const MinDataProcessedForCache = 100 * 1024;
export const SupportsImageInput = true;


// detect webgl support
function detectWebGLSupport(): boolean {
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("webgl2");
        return !!ctx;
    } catch (e) {
        return false;
    }
}

export const WebGLSupported = detectWebGLSupport();
let loggedWebGL = false;

type TermWrapOptions = {
    keydownHandler?: (e: KeyboardEvent) => boolean;
    useWebGl?: boolean;
    sendDataHandler?: (data: string) => void;
    /**
     * Called the first time the user sends input to this terminal.
     *
     * Used to mark a Snap-created filler terminal as used, so a preset that would have to remove a
     * pane can never reclaim one somebody has typed into. Fires at most once per TermWrap.
     */
    userInputHandler?: () => void;
    nodeModel?: BlockNodeModel;
};

export type CommandAnchorSnapshot = Readonly<{
    commandId: string;
    /**
     * The session epoch the anchor was confirmed in. Rail navigation is scoped to the current live
     * session: a durable record from an earlier epoch is history, not a region of this terminal.
     */
    sessionEpoch: string;
}>;


export class TermWrap {
    tabId: string;
    blockId: string;
    ptyOffset: number;
    dataBytesProcessed: number;
    terminal: Terminal;
    connectElem: HTMLDivElement;
    fitAddon: FitAddon;
    searchAddon: SearchAddon;
    serializeAddon: SerializeAddon;
    mainFileSubject: SubjectWithRef<WSFileEventData>;
    /**
     * The TermWrap-owned subscription to the block file subject. Kept so dispose can unsubscribe:
     * releasing the subject reference alone does not stop this subscriber from being called.
     */
    private mainFileSubscription: { unsubscribe: () => void } | null = null;
    private disposedOnce = false;
    private idleTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    private idleCallbackHandle: number | null = null;

    /** Writes started from inside a parser handler, counted against the current lane slot. */
    loaded: boolean;
    heldData: TerminalIngressChunk[];
    private heldDataSequence: number;
    private ingressGeneration: number;
    private ingressState: "loading" | "draining" | "live" | "disposed";
    /**
     * Non-null while a product clear is running: display writes submitted during the boundary
     * wait for it instead of racing it, so the clear can never erase fresh output.
     */
    /**
     * The presentation lane: one FIFO for every operation that changes this pane's xterm buffer,
     * cursor or viewport. Producers enqueue through runInPresentationLane, so the order they are
     * issued in is the order they complete in - PTY writes (each one resolves on xterm's own write
     * callback), the product clear transaction, resize/reflow, the file-origin reset and the
     * restore-time resizes. No sleeps, no fence bytes, no private xterm access.
     */
    private presentationTail: Promise<void> = Promise.resolve();
    private ingressDrainPromise: Promise<void> | null;

    /**
     * Product Global Clear: a terminal-owned buffer operation.
     *
     * xterm's public clear() empties the buffer and keeps the current prompt/cursor line as
     * the new first line, so the shell never has to draw its prompt again. Nothing is sent to
     * the PTY: no CR/Enter, no Ctrl+L, no Clear-Host, no shell command of any kind. The shell,
     * its cwd/environment/functions and any interactive process keep running untouched.
     */
    /**
     * Product Global Clear: a terminal-owned, display-only transaction.
     *
     * The mutation is xterm's own public `Terminal.clear()`. It is a core buffer operation -
     * it never goes through the parser and never reaches the PTY - which is exactly what makes
     * it safe: application terminal modes (DECSTBM, DECOM, alternate buffer) cannot influence
     * it, and it cannot truncate, terminate or fabricate an application frame that happens to
     * be mid-parse. It keeps the line the cursor is in, which is where the shell leaves its
     * prompt, so the prompt survives the clear without any shell-side repaint.
     *
     * The only refusal is the upstream xterm.js#5992 state: with the cursor on the first row and
     * no scrollback while the screen still has content, `clear()` returns without doing
     * anything. The column is irrelevant. That is detected through the public buffer API
     * *before* the backend visibility transaction is submitted, so such a clear is refused as a
     * whole instead of silently doing nothing or truncating anything.
     */
    async withProductClearBoundary<T>(
        run: (session: { prepare(): boolean; apply(): Promise<void> }) => Promise<T>
    ): Promise<T | null> {
        if (!this.isLive()) {
            return null;
        }
        // One lane slot for the whole transaction (preflight -> backend -> clear -> presentation
        // reset). A second clear therefore queues behind the first instead of overwriting it, and
        // everything enqueued before it has already reached the buffer.
        return this.runInPresentationLane(async () => {
            if (!this.isLive()) {
                return null;
            }
            return run({
                prepare: () => this.canClearProductBuffer(),
                apply: async () => {
                    // The backend transaction may have completed while this pane was disposed. The
                    // durable commit stands; there is simply no renderer left to mutate.
                    if (!this.isLive()) {
                        return;
                    }
                    await this.applyProductClear();
                },
            });
        });
    }

    /**
     * Whether the public clear can run for the current buffer state. The one state that cannot
     * is xterm.js#5992 (cursor on the first row with content and no scrollback), where `clear()`
     * would return without doing anything.
     */
    canClearProductBuffer(): boolean {
        if (this.ingressState === "disposed") {
            return false;
        }
        const buffer = this.terminal.buffer.active;
        if (buffer == null) {
            return false;
        }
        if (buffer.type === "alternate") {
            // Global Clear only promises the normal buffer's visual history. In the alternate buffer
            // the public clear would empty a screen that is not the one the user returns to, leaving
            // visual truth and the durable visibility generation disagreeing once the application
            // leaves the alternate buffer. Fail safe: no backend commit, no clear, and no attempt to
            // exit the alternate buffer (that recovery path is a separate, deferred task).
            return false;
        }
        // The real xterm 6.0.0 early return is a cursor row of 0 with no scrollback - the column
        // does not matter (upstream xterm.js#5992). Checking only column 0 missed the no-op and
        // committed a backend transaction whose screen never changed.
        const cursorOnFirstRow = buffer.cursorY === 0 && buffer.baseY === 0;
        if (!cursorOnFirstRow) {
            return true;
        }
        // On the first row the public clear does nothing. That is only a problem when there is
        // something else to remove: a screen that holds nothing but the cursor's own line is
        // already in the state a clear would produce.
        return !this.bufferHasContentOutsideCursorRow(buffer, buffer.cursorY);
    }

    /** Whether any row other than the cursor's own line holds content. */
    private bufferHasContentOutsideCursorRow(buffer: TermTypes.IBuffer, cursorRow: number): boolean {
        for (let row = 0; row < buffer.length; row++) {
            if (row === cursorRow) {
                continue;
            }
            if ((buffer.getLine(row)?.translateToString(true) ?? "").length > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * Applies the clear through xterm's own buffer operation and rebuilds WBT's presentation
     * state around it. No parser bytes, no PTY input, no shell interaction.
     */
    async applyProductClear(): Promise<void> {
        if (!this.isLive()) {
            return;
        }
        this.terminal.clear();
        this.visualBufferGeneration += 1;
        this.releasePresentationState();
    }
    /**
     * Hard reset of the rendered view for a new file origin (truncate / resync). This is not
     * the product Clear: it also restarts the ingress stream and is the only path allowed to
     * discard held data and reset the read cursor.
     */
    /**
     * Hard reset of the rendered view for a new file origin. It is not the product clear (the VT
     * reset sequence stays here), but it is a presentation mutation: it runs as one lane slot and
     * only completes once xterm has actually parsed its reset sequence.
     */
    resetTerminalFileOrigin(): Promise<void> {
        if (!this.isLive()) {
            return Promise.resolve();
        }
        return this.runInPresentationLane(async () => {
            if (!this.isLive()) {
                return;
            }
            await this.writeParsed("\x1b[2J\x1b[3J\x1b[H");
            // The callback may resume after the pane was disposed: disposed is terminal, so the
            // ingress lifecycle is never moved back to live and no state is touched.
            if (!this.isLive()) {
                return;
            }
            this.visualBufferGeneration += 1;
            this.ingressGeneration++;
            this.heldData = [];
            if (!this.loaded) {
                this.loaded = true;
                this.ingressState = "live";
            }
            this.releasePresentationState();
        });
    }


    /**
     * Invalidates every presentation-only binding the clear has to drop: WBT visual anchors,
     * their cues/decorations and the prompt markers, then tells the Rail to re-read.
     */
    private releasePresentationState() {
        this.visualAnchorRegistry.invalidate();
        for (const [, cue] of this.visualAnchorCues) {
            try {
                cue.marker.dispose();
                cue.decoration?.dispose();
            } catch (_) {
                /* nothing */
            }
        }
        this.visualAnchorCues.clear();
        this.promptMarkers.forEach((marker) => {
            try {
                marker.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        this.promptMarkers = [];
        this.notifyCommandAnchorSubscribers();
    }
    handleResize_debounced: () => void;
    hasResized: boolean;
    multiInputCallback: (data: string) => void;
    sendDataHandler: (data: string) => void;
    userInputHandler?: () => void;
    private userInputReported: boolean;
    /**
     * Tells user input apart from the answers xterm generates to the program's queries.
     * xterm classifies every outgoing payload itself, so this needs no timing assumption.
     */
    private userInputSeam: UserInputSeam | null = null;
    onSearchResultsDidChange?: (result: { resultIndex: number; resultCount: number }) => void;
    toDispose: TermTypes.IDisposable[] = [];
    webglAddon: WebglAddon | null = null;
    webglContextLossDisposable: TermTypes.IDisposable | null = null;
    webglEnabledAtom: jotai.PrimitiveAtom<boolean>;
    pasteActive: boolean = false;
    lastUpdated: number;
    promptMarkers: TermTypes.IMarker[] = [];
    visualAnchorRegistry = new VisualAnchorRegistry();
    private visualAnchorCues = new Map<string, { marker: TermTypes.IMarker; generation: number; decoration?: TermTypes.IDecoration; inlineDecoration?: TermTypes.IDecoration; inlineRender?: TermTypes.IDisposable; announced?: boolean }>();
    // Bumped whenever the visual buffer is reset: a marker from an older generation
    // can no longer be read as output, it is reported as unavailable instead.
    private visualBufferGeneration = 0;

    private selectedCommandAnchor: string | null = null;
    private commandAnchorSubscribers = new Set<() => void>();
    visualAnchorEventUnsub: (() => void) | null = null;
    shellIntegrationStatusAtom: jotai.PrimitiveAtom<ShellIntegrationStatus | null>;
    lastCommandAtom: jotai.PrimitiveAtom<string | null>;
    claudeCodeActiveAtom: jotai.PrimitiveAtom<boolean>;
    nodeModel: BlockNodeModel; // this can be null
    hoveredLinkUri: string | null = null;
    onLinkHover?: (uri: string | null, mouseX: number, mouseY: number) => void;

    getCommandAnchorSnapshot(): readonly CommandAnchorSnapshot[] {
        const anchors: CommandAnchorSnapshot[] = [];
        for (const [nonce, cue] of this.visualAnchorCues) {
            const confirmed = this.visualAnchorRegistry.get(nonce);
            // Only the current shell session's bindings are navigable. A stale binding from the
            // session this pane replaced must never reappear as a live anchor.
            const currentEpoch = this.visualAnchorRegistry.sessionEpoch;
            if (
                isKnownAuthority(confirmed?.authority) &&
                !cue.marker.isDisposed &&
                (currentEpoch === "" || confirmed.sessionEpoch === currentEpoch)
            ) {
                anchors.push(Object.freeze({ commandId: confirmed.commandId, sessionEpoch: confirmed.sessionEpoch ?? "" }));
            }
        }
        return Object.freeze(anchors);
    }

    subscribeCommandAnchors(listener: () => void): () => void {
        this.commandAnchorSubscribers.add(listener);
        return () => this.commandAnchorSubscribers.delete(listener);
    }


    /**
     * Replaces the visual buffer without pretending to be the shell. After the buffer
     * is cleared the real prompt is gone, so the shell is asked to draw it again: a
     * bare line feed makes the shell print its own prompt (the user's prompt, its cwd
     * and its customisations), and it is only sent while the shell itself reported an
     * idle prompt - a running interactive program never receives it.
     */

    /**
     * Applies the integration facts a previous wrapper already recorded for this pane.
     * "shell:integration" is written only for a lifecycle frame that carried the
     * integration's own identity (see osc-handlers); it describes the pane, nothing else.
     */
    applyRestoredShellIntegration(rtInfo: Record<string, unknown> | null | undefined): ShellIntegrationStatus {
        if (rtInfo == null || !rtInfo["shell:integration"]) return null;
        return (rtInfo["shell:state"] as ShellIntegrationStatus) ?? null;
    }

    /**
     * The command's user-visible output on the terminal authority, read from the
     * terminal buffer between this command's marker and the next command's marker
     * (or the live cursor line for the newest command). This is the source of
     * truth for what the user saw; the journal copy for this authority cannot
     * prove where a command's last byte landed.
     *
     * Returns undefined when the command has no confirmed marker, when the region's
     * end cannot be proven, when the region can no longer be read (evicted
     * scrollback, cleared buffer, disposed marker), and "" when the command
     * produced no output lines.
     */
    getTerminalOutputForCommand(commandId: string): string | undefined {
        if (commandId === "") return undefined;
        // Every mark in the buffer is reported with what is known about it. A mark is
        // only attributed to a command when the anchor registry confirmed that identity:
        // a raw or pending `B` mark carries no authority of its own, so it can never
        // decide where a command's output ends.
        const marks: CommandRegionMark[] = [];
        let ownMarker: TermTypes.IMarker | null = null;
        for (const [nonce, cue] of this.visualAnchorCues) {
            if (cue.marker.isDisposed || cue.generation !== this.visualBufferGeneration) continue;
            const confirmed = this.visualAnchorRegistry.get(nonce);
            const trusted = isKnownAuthority(confirmed?.authority);
            marks.push(
                trusted
                    ? {
                          line: cue.marker.line,
                          authority: confirmed.authority,
                          sessionEpoch: confirmed.sessionEpoch,
                          commandId: confirmed.commandId,
                      }
                    : { line: cue.marker.line }
            );
            if (trusted && confirmed.commandId === commandId && ownMarker == null) ownMarker = cue.marker;
        }
        const boundary = commandRegionBoundary(marks, commandId);
        if (boundary == null || ownMarker == null) return undefined;
        const buffer = this.terminal.buffer.active;
        const cursorLine = buffer.baseY + buffer.cursorY;
        const bounds = { startLine: boundary.startLine, nextLine: boundary.nextLine, cursorLine };
        // A region is only readable while its boundary markers are alive in the buffer
        // the terminal is showing: the answer is then "unavailable", never a clamped
        // region that would silently copy the wrong text.
        const readable = commandRegionReadable(bounds, {
            markerValid: boundary.startLine < buffer.length,
            nextValid: boundary.nextLine != null && boundary.nextLine < buffer.length,
            bufferLength: buffer.length,
        });
        if (!readable) return undefined;
        const { start, end } = commandRegionRange(bounds);
        return commandRegionText(bufferLinesToText(buffer, start, end));
    }

    scrollToCommandAnchor(commandId: string): boolean {
        for (const [nonce, cue] of this.visualAnchorCues) {
            const confirmed = this.visualAnchorRegistry.get(nonce);
            if (!isKnownAuthority(confirmed?.authority) || confirmed.commandId !== commandId || cue.marker.isDisposed) continue;
            this.terminal.scrollToLine(cue.marker.line);
            return true;
        }
        return false;
    }

    setSelectedCommandAnchor(commandId: string | null): void {
        const validId = this.getCommandAnchorSnapshot().some(anchor => anchor.commandId === commandId) ? commandId : null;
        if (this.selectedCommandAnchor === validId) return;
        const previous = this.selectedCommandAnchor;
        this.selectedCommandAnchor = validId;
        for (const [nonce] of this.visualAnchorCues) {
            const id = this.visualAnchorRegistry.get(nonce)?.commandId;
            if (id === previous || id === validId) this.renderSelectedCommandCue(nonce);
        }
    }

    private renderSelectedCommandCue(nonce: string): void {
        const cue = this.visualAnchorCues.get(nonce);
        if (!cue) return;
        cue.inlineRender?.dispose();
        cue.inlineDecoration?.dispose();
        cue.inlineRender = undefined;
        cue.inlineDecoration = undefined;
        const confirmed = this.visualAnchorRegistry.get(nonce);
        if (!isKnownAuthority(confirmed?.authority) || cue.marker.isDisposed) return;
        try {
            const decoration = this.terminal.registerDecoration({ marker: cue.marker, width: 1, height: 1, layer: "top" });
            if (decoration != null) {
                const selected = confirmed.commandId === this.selectedCommandAnchor;
                cue.inlineDecoration = decoration;
                cue.inlineRender = decoration.onRender(element => {
                    element.className = `xterm-decoration command-region-cue${selected ? " is-selected" : ""}`;
                    element.dataset.commandId = confirmed.commandId;
                    element.setAttribute("aria-hidden", "true");
                });
            }
        } catch (_) {
            // Decoration support is optional; never disrupt the live terminal.
        }
    }

    private notifyCommandAnchorSubscribers(): void {
        for (const listener of this.commandAnchorSubscribers) listener();
    }

    // Paste deduplication
    // xterm.js paste() method triggers onData event, which can cause duplicate sends
    lastPasteData: string = "";
    lastPasteTime: number = 0;

    // dev only (for debugging)
    recentWrites: { idx: number; data: string; ts: number }[] = [];
    recentWritesCounter: number = 0;



    constructor(
        tabId: string,
        blockId: string,
        connectElem: HTMLDivElement,
        options: TermTypes.ITerminalOptions & TermTypes.ITerminalInitOnlyOptions,
        waveOptions: TermWrapOptions
    ) {
        this.loaded = false;
        this.ingressState = "loading";
        this.ingressGeneration = 0;
        this.heldDataSequence = 0;
        this.ingressDrainPromise = null;
        this.tabId = tabId;
        this.blockId = blockId;
        this.sendDataHandler = waveOptions.sendDataHandler;
        this.userInputHandler = waveOptions.userInputHandler;
        this.nodeModel = waveOptions.nodeModel;
        this.ptyOffset = 0;
        this.dataBytesProcessed = 0;
        this.hasResized = false;
        this.lastUpdated = Date.now();
        this.promptMarkers = [];
        this.shellIntegrationStatusAtom = jotai.atom(null) as jotai.PrimitiveAtom<ShellIntegrationStatus | null>;
        this.lastCommandAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.claudeCodeActiveAtom = jotai.atom(false);
        this.webglEnabledAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
        this.terminal = new Terminal(options);
        this.terminal.options.overviewRuler = { width: 4, showTopBorder: false, showBottomBorder: false };
        this.fitAddon = new FitAddon();
        this.serializeAddon = new SerializeAddon();
        this.searchAddon = new SearchAddon();
        this.terminal.loadAddon(this.searchAddon);
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.serializeAddon);
        this.terminal.loadAddon(
            new WebLinksAddon(
                (e, uri) => {
                    e.preventDefault();
                    switch (PLATFORM) {
                        case PlatformMacOS:
                            if (e.metaKey) {
                                fireAndForget(() => openLink(uri));
                            }
                            break;
                        default:
                            if (e.ctrlKey) {
                                fireAndForget(() => openLink(uri));
                            }
                            break;
                    }
                },
                {
                    hover: (e, uri) => {
                        this.hoveredLinkUri = uri;
                        this.onLinkHover?.(uri, e.clientX, e.clientY);
                    },
                    leave: () => {
                        this.hoveredLinkUri = null;
                        this.onLinkHover?.(null, 0, 0);
                    },
                }
            )
        );
        this.setTermRenderer(WebGLSupported && waveOptions.useWebGl ? "webgl" : "dom");
        // Register OSC handlers
        this.terminal.parser.registerOscHandler(7, (data: string) => {
            try {
                return handleOsc7Command(data, this.blockId, this.loaded);
            } catch (e) {
                console.error("[termwrap] osc 7 handler error", this.blockId, e);
                return false;
            }
        });
        this.terminal.parser.registerOscHandler(52, (data: string) => {
            try {
                return handleOsc52Command(data, this.blockId, this.loaded, this);
            } catch (e) {
                console.error("[termwrap] osc 52 handler error", this.blockId, e);
                return false;
            }
        });
        this.terminal.parser.registerOscHandler(16162, (data: string) => {
            try {
                return handleOsc16162Command(data, this.blockId, this.loaded, this);
            } catch (e) {
                console.error("[termwrap] osc 16162 handler error", this.blockId, e);
                return false;
            }
        });

        this.toDispose.push(
            this.terminal.onBell(() => {
                if (!this.loaded) {
                    return true;
                }
                console.log("BEL received in terminal", this.blockId);
                const bellSoundEnabled =
                    globalStore.get(getOverrideConfigAtom(this.blockId, "term:bellsound")) ?? false;
                if (bellSoundEnabled) {
                    fireAndForget(() => RpcApi.ElectronSystemBellCommand(TabRpcClient, { route: "electron" }));
                }
                const bellIndicatorEnabled =
                    globalStore.get(getOverrideConfigAtom(this.blockId, "term:bellindicator")) ?? false;
                if (bellIndicatorEnabled) {
                    setBadge(this.blockId, { icon: "bell", color: "#fbbf24", priority: 1 });
                }
                return true;
            })
        );
        this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
            if (!waveOptions.keydownHandler) {
                return true;
            }
            return waveOptions.keydownHandler(e);
        });
        this.connectElem = connectElem;
        this.mainFileSubject = null;
        this.heldData = [];
        this.handleResize_debounced = debounce(50, this.handleResize.bind(this));
        this.terminal.open(this.connectElem);

        const dragoverHandler = (e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = "copy";
            }
        };
        const dropHandler = (e: DragEvent) => {
            e.preventDefault();
            if (!e.dataTransfer || e.dataTransfer.files.length === 0) {
                return;
            }
            const paths: string[] = [];
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                const filePath = getApi().getPathForFile(file);
                if (filePath) {
                    paths.push(quoteForPosixShell(filePath));
                }
            }
            if (paths.length > 0) {
                // terminal.paste() goes through xterm's own user-input path, so the seam reports and
                // broadcasts the dropped paths exactly like any other paste.
                this.terminal.paste(paths.join(" ") + " ");
            }
        };
        this.connectElem.addEventListener("dragover", dragoverHandler);
        this.connectElem.addEventListener("drop", dropHandler);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("dragover", dragoverHandler);
                this.connectElem.removeEventListener("drop", dropHandler);
            },
        });
        this.handleResize();
        const pasteHandler = this.pasteHandler.bind(this);
        this.connectElem.addEventListener("paste", pasteHandler, true);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("paste", pasteHandler, true);
            },
        });
    }

    getZoneId(): string {
        return this.blockId;
    }

    setCursorStyle(cursorStyle: string) {
        this.terminal.options.cursorStyle = normalizeCursorStyle(cursorStyle);
    }

    setCursorBlink(cursorBlink: boolean) {
        this.terminal.options.cursorBlink = cursorBlink ?? false;
    }

    setTermRenderer(renderer: "webgl" | "dom") {
        if (renderer === "webgl") {
            if (this.webglAddon != null) {
                return;
            }
            if (!WebGLSupported) {
                renderer = "dom";
            }
        } else {
            if (this.webglAddon == null) {
                return;
            }
        }
        if (this.webglAddon != null) {
            this.webglContextLossDisposable?.dispose();
            this.webglContextLossDisposable = null;
            this.webglAddon.dispose();
            this.webglAddon = null;
            globalStore.set(this.webglEnabledAtom, false);
        }
        if (renderer === "webgl") {
            const addon = new WebglAddon();
            this.webglContextLossDisposable = addon.onContextLoss(() => {
                this.setTermRenderer("dom");
            });
            this.terminal.loadAddon(addon);
            this.webglAddon = addon;
            globalStore.set(this.webglEnabledAtom, true);
            if (!loggedWebGL) {
                console.log("loaded webgl!");
                loggedWebGL = true;
            }
        }
    }

    getTermRenderer(): "webgl" | "dom" {
        return this.webglAddon != null ? "webgl" : "dom";
    }

    isWebGlEnabled(): boolean {
        return this.webglAddon != null;
    }

    async initTerminal() {
        const ingressGeneration = this.ingressGeneration;
        const copyOnSelectAtom = getSettingsKeyAtom("term:copyonselect");
        const trimTrailingWhitespaceAtom = getSettingsKeyAtom("term:trimtrailingwhitespace");
        this.toDispose.push(this.terminal.onData(this.handleTermData.bind(this)));
        // A key press is the one signal only the user can produce: xterm fires this for keys it
        // handles, never for the answers it generates to the program's queries.
        this.toDispose.push(this.terminal.onKey(() => this.reportUserInput()));
        // Everything xterm itself classifies as user input - key presses, pastes, IME composition,
        // Terminal.input() - is reported and broadcast from one place. The seam is the only source
        // for the multi-input broadcast, so a protocol answer can never reach the other panes.
        this.userInputSeam?.uninstall();
        this.userInputSeam = installUserInputSeam(this.terminal, (data) => {
            this.reportUserInput();
            this.multiInputCallback?.(data);
        });
        if (!this.userInputSeam.installed) {
            console.warn("terminal user-input seam unavailable: multi-input will not broadcast");
        }
        this.toDispose.push(
            this.terminal.onSelectionChange(
                debounce(50, () => {
                    if (!globalStore.get(copyOnSelectAtom)) {
                        return;
                    }
                    // Don't copy-on-select when the search bar has focus — navigating
                    // search results changes the terminal selection programmatically.
                    const active = document.activeElement;
                    if (active != null && active.closest(".search-container") != null) {
                        return;
                    }
                    let selectedText = this.terminal.getSelection();
                    if (selectedText.length > 0) {
                        if (globalStore.get(trimTrailingWhitespaceAtom) !== false) {
                            selectedText = trimTerminalSelection(selectedText);
                        }
                        navigator.clipboard.writeText(selectedText);
                    }
                })
            )
        );
        if (this.onSearchResultsDidChange != null) {
            this.toDispose.push(this.searchAddon.onDidChangeResults(this.onSearchResultsDidChange.bind(this)));
        }

        this.mainFileSubject = getFileSubject(this.getZoneId(), TermFileName);
        this.mainFileSubscription = this.mainFileSubject.subscribe(this.handleNewFileSubjectData.bind(this));
        this.visualAnchorEventUnsub = waveEventSubscribeSingle({
            eventType: "commandjournal:anchor",
            scope: WOS.makeORef("block", this.blockId),
            handler: (event) => this.confirmVisualAnchor(event.data as Record<string, unknown>),
        });
        try {
            const anchorHistory = await RpcApi.EventReadHistoryCommand(TabRpcClient, {
                event: "commandjournal:anchor",
                scope: WOS.makeORef("block", this.blockId),
                maxitems: 64,
            });

            for (const event of anchorHistory ?? []) {
                this.confirmVisualAnchor(event?.data as Record<string, unknown>);
            }
        } catch (e) {
            console.debug("[termwrap] visual anchor history unavailable", this.blockId, e);
        }

        try {
            const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
            });
            let shellState: ShellIntegrationStatus = null;

            shellState = this.applyRestoredShellIntegration(rtInfo);
            globalStore.set(this.shellIntegrationStatusAtom, shellState || null);

            const lastCmd = rtInfo ? rtInfo["shell:lastcmd"] : null;
            const isCC = shellState === "running-command" && isClaudeCodeCommand(lastCmd);
            globalStore.set(this.lastCommandAtom, lastCmd || null);
            globalStore.set(this.claudeCodeActiveAtom, isCC);
        } catch (e) {
            console.log("Error loading runtime info:", e);
        }

        try {
            await this.loadInitialTerminalData(ingressGeneration);
            if (!this.isIngressCurrent(ingressGeneration)) {
                return;
            }
            this.loaded = true;
            this.ingressState = "draining";
            // The file metadata returned by fetchWaveFile establishes the
            // absolute ptyOffset. Catch up from that offset; never infer
            // overlap from an append payload's byte length.
            await this.catchUpTerminalFile(ingressGeneration);
            await this.drainHeldData(ingressGeneration);
            // A file append can be delivered to the subject after the
            // snapshot request completed. One final authoritative read closes
            // that handoff without treating D/prompt or timing as a fence.
            await this.catchUpTerminalFile(ingressGeneration);
            await this.drainHeldData(ingressGeneration);
            if (this.isIngressCurrent(ingressGeneration)) {
                this.ingressState = "live";
            }
        } finally {
            if (this.isIngressCurrent(ingressGeneration)) {
                this.loaded = true;
                if (this.ingressState === "loading") {
                    this.ingressState = "live";
                }
            }
        }
        this.runProcessIdleTimeout();
    }

    dispose() {
        if (this.disposedOnce) {
            return;
        }
        this.disposedOnce = true;
        // TermWrap-owned long-lived resources are torn down here, symmetrically with their creation:
        // the file subject subscription, the subject reference and the idle cache loop.
        this.mainFileSubscription?.unsubscribe();
        this.mainFileSubscription = null;
        this.stopProcessIdleLoop();
        this.ingressGeneration++;
        this.ingressState = "disposed";
        this.heldData = [];
        this.visualAnchorEventUnsub?.();
        this.visualAnchorEventUnsub = null;
        this.visualAnchorRegistry.invalidate();
        this.notifyCommandAnchorSubscribers();
        this.commandAnchorSubscribers.clear();
        this.promptMarkers.forEach((marker) => {
            try {
                marker.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        this.promptMarkers = [];
        this.userInputSeam?.uninstall();
        this.userInputSeam = null;
        this.webglContextLossDisposable?.dispose();
        this.webglContextLossDisposable = null;
        this.terminal.dispose();
        this.toDispose.forEach((d) => {
            try {
                d.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        if (this.mainFileSubject != null) {
            this.mainFileSubject.release();
            this.mainFileSubject = null;
        }
    }

    handleTermData(data: string) {
        if (!this.loaded) {
            return;
        }

        // Every data event goes to this terminal's own controller, including the answers xterm
        // generates for the program's queries. What may be broadcast as multi-input is decided by the
        // user-input seam instead, which reads xterm's own classification of each emission.
        this.sendDataHandler?.(data);
    }

    /**
     * Notifies the owner once, the first time the user sends input to this terminal.
     *
     * Deliberately *not* called from `handleTermData`: the terminal's data channel also carries the
     * answers xterm generates for the program's queries (device attributes, cursor position, colours),
     * so a shell that merely starts would look like a user typing. Only real user input reports here -
     * a key press, a paste, files dropped on the terminal, or text committed by an input method - and
     * every one of those reaches this method from the user-input seam or from `onKey`.
     */
    private reportUserInput() {
        if (this.userInputReported) {
            return;
        }
        this.userInputReported = true;
        this.userInputHandler?.();
    }

    registerVisualAnchor(data: Record<string, unknown>) {        const nonce = typeof data?.nonce === "string" ? data.nonce : "";
        const epoch = typeof data?.epoch === "string" ? data.epoch : "";
        const commandId = typeof data?.id === "string" && data.id !== "" ? data.id : undefined;
        const phase = typeof data?.phase === "string" ? data.phase : "";
        const sequence = typeof data?.seq === "number" ? data.seq : 0;
        if (!nonce || !epoch || !phase || sequence <= 0 || phase !== "start") return;
        const marker = this.terminal.registerMarker(0);
        if (marker == null) return;
        // Which producer this mark belongs to is decided by the identity the mark claims, exactly
        // as the Go anchor registry decides it: a mark that names a hosted process and runspace is
        // the hosted runtime's mark, and every other mark belongs to the terminal integration.
        const mark = authorityForMark(
            typeof data.hostid === "string" ? data.hostid : undefined,
            typeof data.runspaceid === "string" ? data.runspaceid : undefined
        );
        // A parked frame keeps the marker its cue points at: the registry holds one parked anchor per
        // nonce, so a repeat of a nonce that is already parked has nothing of its own to park. This
        // frame's marker would replace the cue that still owns the first one, leaving that marker
        // alive with nothing referencing it.
        const alreadyParked = this.visualAnchorRegistry.isQuarantined(nonce);
        const accepted = this.visualAnchorRegistry.observeAnchor({
            blockId: this.blockId,
            authority: mark.authority,
            sessionEpoch: epoch,
            hookSequence: sequence,
            commandId,
            anchorNonce: nonce,
            hostId: mark.hostId,
            runspaceId: mark.runspaceId,
            handle: { dispose: () => marker.dispose() },
        });
        if (!accepted) {
            // A valid anchor of a session that is not trusted yet is parked by the registry, not
            // rejected. Keep its marker and its (silent) cue: the cue carries no authority by
            // itself - the snapshot only exposes a cue whose registry binding exists - so the
            // trusted transition can announce it later with the frame's own line.
            if (alreadyParked || !this.visualAnchorRegistry.isQuarantined(nonce)) {
                marker.dispose();
                return;
            }
            // A parked anchor is bounded, not permanent: the registry drops the oldest parked
            // anchors past its capacity and disposes their handle. The cue must follow its marker
            // out, exactly as an accepted one does, or the map grows with every evicted frame.
            this.registerVisualAnchorCue(nonce, marker);
            return;
        }
        this.registerVisualAnchorCue(nonce, marker);
        this.registerConfirmedVisualCue(nonce);
    }

    /**
     * Records the cue for one anchor frame and ties its lifetime to the frame's marker, so the
     * cue is released exactly when the marker dies - whether the integration disposed it, the
     * registry evicted the parked anchor, or a trusted clear invalidated it.
     */
    private registerVisualAnchorCue(nonce: string, marker: TermTypes.IMarker) {
        this.visualAnchorCues.set(nonce, { marker, generation: this.visualBufferGeneration });
        marker.onDispose(() => {
            // Only the cue that still owns this nonce may be released: a newer frame for the same
            // nonce has replaced it, and that newer cue is not ours to drop.
            const cue = this.visualAnchorCues.get(nonce);
            if (cue?.marker !== marker) return;
            cue.decoration?.dispose();
            cue.inlineRender?.dispose();
            cue.inlineDecoration?.dispose();
            this.visualAnchorCues.delete(nonce);
            this.visualAnchorRegistry.remove(nonce);
            this.notifyCommandAnchorSubscribers();
        });
    }

    private registerConfirmedVisualCue(nonce: string) {
        const cue = this.visualAnchorCues.get(nonce);
        if (cue == null || !isKnownAuthority(this.visualAnchorRegistry.get(nonce)?.authority) || cue.marker.isDisposed) return;
        if (cue.inlineDecoration == null) this.renderSelectedCommandCue(nonce);
        if (!cue.announced) {
            cue.announced = true;
            this.notifyCommandAnchorSubscribers();
        }
        if (cue.decoration != null) return;
        try {
            const decoration = this.terminal.registerDecoration({
                marker: cue.marker,
                overviewRulerOptions: { color: "#58C142", position: "center" },
            });
            if (decoration != null) cue.decoration = decoration;
        } catch (_) {
            // Decoration support is optional; confirmation and terminal rendering remain independent.
        }
    }

    private confirmVisualAnchor(data: Record<string, unknown>) {
        const anchorNonce = typeof data?.anchorNonce === "string" ? data.anchorNonce : "";
        const blockId = typeof data?.blockId === "string" ? data.blockId : "";
        const sessionEpoch = typeof data?.sessionEpoch === "string" ? data.sessionEpoch : "";
        const commandId = typeof data?.commandId === "string" ? data.commandId : "";
        const hostId = typeof data?.hostId === "string" ? data.hostId : "";
        const runspaceId = typeof data?.runspaceId === "string" ? data.runspaceId : "";
        const mode = typeof data?.mode === "string" ? data.mode : "";
        const authority = typeof data?.authority === "string" ? data.authority : "";
        const hookSequence = typeof data?.hookSequence === "number" ? data.hookSequence : 0;
        // A confirmation names the authority that owns the command and the command identity. The
        // hosted authority must also name the process and runspace it belongs to; the terminal
        // authority must not carry that identity at all. Anything else fails closed.
        // Identity is blockId + sessionEpoch + hookSequence + commandId + anchorNonce + authority.
        // `mode` describes the execution lifecycle and is never used to decide identity: the native
        // terminal authority legitimately carries no mode, and requiring one silently dropped every
        // real confirmation before the registry could pair it with its anchor.
        if (!anchorNonce || !blockId || !sessionEpoch || !commandId || !isKnownAuthority(authority) || hookSequence <= 0) return;
        if (authority === "hosted-sidechannel" && (hostId === "" || runspaceId === "")) return;
        // A trusted confirmation naming a new session epoch means the pane's shell session was
        // replaced: drop the old session's lock and stale anchors before accepting the new identity.
        this.visualAnchorRegistry.resetSessionForEpoch(sessionEpoch);
        this.visualAnchorRegistry.confirm({
            blockId,
            authority,
            sessionEpoch,
            hookSequence,
            commandId,
            anchorNonce,
            hostId: authority === "hosted-sidechannel" ? hostId : undefined,
            runspaceId: authority === "hosted-sidechannel" ? runspaceId : undefined,
            mode,
        });
        this.registerConfirmedVisualCue(anchorNonce);
    }

    addFocusListener(focusFn: () => void) {
        this.terminal.textarea.addEventListener("focus", focusFn);
    }

    handleNewFileSubjectData(msg: WSFileEventData) {
        // Defence in depth: the subscription is unsubscribed on dispose, and this keeps a callback
        // that was already delivered from touching a disposed pane.
        if (!this.isLive()) {
            return;
        }
        if (msg.fileop == "truncate") {
            void this.resetTerminalFileOrigin().catch((e) => {
                console.debug("terminal file-origin reset failed", this.blockId, e);
            });
            // The truncate event establishes a new file-origin boundary.
            // Product Clear does not call this branch, so it never resets the
            // cursor used for authoritative suffix reads.
            this.ptyOffset = 0;
            this.dataBytesProcessed = 0;
        } else if (msg.fileop == "append") {
            const decodedData = base64ToArray(msg.data64);
            if (this.loaded && this.ingressState === "live") {
                this.heldData.push({ sequence: ++this.heldDataSequence, data: decodedData });
                void this.drainHeldData(this.ingressGeneration).catch((e) => {
                    console.debug("terminal append catch-up failed", this.blockId, e);
                });
            } else {
                this.heldData.push({ sequence: ++this.heldDataSequence, data: decodedData });
            }
        } else {
            console.log("bad fileop for terminal", msg);
            return;
        }
    }

    /**
     * Runs one presentation operation after everything already enqueued, and keeps the lane alive
     * even when that operation fails: a rejected operation never poisons the queue, and later
     * operations still run in order.
     */
    runInPresentationLane<T>(operation: () => Promise<T>): Promise<T> {
        const tail = this.presentationTail ?? (this.presentationTail = Promise.resolve());
        const started = tail.then(operation, operation);
        this.presentationTail = started.then(
            () => undefined,
            () => undefined
        );
        return started;
    }

    /** Writes through xterm and resolves when the parser has consumed this chunk. */
    private writeParsed(data: string | Uint8Array): Promise<void> {
        return new Promise((resolve) => {
            this.terminal.write(data, () => resolve());
        });
    }


    /**
     * The single lifecycle predicate every asynchronous presentation operation re-checks after a
     * suspension point. A disposed pane is terminal: nothing may touch the terminal, its addons or
     * the ingress lifecycle state afterwards, and a durable backend commit that already happened is
     * never rolled back - only the renderer-side mutation is skipped.
     */
    private isLive(): boolean {
        return this.ingressState !== "disposed";
    }

    /** One sink for presentation-operation failures, so nothing becomes an unhandled rejection. */
    private reportPresentationError(operation: string, error: unknown) {
        console.debug("[termwrap] presentation operation failed", operation, this.blockId, error);
    }

    async doTerminalWrite(data: string | Uint8Array, setPtyOffset?: number): Promise<void> {
        if (!this.isLive()) {
            return;
        }
        return this.runInPresentationLane(async () => {
            if (!this.isLive()) {
                return;
            }
        if (isDev() && this.loaded) {
            const dataStr = data instanceof Uint8Array ? new TextDecoder().decode(data) : data;
            this.recentWrites.push({ idx: this.recentWritesCounter++, ts: Date.now(), data: dataStr });
            if (this.recentWrites.length > 50) {
                this.recentWrites.shift();
            }
        }
            // The lane slot ends when xterm has parsed these bytes: that callback is the real
            // completion boundary the rest of the presentation order is built on.
            await this.writeParsed(data);
            if (!this.isLive()) {
                // The pane went away while the callback was pending: the bytes are already parsed,
                // but no lifecycle or offset bookkeeping is touched afterwards.
                return;
            }
            if (setPtyOffset != null) {
                this.ptyOffset = setPtyOffset;
            } else {
                this.ptyOffset += data.length;
                this.dataBytesProcessed += data.length;
            }
            this.lastUpdated = Date.now();
        });
    }

    private isIngressCurrent(generation: number): boolean {
        return this.ingressGeneration === generation && this.ingressState !== "disposed";
    }

    private async drainHeldData(generation: number): Promise<void> {
        if (this.ingressDrainPromise != null) {
            return this.ingressDrainPromise;
        }
        const drainPromise = drainTerminalIngress(
            this.heldData,
            () => this.catchUpTerminalFile(generation),
            async (data, coveredAnchorNonces) => {
                for (const frame of extractVisualAnchorFrames(data)) {
                    if (!this.isIngressCurrent(generation)) {
                        return;
                    }
                    const nonces = extractVisualAnchorNonces(frame);
                    const covered = [...nonces].some((nonce) => coveredAnchorNonces.has(nonce));
                    if (covered) {
                        continue;
                    }
                    await this.doTerminalWrite(frame, null);
                    for (const nonce of nonces) {
                        coveredAnchorNonces.add(nonce);
                    }
                }
            },
            () => this.isIngressCurrent(generation)
        );
        this.ingressDrainPromise = drainPromise;
        try {
            await drainPromise;
        } finally {
            if (this.ingressDrainPromise === drainPromise) {
                this.ingressDrainPromise = null;
            }
        }
    }

    async loadInitialTerminalData(generation: number = this.ingressGeneration): Promise<void> {
        const startTs = Date.now();
        const zoneId = this.getZoneId();
        const { data: cacheData, fileInfo: cacheFile } = await fetchWaveFile(zoneId, TermCacheFileName);
        if (!this.isIngressCurrent(generation)) {
            return;
        }
        let ptyOffset = 0;
        if (cacheFile != null) {
            ptyOffset = cacheFile.meta["ptyoffset"] ?? 0;
            if (cacheData.byteLength > 0) {
                const curTermSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
                const fileTermSize: TermSize = cacheFile.meta["termsize"];
                let didResize = false;
                if (
                    fileTermSize != null &&
                    (fileTermSize.rows != curTermSize.rows || fileTermSize.cols != curTermSize.cols)
                ) {
                    console.log("terminal restore size mismatch, temp resize", fileTermSize, curTermSize);
                    await this.runInPresentationLane(async () => {
                        if (!this.isLive()) {
                            return;
                        }
                        this.terminal.resize(fileTermSize.cols, fileTermSize.rows);
                    });
                    didResize = true;
                }
                await this.doTerminalWrite(cacheData, ptyOffset);
                if (didResize) {
                    await this.runInPresentationLane(async () => {
                        if (!this.isLive()) {
                            return;
                        }
                        this.terminal.resize(curTermSize.cols, curTermSize.rows);
                    });
                }
            }
        }
        const { data: mainData, fileInfo: mainFile } = await fetchWaveFile(zoneId, TermFileName, ptyOffset);
        if (!this.isIngressCurrent(generation)) {
            return;
        }
        console.log(
            `terminal loaded cachefile:${cacheData?.byteLength ?? 0} main:${mainData?.byteLength ?? 0} bytes, ${Date.now() - startTs}ms`
        );
        if (mainFile != null) {
            await this.doTerminalWrite(mainData, mainFile.size);
        }
    }

    /** Read and render only bytes after the current authoritative file offset. */
    private async catchUpTerminalFile(generation: number): Promise<Uint8Array> {
        if (!this.isIngressCurrent(generation)) {
            return new Uint8Array();
        }
        const { data, fileInfo } = await fetchWaveFile(this.getZoneId(), TermFileName, this.ptyOffset);
        if (!this.isIngressCurrent(generation) || fileInfo == null) {
            return new Uint8Array();
        }
        if (fileInfo.size < this.ptyOffset) {
            // A reset/rotation without an offset mapping cannot be safely
            // attributed to this terminal instance. Leave the stream intact
            // and fail closed rather than replaying event payload guesses.
            console.debug("terminal file moved backwards; skipping unsafe catch-up", this.blockId, {
                ptyOffset: this.ptyOffset,
                fileSize: fileInfo.size,
            });
            return new Uint8Array();
        }
        if (data != null && data.byteLength > 0) {
            await this.doTerminalWrite(data, fileInfo.size);
            return data;
        } else {
            this.ptyOffset = fileInfo.size;
            return new Uint8Array();
        }
    }

    async resyncController(reason: string) {
        dlog("resync controller", this.blockId, reason);
        const rtOpts: RuntimeOpts = { termsize: { rows: this.terminal.rows, cols: this.terminal.cols } };
        try {
            await RpcApi.ControllerResyncCommand(TabRpcClient, {
                tabid: this.tabId,
                blockid: this.blockId,
                rtopts: rtOpts,
            });
        } catch (e) {
            console.log(`error controller resync (${reason})`, this.blockId, e);
        }
    }

    handleResize() {
        if (!this.isLive()) {
            return;
        }
        // A resize is a presentation mutation like any other: it takes a lane slot, so it cannot
        // reflow the buffer in the middle of a clear transaction.
        void this.runInPresentationLane(async () => {
            if (!this.isLive()) {
                return;
            }
            this.handleResizeInLane();
        }).catch((e) => this.reportPresentationError("resize", e));
    }

    /** The reflow itself; callers inside the lane use this directly. */
    private handleResizeInLane() {
        const oldRows = this.terminal.rows;
        const oldCols = this.terminal.cols;
        this.fitAddon.fit();
        if (oldRows !== this.terminal.rows || oldCols !== this.terminal.cols) {
            const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
            console.log(
                "[termwrap] resize",
                `${oldRows}x${oldCols}`,
                "->",
                `${this.terminal.rows}x${this.terminal.cols}`
            );
            RpcApi.ControllerInputCommand(TabRpcClient, { blockid: this.blockId, termsize: termSize });
        }
        dlog("resize", `${this.terminal.rows}x${this.terminal.cols}`, `${oldRows}x${oldCols}`, this.hasResized);
        if (!this.hasResized) {
            this.hasResized = true;
            this.resyncController("initial resize");
        }
    }

    processAndCacheData() {
        // Second line of defence: the loop is cancelled on dispose, and this guard keeps a callback
        // that was already queued from touching the terminal, its addons or the cache.
        if (!this.isLive()) {
            return;
        }
        if (this.dataBytesProcessed < MinDataProcessedForCache) {
            return;
        }
        const serializedOutput = this.serializeAddon.serialize();
        const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
        console.log("idle timeout term", this.dataBytesProcessed, serializedOutput.length, termSize);
        fireAndForget(() =>
            services.BlockService.SaveTerminalState(this.blockId, serializedOutput, "full", this.ptyOffset, termSize)
        );
        this.dataBytesProcessed = 0;
    }

    /** Starts (or restarts) the 5s idle cache loop. Idempotent while one is already pending. */
    runProcessIdleTimeout() {
        if (!this.isLive() || this.idleTimeoutHandle != null || this.idleCallbackHandle != null) {
            return;
        }
        this.idleTimeoutHandle = setTimeout(() => {
            this.idleTimeoutHandle = null;
            if (!this.isLive()) {
                return;
            }
            this.idleCallbackHandle = window.requestIdleCallback(() => {
                this.idleCallbackHandle = null;
                if (!this.isLive()) {
                    return;
                }
                this.processAndCacheData();
                if (!this.isLive()) {
                    return;
                }
                this.runProcessIdleTimeout();
            });
        }, 5000);
    }

    /** Cancels both halves of the idle cache loop; dispose calls this so no timer survives it. */
    private stopProcessIdleLoop() {
        if (this.idleTimeoutHandle != null) {
            clearTimeout(this.idleTimeoutHandle);
            this.idleTimeoutHandle = null;
        }
        if (this.idleCallbackHandle != null) {
            window.cancelIdleCallback?.(this.idleCallbackHandle);
            this.idleCallbackHandle = null;
        }
    }

    async pasteHandler(e?: ClipboardEvent): Promise<void> {
        this.pasteActive = true;
        e?.preventDefault();
        e?.stopPropagation();

        try {
            const clipboardData = await extractAllClipboardData(e);
            // A paste may resume long after it started (clipboard read, blob extraction, temp file,
            // the 150ms gap between images): every resumption re-checks the lifecycle before it
            // touches the terminal again.
            if (!this.isLive()) {
                return;
            }
            let firstImage = true;
            for (const data of clipboardData) {
                if (data.image && SupportsImageInput) {
                    if (!firstImage) {
                        await new Promise((r) => setTimeout(r, 150));
                        if (!this.isLive()) {
                            return;
                        }
                    }
                    const tempPath = await createTempFileFromBlob(data.image);
                    if (!this.isLive()) {
                        return;
                    }
                    this.terminal.paste(tempPath + " ");
                    firstImage = false;
                }
                if (data.text) {
                    if (!this.isLive()) {
                        return;
                    }
                    this.terminal.paste(data.text);
                }
            }
        } catch (err) {
            console.error("Paste error:", err);
        } finally {
            setTimeout(() => {
                this.pasteActive = false;
            }, 30);
        }
    }

    getScrollbackContent(): string {
        if (!this.terminal) {
            return "";
        }
        const buffer = this.terminal.buffer.active;
        const lines = bufferLinesToText(buffer, 0, buffer.length);
        return lines.join("\n");
    }
}