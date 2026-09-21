import { transform } from "esbuild";
import { resolve } from "path";
import { UserConfig, defineConfig, mergeConfig } from "vitest/config";
import electronViteConfig from "./electron.vite.config";

/**
 * Makes the vendored xterm sources importable by tests.
 *
 * The terminal's own input path lives in `node_modules/@xterm/xterm/src` (the same code the bundled
 * `lib/xterm.mjs` is built from, but with the class names still visible). Tests that must exercise
 * that path for real - the deferred `compositionend` emission, for instance - import it directly,
 * which needs two things this project's build does not otherwise do: TypeScript parameter decorators
 * (the React transform cannot parse them) and xterm's internal `browser/*` / `common/*` specifiers.
 * Both are handled only for files inside that package, so nothing else is affected.
 */
function xtermSourcesForTests() {
    const root = resolve(process.cwd(), "node_modules/@xterm/xterm/src").replace(/\\/g, "/");
    const isXtermSource = (id: string) => id.replace(/\\/g, "/").startsWith(`${root}/`);
    return {
        name: "xterm-sources-for-tests",
        enforce: "pre" as const,
        resolveId(source: string, importer?: string) {
            if (importer == null || !isXtermSource(importer)) {
                return null;
            }
            if (source.startsWith("browser/") || source.startsWith("common/")) {
                return resolve(root, `${source}.ts`);
            }
            return null;
        },
        async transform(code: string, id: string) {
            if (!isXtermSource(id)) {
                return null;
            }
            const result = await transform(code, {
                loader: "ts",
                format: "esm",
                target: "es2020",
                tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
            });
            return { code: result.code };
        },
    };
}

export default mergeConfig(
    electronViteConfig.renderer as UserConfig,
    defineConfig({
        plugins: [xtermSourcesForTests()],
        test: {
            reporters: ["verbose", "junit"],
            outputFile: {
                junit: "test-results.xml",
            },
            coverage: {
                provider: "istanbul",
                reporter: ["lcov"],
                reportsDirectory: "./coverage",
            },
            typecheck: {
                tsconfig: "tsconfig.json",
            },
        },
    })
);
