// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, test } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");

test("TabContent gives the surviving TileLayout a definite height contract", async () => {
    const tabContent = await readSource("frontend/app/tab/tabcontent.tsx");

    assert.match(
        tabContent,
        /className=\{`flex flex-row flex-grow h-full min-h-0 w-full items-center justify-center overflow-hidden relative/
    );
    assert.include(tabContent, "<TileLayout");
    assert.include(tabContent, 'renderContent: ContentRenderer');
    assert.include(tabContent, 'return <Block key={nodeModel.blockId} nodeModel={nodeModel} preview={false} />;');
});
