import * as css from "css-tree";
import { readFileSync } from "node:fs";
import * as sass from "sass";
import { describe, expect, it } from "vitest";

// Compile the actual terminal stylesheet. These checks cover authored CSS, not
// computed layout, hit testing or native GUI acceptance.
const output = sass.compileString(readFileSync(new URL("./term.scss", import.meta.url), "utf8"), {
    loadPaths: ["frontend"],
}).css;
const ast = css.parse(output);
function properties(selector: string) {
    const result: Record<string, string> = {};
    css.walk(ast, {
        visit: "Rule",
        enter(node: any) {
            const selectors = css.generate(node.prelude).split(",");
            if (!selectors.some((value: string) => value.trim() === selector)) return;
            node.block.children.forEach((decl: any) => {
                if (decl.type === "Declaration") result[decl.property] = css.generate(decl.value);
            });
        },
    });
    return result;
}
describe("terminal-first fixed control presentation", () => {
    it("reserves a pane-local gutter and fixes controls to three distinct locations", () => {
        expect(properties(".terminal-action-gutter")["flex"]).toBe("0 0 40px");
        expect(properties(".term-content-frame .terminal-clear-action").top).toBe("8px");
        expect(properties(".term-content-frame .terminal-clear-action").right).toBe("6px");
        expect(properties(".term-content-frame .command-navigation-rail .command-navigation-rail-controls").top).toBe("50%");
        expect(properties(".term-content-frame .command-navigation-rail .command-navigation-rail-copy").bottom).toBe("8px");
    });
    it("keeps controls interactive with explicit disabled and focus styling", () => {
        expect(properties(".term-content-frame .terminal-action-gutter button")["pointer-events"]).toBe("auto");
        expect(properties(".term-content-frame .terminal-action-gutter button:focus-visible").outline).toBeTruthy();
        expect(properties(".term-content-frame .terminal-action-gutter button:disabled").opacity).toBe("0.4");
    });
});
