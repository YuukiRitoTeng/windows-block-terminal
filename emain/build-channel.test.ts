// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The DEV badge's input comes from the packaged manifest, so the thing that must not regress is the
 * segregation between the two packaging configs: only the test config may inject a build channel.
 * A release build made with electron-builder.config.cjs must carry no channel, because that is what
 * keeps the badge off a release.
 */
const requireFn = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const loadConfig = (name: string) => requireFn(path.join(repoRoot, name));

describe("build channel segregation", () => {
    it("injects the test channel only in the test packaging config", () => {
        const base = loadConfig("electron-builder.config.cjs");
        const test = loadConfig("electron-builder.test.config.cjs");
        expect(base.extraMetadata?.buildChannel).toBeUndefined();
        expect(test.extraMetadata?.buildChannel).toBe("test");
    });

    it("keeps every other packaging setting identical between the two configs", () => {
        // The test config must only add the channel; everything else has to come from the base so a
        // test build cannot silently diverge from what a release build would produce.
        const base = loadConfig("electron-builder.config.cjs");
        const test = loadConfig("electron-builder.test.config.cjs");
        const strip = (cfg: Record<string, unknown>) => {
            const { extraMetadata, ...rest } = cfg;
            return rest;
        };
        expect(strip(test)).toEqual(strip(base));
    });

    it("leaves the release config free of any channel-like metadata", () => {
        const base = loadConfig("electron-builder.config.cjs");
        expect(base.extraMetadata ?? {}).toEqual({});
    });
});
