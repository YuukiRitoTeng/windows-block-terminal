import { readFile } from "fs/promises";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";

const readSource = (path: string) => readFile(join(process.cwd(), path), "utf-8");

/**
 * Which local PowerShell a pane gets.
 *
 * The default is the native shell: pwsh with the in-band integration, so the
 * pane shows the shell's own prompt and the journal is fed by terminal-osc
 * authority. The bundled hosted runtime stays available as an explicit opt-in
 * (WBT_HOSTED_PWSH=1) and its sidechannel authority is unchanged - but the app
 * must never opt in on the user's behalf.
 */
describe("local PowerShell default path", () => {
    let wavesrv: string;
    let shellexec: string;
    let hostedRuntime: string;

    beforeAll(async () => {
        wavesrv = await readSource("emain/emain-wavesrv.ts");
        shellexec = await readSource("pkg/shellexec/shellexec.go");
        hostedRuntime = await readSource("pkg/shellexec/hostedruntime.go");
    });

    it("does not enable the hosted runtime by itself", () => {
        // The comment may name the variable; the code must never set it.
        expect(wavesrv).not.toMatch(/envCopy\.WBT_HOSTED_PWSH\s*=/);
        expect(wavesrv).not.toMatch(/^\s*WBT_HOSTED_PWSH\s*=\s*["']1["']/m);
    });

    it("still provides the bundled executable for an explicit opt-in", () => {
        expect(wavesrv).toContain("WBT_HOSTED_PWSH_EXE");
        expect(wavesrv).toMatch(/if \(!envCopy\.WBT_HOSTED_PWSH_EXE && existsSync\(hostedPowerShell\)\)/);
        expect(wavesrv).toContain('"hostedpwsh"');
    });

    it("keeps the hosted runtime behind the environment variable", () => {
        expect(hostedRuntime).toContain("func hostedRuntimeEnabled() bool");
        expect(hostedRuntime).toContain("WBT_HOSTED_PWSH");
        expect(shellexec).toContain('useHostedPowerShell := cmdStr == "" && shellType == shellutil.ShellType_pwsh && hostedRuntimeEnabled()');
    });

    it("runs the native pwsh with the shell integration otherwise", () => {
        expect(shellexec).toMatch(/"-NoExit", "-File", shellutil\.GetLocalWavePowershellEnv\(\)/);
    });
});
