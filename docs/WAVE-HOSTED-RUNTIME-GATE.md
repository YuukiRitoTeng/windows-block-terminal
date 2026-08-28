# Wave Hosted Runtime Gate Evidence

> **Historical gate evidence.** This document records the hosted-runtime feasibility state at the time of this gate. Its GO verdict remains valid evidence for the one-host / one-Runspace architecture, but its project-state and “still unproven” statements are not current roadmap authority. For the current product state and next stage, read `docs/PROJECT-STATUS.md` and `docs/ROADMAP.md`. For architecture authority, read `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md`.

## Scope

This document records the opt-in Wave/ConPTY hosted PowerShell feasibility gate. It was not a Product Evidence Gate, a Command Journal migration, or a default-runtime decision.

Later work integrated the hosted runtime into the Product Evidence, persistence, packaging and visual-product flows. This document should therefore be read as evidence for the gate it actually ran, not as a description of the current product surface.

## Baseline

- Repository: `YuukiRitoTeng/windows-block-terminal`
- Base: `7a804c51` (`Correct command execution and output attribution boundaries (#25)`)
- Gate branch: `feat/wave-hosted-runtime-gate`
- Gate head: `2200d4df`
- Wave build version: `0.14.5`
- Windows: Windows 11 build `26200`, x64
- Hosted runtime: `WbtHostedPowerShell.exe`
- PowerShell SDK: `7.4.12`
- Target framework: `.NET 8.0`
- Published executable:
  `tools/hostedpwsh/bin/Release/net8.0/win-x64/publish/WbtHostedPowerShell.exe`

## Real Wave process evidence

- Session A: Wave backend `wavesrv.x64.exe` PID `17288`, hosted host PID `11460`, Runspace `ee6d778e-a510-46b2-8c3e-94c7711cc88c`.
- Session A raw trace:
  `C:\Users\ROG\AppData\Local\Temp\wbt-hosted-f1e1c1b0-5c74-4056-90ba-311cac6a2de0-1787672816896648100.log`
- Session B: Wave backend `wavesrv.x64.exe` PID `31316`, hosted host PID `16344`, Runspace `0d0fa9cc-daa6-49a8-8337-1c91fa39dc44`.
- Session B raw trace:
  `C:\Users\ROG\AppData\Local\Temp\wbt-hosted-f1e1c1b0-5c74-4056-90ba-311cac6a2de0-1787673440675511800.log`

Session A covered ordinary structured success and direct native failure. Session B covered the corrected PowerShell failure path, mixed pipeline semantics, native interactive exit, native Ctrl+C, and post-interactive state continuity. The error-path correction required restarting Wave, so the complete capability set is not represented by one host/runspace/raw-log tuple.

In both sessions the hosted process was the shell child launched by `wavesrv`. No second `pwsh.exe` shell was found in the hosted process ancestry. Unrelated PowerShell processes owned by the development environment were excluded from that process-tree check. Each session created exactly one Runspace.

## Verified manual sequence

The following were entered in the real Wave terminal:

1. `Write-Output "wave-hosted-success"`
2. `cmd /c exit 7`
3. `throw "wave-hosted-powershell-failure"`
4. `Write-Output x | cmd /c exit 7`
5. `python`, `print("wave-hosted-interactive")`, `exit()`
6. `:interactive python -c "import time; print('native-start', flush=True); time.sleep(30)"`, followed by manual Ctrl+C
7. State baseline, Python interactive exit, then `Get-Location`, `$env:WBT_HOSTED_GATE`, `$x`, `Get-WBTX`, and `wbtx`

Observed results:

- ordinary output was visible in the live terminal;
- direct native failure was `success=false`, `exitCode=7`;
- PowerShell failure recovered to `WBT>` and displayed the error after the error-path fix;
- mixed pipeline was classified as non-direct-native and mapped to `exitCode=1` from PowerShell success semantics;
- Python input/output was realtime and normal exit returned to `WBT>`;
- native foreground Ctrl+C produced `CTRL_C_RECEIVED`, child exit `-1073741510`, and returned to `WBT>`;
- cwd, environment variable, variable, function, and alias were preserved after interactive handoff;
- all post-interactive invocations retained the same Runspace InstanceId.

## Structured sidechannel

The Go runtime creates an opt-in loopback TCP sidechannel with a per-process token. The hosted process recorded `SIDECAR_CONNECTED` and sends `hello`, `runtime_ready`, `command_started`, `output`, and `command_finished` JSON events. The backend receiver is coded to log event metadata and output lengths; it does not re-render sidechannel output, so terminal-visible output remains owned by the Wave/xterm PTY path. This run captured the host-side connection and event-producing trace, but not a separately persisted backend receive log.

This proves the feasibility transport seam. A durable Product runtime consumer, Command Journal registration, final RPC schema, and UI projection were intentionally not part of this gate.

## Verdict

**WAVE HOSTED-RUNTIME GATE = GO**

This GO is limited to the real Wave/ConPTY hosted-runtime feasibility seam, with the evidence split across the two sessions above:

- one hosted process;
- one persistent Runspace;
- structured ordinary execution;
- structured sidechannel transport;
- live terminal output;
- native interactive handoff;
- native Ctrl+C recovery;
- same-session continuity;
- no second shell session and no second Runspace.

## What was still unproven at this gate

At the time this gate ran, the following were explicitly outside its evidence scope:

- Command Journal production consumer registration;
- Command Card, Copy Output, Copy All, and Product Evidence UI;
- exact interactive output capture;
- TUI, vim, fzf, ssh, alternate screen, and resize compatibility;
- crash/reconnect and sidechannel backpressure;
- final schema, RPC contract, persistence migration, and default-runtime rollout.

Later Product Evidence and packaging work closed the first two product-integration gaps and established durable persistence. The broader interactive/recovery matrix, large-scale release behavior and final hosted-runtime rollout/fallback policy remain Release Candidate Readiness concerns. Exact interactive output is still intentionally not promised without independent causal evidence.

The split-session limitation described by this original gate remains part of this gate record; later evidence must be consulted for any stronger integrated-run claim.
