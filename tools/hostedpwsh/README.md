# Hosted PowerShell runtime

The hosted runtime is the Windows Block Terminal PowerShell execution path for structured ordinary commands. It embeds one PowerShell SDK Runspace in one host process while keeping Wave / ConPTY / xterm.js as the live terminal path.

Structured lifecycle/output events are sent over a loopback TCP sidechannel authenticated by a per-process token. Terminal-visible output still flows through the host process stdout/stderr and the Wave/xterm PTY path; structured sidechannel output is consumed by the product Command Journal rather than re-rendered as a second terminal stream.

## Runtime activation

Packaged Windows builds and development launches behave differently.

### Packaged Windows build

When the packaged resource exists at:

```text
hostedpwsh/win-x64/WbtHostedPowerShell.exe
```

`emain/emain-wavesrv.ts` automatically supplies:

```text
WBT_HOSTED_PWSH=1
WBT_HOSTED_PWSH_EXE=<packaged executable path>
```

unless `WBT_HOSTED_PWSH` was already supplied by the environment.

This packaged-resource auto-enable behavior is an implementation detail, not a permanent rollout-policy invariant.

### Development / unpackaged launch

A normal `task dev` launch does not automatically create the packaged hosted-runtime resource path. To test the structured hosted path in development, explicitly provide a published executable before starting the app, for example in PowerShell 7:

```powershell
$env:WBT_HOSTED_PWSH = "1"
$env:WBT_HOSTED_PWSH_EXE = "C:\path\to\WbtHostedPowerShell.exe"
task dev
```

If these variables are omitted and no packaged hosted-runtime resource is present, the launch may use the non-hosted Wave PowerShell path. Do not treat that mode as valid Product Evidence for structured Command Cards.

## Architecture boundary

The hosted runtime does not replace the live terminal emulator and must not introduce a second authoritative PowerShell session. The current architecture requires:

- one hosted process;
- one persistent Runspace;
- authenticated structured lifecycle/output for ordinary commands;
- PTY/xterm ownership of realtime interactive programs;
- conservative interactive output semantics;
- product-owned durable Command Journal history.

The final default/fallback rollout policy remains part of Release Candidate Readiness rather than a frozen architecture invariant. See `docs/PROJECT-STATUS.md`, `docs/ROADMAP.md`, and `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md` for current authority.
