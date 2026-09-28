// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildElevatedRelaunchScript,
    buildPowerShellRelaunchArgs,
    defaultPowerShellCandidates,
    describeRelaunchFailure,
    ElevatedExitedPrefix,
    ElevatedHandoverGraceMs,
    ElevatedPidPrefix,
    ElevatedRelaunchFlag,
    escapePowerShellSingleQuoted,
    isElevatedFromWhoamiGroups,
    isRelaunchFailure,
    isRelaunchSuccess,
    isUserDeclinedElevation,
    parseRelaunchOutput,
    probePowerShell,
    readAlwaysAdminSetting,
    RelaunchFailure,
    RelaunchResult,
    RelaunchSuccess,
    resolveElevatedForDisplay,
    resolveExecutableOnPath,
    runElevationGate,
    SettingsKeyAlwaysAdmin,
    stripJsonCommentsAndTrailingCommas,
} from "./elevation";

const Exe = "C:\\Program Files\\WindowsBlockTerminal\\WindowsBlockTerminal.exe";

/** Real shape of `whoami /groups` output, with the localized middle column kept as-is. */
function whoamiOutput(integritySid: string, groupSids: string[]): string {
    const groupLines = groupSids.map(
        (sid) => `BUILTIN\\Administrators                                        Group            ${sid}`
    );
    return [
        "",
        "GROUP INFORMATION",
        "-----------------",
        "",
        ...groupLines,
        `Mandatory Label\\Medium Mandatory Level                        Label            ${integritySid}`,
        "",
    ].join("\r\n");
}

describe("always admin elevation detection", () => {
    it("treats the high mandatory integrity level as elevated", () => {
        expect(isElevatedFromWhoamiGroups(whoamiOutput("S-1-16-12288", ["S-1-5-32-544"]))).toBe(true);
    });

    it("treats a medium integrity token without the administrators group as unelevated", () => {
        expect(isElevatedFromWhoamiGroups(whoamiOutput("S-1-16-8192", ["S-1-5-32-545"]))).toBe(false);
    });

    it("treats a filtered admin token (administrators SID but medium integrity) as unelevated", () => {
        // This is the default state of an administrator's normal logon: the SID is present in the
        // token but the token is not elevated. Relaunching here would be a spurious UAC prompt.
        expect(isElevatedFromWhoamiGroups(whoamiOutput("S-1-16-8192", ["S-1-5-32-544"]))).toBe(false);
    });

    it("still reports elevated when the mandatory label row is localized away but the high SID is present", () => {
        const localized = ["GROUP INFORMATION", "Mandatory Label\\High Mandatory Level   Label   S-1-16-12288"].join(
            "\r\n"
        );
        expect(isElevatedFromWhoamiGroups(localized)).toBe(true);
    });

    it("reports unelevated for empty output", () => {
        expect(isElevatedFromWhoamiGroups("")).toBe(false);
    });

    it("recognizes a declined UAC prompt in english, localized and error-code form", () => {
        expect(isUserDeclinedElevation("The operation was canceled by the user")).toBe(true);
        expect(isUserDeclinedElevation("操作已被用户取消")).toBe(true);
        expect(isUserDeclinedElevation("Command failed with exit code 1223")).toBe(true);
        expect(isUserDeclinedElevation("HRESULT 0x800704C7")).toBe(false);
        expect(isUserDeclinedElevation("some unrelated failure")).toBe(false);
    });

    it("does not read an unrelated 1223 in diagnostics as a declined prompt", () => {
        // Guards the false positive: any stderr number containing 1223 used to be reported to the
        // user as "you declined the UAC prompt".
        expect(isUserDeclinedElevation("wrote 1223 bytes to the log")).toBe(false);
        expect(isUserDeclinedElevation("child pid 12234 exited")).toBe(false);
        expect(isUserDeclinedElevation("process 1223 is not responding")).toBe(false);
    });
});

describe("always admin relaunch command", () => {
    it("requests elevation with the runas verb from PowerShell, with no cmd.exe involved", () => {
        const script = buildElevatedRelaunchScript(Exe);
        expect(script).toContain("-Verb RunAs");
        expect(script).toContain("Start-Process");
        expect(script).toContain(`$wbtExe='${Exe}'`);
        expect(script).not.toContain("cmd.exe");
        expect(script).not.toContain("cmd /c");
    });

    it("passes the handover marker to the elevated instance", () => {
        expect(buildElevatedRelaunchScript(Exe)).toContain(`$wbtArgs += '${ElevatedRelaunchFlag}'`);
    });

    it("hides the launched process, because an elevated launch otherwise realises a console window", () => {
        // Measured, not assumed: without this flag the elevated Start-Process produced a visible
        // Windows Terminal window (class CASCADIA_HOSTING_WINDOW_CLASS, title "Terminal") for
        // ~7.8 s where Windows Terminal is the effective default terminal, and `windowsHide` on the
        // Node side cannot suppress it. With the flag: 0 visible console windows, target still ran,
        // and the child's own whoami output still reported High mandatory integrity level.
        const script = buildElevatedRelaunchScript(Exe);
        expect(script).toContain("-WindowStyle Hidden");
        // It must be on the same Start-Process call as the runas verb.
        const startProcess = script.split("; ").find((part) => part.includes("Start-Process"));
        expect(startProcess).toBeDefined();
        expect(startProcess).toContain("-Verb RunAs");
        expect(startProcess).toContain("-WindowStyle Hidden");
    });

    it("reports the child pid, or that the child exited during the handover grace period", () => {
        const script = buildElevatedRelaunchScript(Exe);
        expect(script).toContain(`${ElevatedPidPrefix}`);
        expect(script).toContain(`${ElevatedExitedPrefix}`);
        expect(script).toContain(`$wbtProc.WaitForExit(${ElevatedHandoverGraceMs})`);
    });

    it("surfaces a refused prompt through the catch block", () => {
        const script = buildElevatedRelaunchScript(Exe);
        expect(script).toContain("catch {");
        expect(script).toContain("WBT-ELEVATION-FAILED");
        expect(script).toContain("exit 1");
    });

    it("escapes an apostrophe in the exe path instead of breaking out of the PowerShell string", () => {
        const script = buildElevatedRelaunchScript("C:\\Users\\o'brien\\app.exe");
        expect(script).toContain("o''brien");
        expect(script).not.toContain("$wbtExe='C:\\Users\\o'brien");
    });

    it("quotes a path containing a space", () => {
        const spaced = "C:\\Users\\me\\My App\\WindowsBlockTerminal.exe";
        expect(buildElevatedRelaunchScript(spaced)).toContain(`$wbtExe='${spaced}'`);
    });

    it("builds a non-interactive PowerShell invocation", () => {
        const args = buildPowerShellRelaunchArgs(Exe);
        expect(args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
        expect(args[5]).toBe(buildElevatedRelaunchScript(Exe));
    });

    it("escapes single quotes", () => {
        expect(escapePowerShellSingleQuoted("a'b'c")).toBe("a''b''c");
        expect(escapePowerShellSingleQuoted("plain")).toBe("plain");
    });

    it("is a syntactically valid PowerShell script according to a real PowerShell parser", () => {
        // A string assertion cannot catch a syntax error or an unsupported parameter. This asks the
        // parser itself, which is the cheapest real check available in a unit test.
        const parserHost = findPowerShellSync();
        if (parserHost == null) {
            return;
        }
        const script = buildElevatedRelaunchScript(Exe);
        const check =
            "$t=$null;$e=$null;" +
            "[System.Management.Automation.Language.Parser]::ParseInput(" +
            "$env:WBT_SCRIPT_TO_CHECK,[ref]$t,[ref]$e)|Out-Null;" +
            "if($e -ne $null -and $e.Count -gt 0){Write-Output ('ERRORS:'+$e.Count)}else{Write-Output 'PARSE-OK'}";
        const result = child_process.spawnSync(parserHost, ["-NoProfile", "-NonInteractive", "-Command", check], {
            windowsHide: true,
            timeout: 30000,
            encoding: "utf8",
            env: { ...process.env, WBT_SCRIPT_TO_CHECK: script },
        });
        expect(`${result.stdout ?? ""}`.trim()).toBe("PARSE-OK");
    });
});

/**
 * A PowerShell that can run a parse check, found without going through the module's resolution
 * cache (which a test may have pointed elsewhere).
 */
function findPowerShellSync(): string | null {
    for (const candidate of ["pwsh.exe", "powershell.exe"]) {
        const found = child_process.spawnSync("where.exe", [candidate], {
            windowsHide: true,
            timeout: 10000,
            encoding: "utf8",
        });
        if (found.status === 0) {
            const first = `${found.stdout ?? ""}`
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0)[0];
            if (first) {
                return first;
            }
        }
    }
    return null;
}

describe("always admin relaunch result parsing", () => {
    /** Narrows a RelaunchResult to its failure arm, so assertions can read reason/detail. */
    function expectFailure(result: RelaunchResult): RelaunchFailure {
        if (!isRelaunchFailure(result)) {
            throw new Error(`expected a failed relaunch result, got ok:true (pid ${result.pid})`);
        }
        return result;
    }

    /** Narrows a RelaunchResult to its success arm. */
    function expectSuccess(result: RelaunchResult): RelaunchSuccess {
        if (!isRelaunchSuccess(result)) {
            throw new Error(`expected a successful relaunch result, got failure: ${result.reason}`);
        }
        return result;
    }

    it("treats a child that exited during the handover window as a successful launch", () => {
        // This is the branch that used to tell the user "Windows did not grant elevation" on an
        // ordinary second launch, where elevation had in fact succeeded.
        const result = expectSuccess(
            parseRelaunchOutput({
                stdout: `${ElevatedExitedPrefix}0\r\n`,
                errorText: "",
                hasError: false,
            })
        );
        expect(result.exitedEarly).toBe(true);
    });

    it("reads the pid when the child stayed up", () => {
        const result = expectSuccess(
            parseRelaunchOutput({
                stdout: `${ElevatedPidPrefix}4242\r\n`,
                errorText: "",
                hasError: false,
            })
        );
        expect(result.pid).toBe(4242);
        expect(result.exitedEarly).toBe(false);
    });

    it("prefers the exited marker if both somehow appear", () => {
        const result = expectSuccess(
            parseRelaunchOutput({
                stdout: `${ElevatedExitedPrefix}1 ${ElevatedPidPrefix}99`,
                errorText: "",
                hasError: false,
            })
        );
        expect(result.exitedEarly).toBe(true);
    });

    it("reports a declined prompt when the launcher failed with a cancellation", () => {
        const result = expectFailure(
            parseRelaunchOutput({
                stdout: "",
                errorText: "The operation was canceled by the user",
                hasError: true,
            })
        );
        expect(result.reason).toBe("declined");
    });

    it("reports a generic error for an unrecognized failure", () => {
        const result = expectFailure(
            parseRelaunchOutput({
                stdout: "",
                errorText: "something else went wrong",
                hasError: true,
            })
        );
        expect(result.reason).toBe("error");
    });

    it("reports a generic error when nothing at all came back", () => {
        const result = expectFailure(parseRelaunchOutput({ stdout: "", errorText: "", hasError: false }));
        expect(result.reason).toBe("error");
        expect(result.detail).toMatch(/no result/i);
    });
});

describe("always admin powershell resolution", () => {
    afterEach(() => {
        vi.resetModules();
    });

    it("prefers PowerShell 7 when it responds to the version probe", async () => {
        vi.resetModules();
        const mod = await import("./elevation");
        const host = await mod.resolveElevationPowerShellHost(
            ["pwsh.exe", "powershell.exe"],
            async (candidate) => candidate === "pwsh.exe"
        );
        expect(host).toBe("pwsh.exe");
    });

    it("falls back to Windows PowerShell when PowerShell 7 is absent", async () => {
        vi.resetModules();
        const mod = await import("./elevation");
        const host = await mod.resolveElevationPowerShellHost(
            ["pwsh.exe", "powershell.exe"],
            async (candidate) => candidate === "powershell.exe"
        );
        expect(host).toBe("powershell.exe");
    });

    it("falls back to the bare host name when nothing responds", async () => {
        vi.resetModules();
        const mod = await import("./elevation");
        await expect(mod.resolveElevationPowerShellHost(["pwsh.exe"], async () => false)).resolves.toBe(
            "powershell.exe"
        );
    });

    it("skips empty candidates", async () => {
        vi.resetModules();
        const mod = await import("./elevation");
        const seen: string[] = [];
        const host = await mod.resolveElevationPowerShellHost(["", "pwsh.exe"], async (candidate) => {
            seen.push(candidate);
            return true;
        });
        expect(seen).toEqual(["pwsh.exe"]);
        expect(host).toBe("pwsh.exe");
    });

    it("defaults to PowerShell 7 first and Windows PowerShell second", () => {
        expect(defaultPowerShellCandidates()).toEqual(["pwsh.exe", "powershell.exe"]);
    });

    it("resolves a real executable through PATH and reports a missing one as absent", async () => {
        await expect(resolveExecutableOnPath("cmd.exe")).resolves.toMatch(/cmd\.exe$/i);
        await expect(resolveExecutableOnPath("wbt-no-such-executable.exe")).resolves.toBeNull();
    });

    it("finds PowerShell 7 on this machine, because the Store alias is resolvable by name", async () => {
        // Absolute-path detection cannot see a Store/MSIX install; name resolution must. This test
        // needs PowerShell 7 present; if it fails here, check that before suspecting the code.
        await expect(resolveExecutableOnPath("pwsh.exe")).resolves.toMatch(/pwsh\.exe$/i);
    });

    it("probePowerShell reports presence for a real host and absence for a fake one", async () => {
        await expect(probePowerShell("powershell.exe")).resolves.toBe(true);
        await expect(probePowerShell("wbt-no-such-host.exe")).resolves.toBe(false);
    });
});

describe("always admin setting read", () => {
    const dirs: string[] = [];

    function tempConfigDir(contents?: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbt-alwaysadmin-"));
        dirs.push(dir);
        if (contents != null) {
            fs.writeFileSync(path.join(dir, "settings.json"), contents);
        }
        return dir;
    }

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reads an explicit true", () => {
        expect(readAlwaysAdminSetting(tempConfigDir(`{"${SettingsKeyAlwaysAdmin}":true}`))).toBe(true);
    });

    it("treats an explicit false as off", () => {
        expect(readAlwaysAdminSetting(tempConfigDir(`{"${SettingsKeyAlwaysAdmin}":false}`))).toBe(false);
    });

    it("treats an unset key as off", () => {
        expect(readAlwaysAdminSetting(tempConfigDir(`{"term:fontsize":14}`))).toBe(false);
    });

    it("treats a truthy non-boolean as off", () => {
        expect(readAlwaysAdminSetting(tempConfigDir(`{"${SettingsKeyAlwaysAdmin}":"yes"}`))).toBe(false);
    });

    it("treats a malformed settings file as off", () => {
        expect(readAlwaysAdminSetting(tempConfigDir("{not json"))).toBe(false);
    });

    it("treats a missing settings file as off", () => {
        expect(readAlwaysAdminSetting(tempConfigDir())).toBe(false);
    });

    it("treats a missing config directory as off", () => {
        expect(readAlwaysAdminSetting(path.join(os.tmpdir(), "wbt-alwaysadmin-does-not-exist"))).toBe(false);
    });

    it("still reads the key from a file the backend reader would accept", () => {
        // The backend tolerates comments and trailing commas and the docs point users at
        // `wsh editconfig`; a stricter reader here would show "Off" for a file that says true.
        const jsonc = [
            "{",
            "  // my settings",
            `  "${SettingsKeyAlwaysAdmin}": true,`,
            '  "term:fontsize": 14,',
            "}",
        ].join("\n");
        expect(readAlwaysAdminSetting(tempConfigDir(jsonc))).toBe(true);
    });

    it("tolerates block comments and no trailing comma", () => {
        const jsonc = `{ /* block */ "${SettingsKeyAlwaysAdmin}": true }`;
        expect(readAlwaysAdminSetting(tempConfigDir(jsonc))).toBe(true);
    });

    it("does not treat a commented-out key as enabled", () => {
        const jsonc = ["{", `  // "${SettingsKeyAlwaysAdmin}": true`, "}"].join("\n");
        expect(readAlwaysAdminSetting(tempConfigDir(jsonc))).toBe(false);
    });

    it("does not corrupt string values that contain comment or comma characters", () => {
        const raw = `{"s":"a//b","${SettingsKeyAlwaysAdmin}":true,"t":"x,}"}`;
        expect(stripJsonCommentsAndTrailingCommas(raw)).toContain(`"a//b"`);
        expect(readAlwaysAdminSetting(tempConfigDir(raw))).toBe(true);
    });

    it("preserves escaped quotes inside strings", () => {
        const raw = `{"s":"a\\"//b","${SettingsKeyAlwaysAdmin}":true}`;
        expect(readAlwaysAdminSetting(tempConfigDir(raw))).toBe(true);
    });
});

describe("always admin startup gate", () => {
    it("does not attempt elevation on non-windows platforms", async () => {
        const deps = {
            isElevated: vi.fn(async () => false),
            relaunchElevated: vi.fn(async () => ({ ok: true as const, pid: 1, exitedEarly: false })),
            reportFailure: vi.fn(),
        };
        await expect(runElevationGate(true, deps, ["app.exe"], "darwin")).resolves.toBe("not-windows");
        expect(deps.relaunchElevated).not.toHaveBeenCalled();
    });

    it("skips the gate when the caller already came through the elevated relaunch flag", async () => {
        const deps = {
            isElevated: vi.fn(async () => false),
            relaunchElevated: vi.fn(async () => ({ ok: true as const, pid: 1, exitedEarly: false })),
            reportFailure: vi.fn(),
        };
        await expect(runElevationGate(true, deps, ["app.exe", ElevatedRelaunchFlag], "win32")).resolves.toBe("flagged");
        expect(deps.isElevated).not.toHaveBeenCalled();
        expect(deps.relaunchElevated).not.toHaveBeenCalled();
    });

    it("relaunches and lets the caller quit when the setting is on and the token is not elevated", async () => {
        const deps = {
            isElevated: vi.fn(async () => false),
            relaunchElevated: vi.fn(async () => ({ ok: true as const, pid: 4242, exitedEarly: false })),
            reportFailure: vi.fn(),
        };
        await expect(runElevationGate(true, deps, ["app.exe"], "win32")).resolves.toBe("relaunched");
        expect(deps.relaunchElevated).toHaveBeenCalledTimes(1);
        expect(deps.reportFailure).not.toHaveBeenCalled();
    });

    it("does not relaunch an already elevated process", async () => {
        const deps = {
            isElevated: vi.fn(async () => true),
            relaunchElevated: vi.fn(async () => ({ ok: true as const, pid: 1, exitedEarly: false })),
            reportFailure: vi.fn(),
        };
        await expect(runElevationGate(true, deps, ["app.exe"], "win32")).resolves.toBe("already-elevated");
        expect(deps.relaunchElevated).not.toHaveBeenCalled();
    });

    it("never asks for elevation when the setting is off", async () => {
        const deps = {
            isElevated: vi.fn(async () => false),
            relaunchElevated: vi.fn(async () => ({ ok: true as const, pid: 1, exitedEarly: false })),
            reportFailure: vi.fn(),
        };
        await expect(runElevationGate(false, deps, ["app.exe"], "win32")).resolves.toBe("not-requested");
        expect(deps.isElevated).not.toHaveBeenCalled();
        expect(deps.relaunchElevated).not.toHaveBeenCalled();
    });

    it("reports success, not failure, when the elevated child lost the lock to a running instance", async () => {
        // End-to-end shape of the real duplicate launch: the child started, could not take the
        // single-instance lock, and exited. The user must not be told elevation failed.
        const deps = {
            isElevated: vi.fn(async () => false),
            relaunchElevated: vi.fn(async () =>
                parseRelaunchOutput({
                    stdout: `${ElevatedExitedPrefix}0`,
                    errorText: "",
                    hasError: false,
                })
            ),
            reportFailure: vi.fn(),
        };
        await expect(runElevationGate(true, deps, ["app.exe"], "win32")).resolves.toBe("relaunched");
        expect(deps.reportFailure).not.toHaveBeenCalled();
    });

    it("tells the user the prompt was declined when it was declined", async () => {
        const deps = {
            isElevated: vi.fn(async () => false),
            relaunchElevated: vi.fn(async () => ({ ok: false as const, reason: "declined" as const })),
            reportFailure: vi.fn(),
        };
        await expect(runElevationGate(true, deps, ["app.exe"], "win32")).resolves.toBe("failed");
        expect(deps.reportFailure).toHaveBeenCalledTimes(1);
        const message = deps.reportFailure.mock.calls[0][0] as string;
        expect(message).toMatch(/Always Admin/);
        expect(message).toMatch(/declined/i);
        expect(message).toMatch(/UAC prompt/i);
        expect(message).not.toMatch(/Windows did not grant elevation/i);
    });

    it("reports a generic failure without blaming a declined prompt", async () => {
        const deps = {
            isElevated: vi.fn(async () => false),
            relaunchElevated: vi.fn(async () => ({ ok: false as const, reason: "error" as const })),
            reportFailure: vi.fn(),
        };
        await expect(runElevationGate(true, deps, ["app.exe"], "win32")).resolves.toBe("failed");
        const message = deps.reportFailure.mock.calls[0][0] as string;
        expect(message).toMatch(/could not start an elevated instance/i);
        expect(message).not.toMatch(/Windows did not grant elevation/i);
        expect(message).not.toMatch(/declined/i);
    });
});

describe("always admin failure messages", () => {
    it("gives every failure reason a distinct, non-empty message", () => {
        const reasons = ["declined", "error"] as const;
        const messages = reasons.map((r) => describeRelaunchFailure(r));
        for (const message of messages) {
            expect(message.length).toBeGreaterThan(40);
            expect(message).toMatch(/Always Admin/);
        }
        expect(new Set(messages).size).toBe(reasons.length);
    });
});

describe("SUDO truth is the token, never the launch marker", () => {
    it("does not report elevated for a flagged launch whose token is not elevated", async () => {
        // The forgery this guards: an ordinary user runs
        //   WindowsBlockTerminal.exe --wbt-elevated-relaunch
        // The marker only records where a process came from, so the badge must stay hidden.
        const probe = vi.fn(async () => false);
        await expect(resolveElevatedForDisplay("flagged", probe)).resolves.toBe(false);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it("reports elevated for a flagged launch only when the token really is elevated", async () => {
        await expect(resolveElevatedForDisplay("flagged", async () => true)).resolves.toBe(true);
    });

    it("trusts the gate's own measurement without probing twice", async () => {
        const probe = vi.fn(async () => false);
        await expect(resolveElevatedForDisplay("already-elevated", probe)).resolves.toBe(true);
        expect(probe).not.toHaveBeenCalled();
    });

    it("measures the token for every other outcome", async () => {
        for (const outcome of ["not-requested", "relaunched", "failed"] as const) {
            const probe = vi.fn(async () => false);
            await expect(resolveElevatedForDisplay(outcome, probe)).resolves.toBe(false);
            expect(probe).toHaveBeenCalledTimes(1);
        }
    });

    it("never reports elevated on a platform where elevation is not applicable", async () => {
        const probe = vi.fn(async () => false);
        await expect(resolveElevatedForDisplay("not-windows", probe)).resolves.toBe(false);
        expect(probe).not.toHaveBeenCalled();
    });
});
