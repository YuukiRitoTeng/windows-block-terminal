import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const termwrapSource = readFileSync(new URL("./termwrap.ts", import.meta.url), "utf8");

describe("confirmed command cue", () => {
    it("registers only confirmed anchors as green overview-ruler decorations", () => {
        const cueRegistration = termwrapSource.indexOf("private registerConfirmedVisualCue");
        expect(cueRegistration).toBeGreaterThanOrEqual(0);

        const cueBody = termwrapSource.slice(
            cueRegistration,
            termwrapSource.indexOf("private confirmVisualAnchor", cueRegistration)
        );
        expect(cueBody).toContain("this.visualAnchorRegistry.get(nonce)");
        expect(cueBody).toContain("this.terminal.registerDecoration");
        expect(cueBody).toContain('color: "#58C142"');
        expect(cueBody).toContain('position: "center"');
    });

    it("attempts cue registration after either binding order and disposes it with its marker", () => {
        const registerAnchor = termwrapSource.indexOf("registerVisualAnchor(data:");
        const confirmAnchor = termwrapSource.indexOf("private confirmVisualAnchor");
        const registerBody = termwrapSource.slice(registerAnchor, confirmAnchor);
        const confirmBody = termwrapSource.slice(
            confirmAnchor,
            termwrapSource.indexOf("addFocusListener", confirmAnchor)
        );

        expect(registerBody.indexOf("this.registerConfirmedVisualCue(nonce)")).toBeGreaterThanOrEqual(0);
        expect(confirmBody.indexOf("this.registerConfirmedVisualCue(anchorNonce)")).toBeGreaterThanOrEqual(0);
        expect(registerBody).toContain("decoration?.dispose()");
    });
});
