// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ownership of TermWrap's long-lived resources.
 *
 * A guard in a callback is only the second line of defence: everything TermWrap creates or holds
 * for the future (the block-file subject subscription and its reference, the idle cache loop's
 * timer and idle callback) has to be released symmetrically in dispose(). These tests drive the
 * real subject store and real timers, so a leak shows up as an observable refCount or callback.
 */

import { Terminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFileSubject, publishFileSubject } from "@/app/store/wps";
import { TermWrap } from "./termwrap";

const ZONE = "zone-ownership-test";
const FILE = "term";

function makeTerminal(): Terminal {
    return new Terminal({ allowProposedApi: true, cols: 20, rows: 6, scrollback: 20 });
}

function makeWrap(term: Terminal) {
    const wrap: TermWrap = Object.create(TermWrap.prototype);
    const internals = wrap as unknown as Record<string, unknown>;
    internals.terminal = term;
    internals.ingressState = "live";
    internals.ingressGeneration = 3;
    internals.heldData = [];
    internals.ptyOffset = 100;
    internals.dataBytesProcessed = 1_000_000;
    internals.visualBufferGeneration = 1;
    internals.promptMarkers = [];
    internals.visualAnchorCues = new Map();
    internals.visualAnchorRegistry = { invalidate: vi.fn() };
    internals.commandAnchorSubscribers = new Set();
    internals.toDispose = [];
    internals.loaded = true;
    internals.presentationTail = Promise.resolve();
    internals.serializeAddon = { serialize: vi.fn(() => "serialized") };
    internals.getZoneId = () => ZONE;
    internals.mainFileSubject = null;
    internals.mainFileSubscription = null;
    internals.disposedOnce = false;
    internals.idleTimeoutHandle = null;
    internals.idleCallbackHandle = null;
    internals.webglContextLossDisposable = null;
    internals.userInputSeam = null;
    internals.visualAnchorEventUnsub = null;
    return { wrap, internals };
}

describe("TermWrap resource ownership", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        (globalThis as unknown as Record<string, unknown>).window ??= {
            setTimeout,
            clearTimeout,
            requestIdleCallback: (cb: () => void) => setTimeout(cb, 0) as unknown as number,
            cancelIdleCallback: (handle: number) => clearTimeout(handle),
        };
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("releases the file subject reference exactly once and unsubscribes", () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);

        const subject = getFileSubject(ZONE, FILE);
        internals.mainFileSubject = subject;
        const subscriber = vi.fn((data: unknown) => void data);
        internals.mainFileSubscription = subject.subscribe(subscriber);
        expect(subject.refCount).toBe(1);

        publishFileSubject(ZONE, FILE, { zoneid: ZONE, filename: FILE } as never);
        expect(subscriber).toHaveBeenCalledTimes(1);

        wrap.dispose();
        expect(subject.refCount).toBe(0);
        // The subscription is gone: a later event no longer reaches the disposed pane.
        publishFileSubject(ZONE, FILE, { zoneid: ZONE, filename: FILE } as never);
        expect(subscriber).toHaveBeenCalledTimes(1);
        expect(internals.heldData).toEqual([]);
        expect(internals.ptyOffset).toBe(100);
        expect(internals.ingressState).toBe("disposed");

        // The subject was completed and dropped, so asking again yields a fresh one.
        const fresh = getFileSubject(ZONE, FILE);
        expect(fresh).not.toBe(subject);
        expect(fresh.refCount).toBe(1);
        fresh.release();
        term.dispose();
    });

    it("does not leak the reference count when events are published repeatedly", () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        const subject = getFileSubject(ZONE, FILE);
        internals.mainFileSubject = subject;
        internals.mainFileSubscription = subject.subscribe(() => {});

        for (let i = 0; i < 25; i++) {
            publishFileSubject(ZONE, FILE, { zoneid: ZONE, filename: FILE } as never);
        }
        // Publishing is a delivery, not ownership: the count is unchanged by 25 events.
        expect(subject.refCount).toBe(1);

        wrap.dispose();
        expect(subject.refCount).toBe(0);
        term.dispose();
    });

    it("keeps a subject alive while another owner still holds it", () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        const first = getFileSubject(ZONE, FILE);
        const second = getFileSubject(ZONE, FILE);
        expect(second.refCount).toBe(2);
        internals.mainFileSubject = first;
        internals.mainFileSubscription = first.subscribe(() => {});

        wrap.dispose();

        // One owner left: the subject is still usable for it.
        expect(second.refCount).toBe(1);
        const stillThere = vi.fn();
        const sub = second.subscribe(stillThere);
        publishFileSubject(ZONE, FILE, { zoneid: ZONE, filename: FILE } as never);
        expect(stillThere).toHaveBeenCalledTimes(1);
        sub.unsubscribe();
        second.release();
        term.dispose();
    });

    it("cancels the idle cache loop on dispose and never serializes afterwards", () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        const serialize = internals.serializeAddon as { serialize: ReturnType<typeof vi.fn> };

        wrap.runProcessIdleTimeout();
        expect(internals.idleTimeoutHandle).not.toBeNull();

        wrap.dispose();
        expect(internals.idleTimeoutHandle).toBeNull();
        vi.advanceTimersByTime(20000);

        expect(serialize.serialize).not.toHaveBeenCalled();
        expect(internals.idleTimeoutHandle).toBeNull();
        expect(internals.idleCallbackHandle).toBeNull();
        term.dispose();
    });

    it("does not touch the terminal when dispose happens between the timer and the idle callback", () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        const serialize = internals.serializeAddon as { serialize: ReturnType<typeof vi.fn> };

        wrap.runProcessIdleTimeout();
        vi.advanceTimersByTime(5000); // the timeout fired; the idle callback is queued
        wrap.dispose();
        vi.advanceTimersByTime(100);
        vi.runAllTimers();

        expect(serialize.serialize).not.toHaveBeenCalled();
        term.dispose();
    });

    it("keeps scheduling the 5s cache loop while the pane is live", () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        // The body is stubbed here: this test is about the loop's lifecycle, not the cache payload.
        const process = vi.fn();
        internals.processAndCacheData = process;

        wrap.runProcessIdleTimeout();
        const firstHandle = internals.idleTimeoutHandle;
        wrap.runProcessIdleTimeout(); // idempotent while one round is pending
        expect(internals.idleTimeoutHandle).toBe(firstHandle);

        // The 5s timeout fires and the idle callback (a 0ms stand-in here) runs; the loop then
        // schedules the next round, so only a bounded amount of time is advanced.
        vi.advanceTimersByTime(5000);
        vi.advanceTimersByTime(1);

        expect(process).toHaveBeenCalledTimes(1);
        // And it scheduled the next round while the pane is still alive.
        expect(internals.idleTimeoutHandle).not.toBeNull();
        wrap.dispose();
        term.dispose();
    });

    it("is idempotent: a second dispose does not release or unsubscribe twice", () => {
        const term = makeTerminal();
        const { wrap, internals } = makeWrap(term);
        const subject = getFileSubject(ZONE, FILE);
        internals.mainFileSubject = subject;
        const unsubscribe = vi.fn();
        internals.mainFileSubscription = { unsubscribe };

        wrap.dispose();
        wrap.dispose();

        expect(subject.refCount).toBe(0);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(internals.mainFileSubject).toBeNull();
        term.dispose();
    });
});
