// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Always Admin.
 *
 * WBT runs the local shell inside the wavesrv process tree: WindowsBlockTerminal.exe spawns
 * wavesrv, and wavesrv spawns the user's shell over ConPTY. A child process inherits its parent's
 * access token, so the only way to give the shell an elevated token is for the whole application to
 * be started elevated -- there is no supported way to elevate a process in place, and an elevated
 * shell cannot be attached to an unelevated application's pseudoconsole.
 *
 * So "Always Admin" is a persistent setting that makes startup re-launch this application once
 * through the Windows `runas` verb, using PowerShell. The relaunched instance is elevated, and
 * every shell it starts inherits that token. Consequences that are inherent to Windows, not to
 * this implementation:
 *
 *  - The UAC prompt cannot be suppressed by an application, and an elevated process cannot be
 *    de-elevated in place. Turning the setting off takes effect on the next normal start.
 *  - On a default Windows configuration the user is asked to consent on every elevated start. A
 *    machine whose policy sets UAC to elevate without prompting asks nothing; this code does not
 *    assume either behaviour.
 *  - Explorer drag-and-drop into the window stops working while elevated (UIPI blocks the window
 *    messages), and mapped network drives are not visible from an elevated token.
 *  - A standard (non-admin) account gets a credential prompt instead of a consent prompt, and a
 *    managed machine can refuse the request outright.
 *
 * Declining the prompt is not a failure loop: we ask once per process start, report it once, and
 * keep running unelevated.
 *
 * The working directory is deliberately not carried across the elevation boundary. It is not
 * needed: wavesrv is started with the absolute wave data directory as its cwd, and a shell's
 * initial directory comes from the block's explicit `cmd:cwd` meta (restored after a restart).
 * PowerShell's -WorkingDirectory is silently ignored together with -Verb RunAs (measured: the
 * child still started in System32), so attempting to preserve cwd would cost a cmd.exe shim for
 * no behavioral gain.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const SettingsKeyAlwaysAdmin = "app:alwaysadmin";

/** Marker argv flag. Its presence proves the caller already went through the UAC gate. */
export const ElevatedRelaunchFlag = "--wbt-elevated-relaunch";

/** Printed by the launcher script so the parent can tell a started child from a refused prompt. */
export const ElevatedPidPrefix = "WBT-ELEVATED-PID=";

/**
 * Printed when the child started but exited inside the handover grace period.
 *
 * This is NOT a failure signal on its own. It means the child ran: it logged its own start and then
 * exited, and the only expected reason for that is losing the single-instance lock to an instance
 * that is already running. Measured on a real duplicate launch: the child logged "could not get
 * single-instance-lock, shutting down" 0.19 s after starting. Treating this as "Windows did not
 * grant elevation" told the user elevation had failed when it had in fact succeeded.
 */
export const ElevatedExitedPrefix = "WBT-ELEVATED-EXITED=";

/** How long a started child must stay alive to count as "the session moved to it". */
export const ElevatedHandoverGraceMs = 5000;

/** PowerShell's localized UAC-cancel text, matched case-insensitively as a fallback. */
const UserCancelledPattern = /(canceled|cancelled|取消|已取消)/i;

/**
 * Why an elevation attempt did not produce a running elevated instance. The distinction matters to
 * the user: a declined prompt and a broken launch are different problems with different remedies.
 */
export type RelaunchFailureReason = "declined" | "error";

/** The elevated instance was started. */
export interface RelaunchSuccess {
    ok: boolean;
    /** True when the child started and then exited by itself inside the handover window. */
    exitedEarly: boolean;
    /** Child pid when it was known. */
    pid?: number;
}

/** The elevated instance could not be started. */
export interface RelaunchFailure {
    ok: boolean;
    reason: RelaunchFailureReason;
    detail?: string;
}

/**
 * Outcome of an elevation attempt. A single flat shape with an explicit guard is used on purpose:
 * this repo compiles with `strict: false`, under which TypeScript does not narrow a union on the
 * `ok` discriminant, so predicates are what actually work here.
 */
export type RelaunchResult = RelaunchSuccess | RelaunchFailure;

export function isRelaunchFailure(result: RelaunchResult): result is RelaunchFailure {
    return !result.ok;
}

export function isRelaunchSuccess(result: RelaunchResult): result is RelaunchSuccess {
    return result.ok;
}

export type ElevationDeps = {
    /** Reports whether the *current* process token is already elevated. */
    isElevated: () => Promise<boolean>;
    /** Starts this application elevated, reporting why it failed when it did. */
    relaunchElevated: () => Promise<RelaunchResult>;
    /** Reports a declined/failed elevation request to the user exactly once. */
    reportFailure: (message: string) => void;
};

export type ElevationGateResult =
    "not-requested" | "already-elevated" | "flagged" | "not-windows" | "relaunched" | "failed";

/**
 * The relaunch script, kept pure and exported so its exact text is testable without spawning.
 *
 * - PowerShell 7 is preferred; Windows PowerShell 5.1 is the fallback, so no host is assumed.
 * - `-Verb RunAs` is the only supported way to request elevation; the prompt and the refusal are
 *   both reported through the catch block.
 * - `-WindowStyle Hidden` is required, and this was measured rather than assumed. Elevated
 *   `Start-Process` gives the target its own console, and on a machine where Windows Terminal is
 *   installed and is the effective default terminal, that console is realised as a *Windows
 *   Terminal* window: the measured launch produced a visible `CASCADIA_HOSTING_WINDOW_CLASS`
 *   window titled "Terminal" for ~7.8 s. `windowsHide` on the Node side cannot suppress that,
 *   because it only affects classic `conhost` windows. Adding `-WindowStyle Hidden` removed the
 *   window entirely (1 -> 0 visible console windows) in the same measurement, while the target
 *   still ran and the child's own `whoami /groups` output still reported High mandatory integrity
 *   level, i.e. elevation itself was unaffected.
 * - The grace period only decides what the parent does; Windows owns the consent UI lifetime.
 */
export function buildElevatedRelaunchScript(execPath: string): string {
    return (
        "$ErrorActionPreference='Stop'; " +
        `$wbtExe='${escapePowerShellSingleQuoted(execPath)}'; ` +
        "$wbtArgs=@(); " +
        `$wbtArgs += '${ElevatedRelaunchFlag}'; ` +
        "try { " +
        "$wbtProc = Start-Process -FilePath $wbtExe -ArgumentList $wbtArgs -Verb RunAs -WindowStyle Hidden -PassThru; " +
        `if ($wbtProc.WaitForExit(${ElevatedHandoverGraceMs})) { ` +
        `Write-Output ('${ElevatedExitedPrefix}' + $wbtProc.ExitCode); exit 1 ` +
        "} " +
        `Write-Output ('${ElevatedPidPrefix}' + $wbtProc.Id); exit 0 ` +
        "} catch { " +
        "Write-Error ('WBT-ELEVATION-FAILED: ' + $_.Exception.Message); exit 1 " +
        "}"
    );
}

export function buildPowerShellRelaunchArgs(execPath: string): string[] {
    return [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildElevatedRelaunchScript(execPath),
    ];
}

export function escapePowerShellSingleQuoted(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * PowerShell hosts to try, most preferred first.
 *
 * Plain names are deliberate. A Store/MSIX PowerShell 7 install is registered in PATH and works
 * when launched by name, but its package path is not reliably readable from an unelevated process,
 * so an `existsSync`-based list cannot detect it (it is also why `"pwsh.exe"` must never be mixed
 * into a list of absolute paths). NAME resolution covers Store, MSI and portable installs alike.
 */
export function defaultPowerShellCandidates(): string[] {
    return ["pwsh.exe", "powershell.exe"];
}

/** Resolve one executable name through PATH. Never throws; returns null when it is not found. */
export async function resolveExecutableOnPath(candidate: string, timeoutMs = 10000): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
        let settled = false;
        const done = (value: string | null) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        try {
            const proc = child_process.execFile(
                "where.exe",
                [candidate],
                { windowsHide: true, timeout: timeoutMs },
                (err, stdout) => {
                    if (err) {
                        done(null);
                        return;
                    }
                    const first = `${stdout ?? ""}`
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .filter((line) => line.length > 0)[0];
                    done(first ?? null);
                }
            );
            proc.on("error", () => done(null));
        } catch (_) {
            done(null);
        }
    });
}

/** True when a candidate can be executed. Never throws. */
export async function probePowerShell(candidate: string): Promise<boolean> {
    return (await resolveExecutableOnPath(candidate)) != null;
}

let resolvedPowerShellHost: string | null = null;

/** Test seam: forget the cached host so resolution can be re-exercised. */
export function resetResolvedPowerShellHost(): void {
    resolvedPowerShellHost = null;
}

/**
 * Resolve the elevation host once per process: PowerShell 7 when it exists, Windows PowerShell 5.1
 * otherwise, and the bare name as a last resort so the relaunch still has a chance to work.
 */
export async function resolveElevationPowerShellHost(
    candidates: string[] = defaultPowerShellCandidates(),
    probe: (candidate: string) => Promise<boolean> = probePowerShell
): Promise<string> {
    if (resolvedPowerShellHost != null) {
        return resolvedPowerShellHost;
    }
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        if (await probe(candidate)) {
            resolvedPowerShellHost = candidate;
            console.log(`always-admin: elevation host is ${candidate}`);
            return candidate;
        }
    }
    console.log("always-admin: no PowerShell host responded to a version probe");
    return "powershell.exe";
}

/**
 * True when a `whoami /groups` listing shows an elevated token.
 *
 * Two independent, locale-independent signals, because the output is localized:
 *  - `S-1-16-12288` is the High mandatory integrity level (medium is S-1-16-8192). This depends on
 *    the raw SID still being present, which holds unless the caller passed `/fo csv /nh`.
 *  - `S-1-5-32-544` is BUILTIN\Administrators. Windows filters that SID out of a *denied-only* list
 *    for a standard user's token (documented for `whoami /groups`), and shows it for the
 *    Administrators group of an elevated administrator token. It also appears in a limited
 *    administrator token, so it is only accepted when the mandatory label is not visibly Medium.
 */
export function isElevatedFromWhoamiGroups(output: string): boolean {
    if (output.includes("S-1-16-12288")) {
        return true;
    }
    return output.includes("S-1-5-32-544") && !output.includes("S-1-16-8192");
}

export function isUserDeclinedElevation(text: string): boolean {
    // `1223` is only accepted next to an error keyword; a bare number in unrelated output (a pid, a
    // byte count) must not be read as "the user declined".
    if (/\b(?:error|code|hresult|0x)\D{0,4}1223\b/i.test(text)) {
        return true;
    }
    return UserCancelledPattern.test(text);
}

export function hasElevatedRelaunchFlag(argv: readonly string[]): boolean {
    return argv.includes(ElevatedRelaunchFlag);
}

/**
 * The setting is needed before the server starts, so it is read straight from settings.json rather
 * than through the config RPC. Anything other than an explicit `true` is off: a missing file, a
 * malformed file, and an unset key must all behave exactly like "off".
 *
 * The backend config reader accepts comments and trailing commas, and the documentation points
 * users at `wsh editconfig`, so the same tolerance is applied here. Without it a user whose
 * settings.json contains a comment would see the menu claim "Off" while their file says true.
 */
export function readAlwaysAdminSetting(configDir: string): boolean {
    try {
        const contents = fs.readFileSync(path.join(configDir, "settings.json"), "utf8");
        const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(contents));
        return parsed?.[SettingsKeyAlwaysAdmin] === true;
    } catch (_) {
        return false;
    }
}

/** Minimal JSONC tolerance: remove comments and trailing commas outside of string literals. */
export function stripJsonCommentsAndTrailingCommas(input: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (inString) {
            out += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === "/" && input[i + 1] === "/") {
            while (i < input.length && input[i] !== "\n") {
                i++;
            }
            out += "\n";
            continue;
        }
        if (ch === "/" && input[i + 1] === "*") {
            i += 2;
            while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
                i++;
            }
            i++;
            continue;
        }
        if (ch === ",") {
            let j = i + 1;
            while (j < input.length && /\s/.test(input[j])) {
                j++;
            }
            if (input[j] === "}" || input[j] === "]") {
                continue;
            }
        }
        out += ch;
    }
    return out;
}

export async function isProcessElevated(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (value: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        try {
            const proc = child_process.execFile(
                "whoami",
                ["/groups"],
                { windowsHide: true, timeout: 5000 },
                (err, stdout) => {
                    if (err) {
                        // Fail closed: an unreadable token state must not trigger a relaunch loop.
                        done(true);
                        return;
                    }
                    done(isElevatedFromWhoamiGroups(stdout ?? ""));
                }
            );
            proc.on("error", () => done(true));
        } catch {
            done(true);
        }
    });
}

/**
 * Classify the launcher script's result. Extracted so the branch that used to mis-report a
 * successful elevation as a failure is directly testable.
 *
 * The two markers are mutually exclusive by construction (the script exits after printing either),
 * but the EXITED marker is checked first so a stray pid marker can never mask it. The pid marker
 * carries the child pid; the exited marker carries the child's exit code, which is not a pid.
 */
export function parseRelaunchOutput(params: { stdout: string; errorText: string; hasError: boolean }): RelaunchResult {
    const out = params.stdout ?? "";
    if (out.includes(ElevatedExitedPrefix)) {
        // The child ran and then exited inside the grace window. The only expected cause is losing
        // the single-instance lock to an instance that is already running, so the elevated launch
        // itself succeeded and must not be reported to the user as a failure.
        return { ok: true, pid: -1, exitedEarly: true };
    }
    if (out.includes(ElevatedPidPrefix)) {
        const pid = Number.parseInt(out.split(ElevatedPidPrefix)[1] ?? "", 10);
        return { ok: true, pid: Number.isFinite(pid) ? pid : -1, exitedEarly: false };
    }
    if (params.hasError) {
        const declined = isUserDeclinedElevation(params.errorText);
        return { ok: false, reason: declined ? "declined" : "error", detail: params.errorText.trim() };
    }
    return { ok: false, reason: "error", detail: "the elevation request produced no result" };
}

export async function relaunchElevatedWithReason(): Promise<RelaunchResult> {
    const execPath = process.execPath;
    const psPath = await resolveElevationPowerShellHost();
    return await new Promise<RelaunchResult>((resolve) => {
        let settled = false;
        const done = (result: RelaunchResult, detail?: string) => {
            if (settled) {
                return;
            }
            settled = true;
            if (detail) {
                console.log("always-admin: elevated relaunch failed:", detail);
            }
            resolve(result);
        };
        try {
            const child = child_process.execFile(
                psPath,
                buildPowerShellRelaunchArgs(execPath),
                { windowsHide: true, timeout: 120000 },
                (err, stdout, stderr) => {
                    const result = parseRelaunchOutput({
                        stdout: `${stdout ?? ""}`,
                        errorText: `${err?.message ?? ""} ${stderr ?? ""}`,
                        hasError: err != null,
                    });
                    if (isRelaunchFailure(result)) {
                        done(result, result.detail ?? result.reason);
                        return;
                    }
                    if (result.exitedEarly) {
                        console.log(
                            "always-admin: the elevated instance started and then exited during the " +
                                "handover window (an instance that is already running owns the " +
                                "single-instance lock)"
                        );
                    }
                    done(result);
                }
            );
            child.on("error", (e: Error) =>
                done({ ok: false, reason: "error", detail: e?.message ?? String(e) }, e?.message ?? String(e))
            );
        } catch (e) {
            done({ ok: false, reason: "error", detail: e?.message ?? String(e) }, e?.message ?? String(e));
        }
    });
}

/** Boolean convenience wrapper, for callers that only need yes/no. */
export async function relaunchElevated(): Promise<boolean> {
    return (await relaunchElevatedWithReason()).ok;
}

export function describeRelaunchFailure(reason: RelaunchFailureReason): string {
    switch (reason) {
        case "declined":
            return (
                "Always Admin is on, but the elevation request was declined, so Windows did not " +
                "grant administrator rights.\n\nThis window keeps running without administrator " +
                "rights. Turn Always Admin off, or restart the application and accept the UAC prompt."
            );
        case "error":
            return (
                "Always Admin is on, but Windows Block Terminal could not start an elevated " +
                "instance.\n\nThis window keeps running without administrator rights. Turn Always " +
                "Admin off, or restart the application and accept the UAC prompt."
            );
    }
}

/**
 * Startup gate. Runs before the single-instance lock is taken: the elevated child must be able to
 * acquire the lock itself, so the unelevated parent must not hold it while the child starts.
 *
 * A second launch while an instance is already running is not a failure. The elevated child starts,
 * loses the single-instance lock to the incumbent, logs, and exits, which the launcher reports as
 * `exitedEarly`; that is treated as a successful launch rather than as "Windows did not grant
 * elevation", which is what it used to tell the user.
 */
export async function runElevationGate(
    alwaysAdmin: boolean,
    deps: ElevationDeps,
    argv: readonly string[] = process.argv,
    platform: string = process.platform
): Promise<ElevationGateResult> {
    if (platform !== "win32") {
        return "not-windows";
    }
    if (hasElevatedRelaunchFlag(argv)) {
        return "flagged";
    }
    if (!alwaysAdmin) {
        return "not-requested";
    }
    console.log("always-admin: enabled, checking for an elevated token");
    if (await deps.isElevated()) {
        console.log("always-admin: already running elevated");
        return "already-elevated";
    }
    console.log("always-admin: not elevated, requesting an elevated relaunch");
    const result = await deps.relaunchElevated();
    if (isRelaunchSuccess(result)) {
        return "relaunched";
    }
    deps.reportFailure(describeRelaunchFailure(result.reason));
    return "failed";
}

/**
 * Whether this process should be reported as elevated, for the SUDO badge and anything else that
 * needs the truth.
 *
 * The `--wbt-elevated-relaunch` marker is deliberately NOT an input here. It is a command-line
 * argument, so an unelevated launch can carry it; trusting it would let any user print an
 * administrator badge on a standard-rights process. The marker records where the process came from
 * and stops the gate from relaunching again -- nothing more. `gateResult` only tells us whether the
 * token still needs measuring: "already-elevated" means the gate just probed it, "relaunched" means
 * this process is about to hand over and exit, and every other outcome is measured here.
 */
export async function resolveElevatedForDisplay(
    gateResult: ElevationGateResult,
    probeToken: () => Promise<boolean>
): Promise<boolean> {
    if (gateResult === "already-elevated") {
        return true;
    }
    if (gateResult === "not-windows") {
        return false;
    }
    return await probeToken();
}
