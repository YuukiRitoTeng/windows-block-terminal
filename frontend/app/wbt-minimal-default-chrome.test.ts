// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, test } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");

test("ships the AI button hidden while leaving the setting available for overrides", async () => {
    const settings = JSON.parse(await readSource("pkg/wconfig/defaultconfig/settings.json"));

    assert.strictEqual(settings["app:hideaibutton"], true);
});

test("terms acceptance keeps the AI panel closed", async () => {
    const source = await readSource("frontend/app/onboarding/onboarding.tsx");

    assert.notInclude(source, "WorkspaceLayoutModel.getInstance().setAIPanelVisible(true)");
    assert.include(source, "services.ClientService.AgreeTos()");
    assert.include(source, 'setPageName(telemetryEnabled ? "features" : "notelemetrystar")');
});

test("feature tour routes durable, magnify, and files as three consistent steps", async () => {
    const features = await readSource("frontend/app/onboarding/onboarding-features.tsx");
    const durable = await readSource("frontend/app/onboarding/onboarding-durable.tsx");

    assert.include(features, 'type FeaturePageName = "durable" | "magnify" | "files";');
    assert.include(features, 'useState<FeaturePageName>("durable")');
    assert.include(features, 'if (currentPage === "durable") {\n            setCurrentPage("magnify")');
    assert.include(features, '} else if (currentPage === "magnify") {\n            setCurrentPage("files")');
    assert.notInclude(features, 'setCurrentPage("waveai")');
    assert.notInclude(features, 'case "waveai":');
    assert.include(features, "export const WaveAIPage");
    assert.include(durable, "<OnboardingFooter currentStep={1} totalSteps={3}");
    assert.include(features, "<OnboardingFooter currentStep={2} totalSteps={3}");
    assert.include(features, "<OnboardingFooter currentStep={3} totalSteps={3}");
});
