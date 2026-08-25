# Wave Hosted Runtime Gate Evidence

## Scope

This document records the opt-in Wave/ConPTY hosted PowerShell feasibility gate. It is not a Product Evidence Gate, a Command Journal migration, or a default-runtime decision.

## Baseline

- Repository: `YuukiRitoTeng/windows-block-terminal`
- Base: `7a804c51` (`Correct command execution and output attribution boundaries (#25)`)
- Gate branch: `feat/wave-hosted-runtime-gate`
- Gate head: `4b6f01b3`
- Wave build version: `0.14.5`
- Windows: Windows 11 build `26200`, x64
- Hosted runtime: `WbtHostedPowerShell.exe`
- PowerShell SDK: `7.4.12`
- Target framework: `.NET 8.0`
- Published executable:
  `tools/hostedpwsh/bin/Release/net8.0/win-x64/publish/WbtHostedPowerShell.exe`

## One-session process evidence

- Wave backend: `wavesrv.x64.exe`, PID `31316`
- Hosted PowerShell host: PID `16344`, child of PID `31316`
- Runspace InstanceId: `0d0fa9cc-daa6-49a8-8337-1c91fa39dc44`
- Raw host trace:
  `C:\Users\ROG\AppData\Local\Temp\wbt-hosted-f1e1c1b0-5c74-4056-90ba-311cac6a2de0-1787673440675511800.log`

The trace contains one `HOST_START`, one `RUNSPACE_OPEN`, and all structured and interactive invocations under the same Runspace InstanceId.

The hosted process is the shell child launched by `wavesrv`. No second `pwsh.exe` shell was found in the hosted process ancestry. Unrelated PowerShell processes owned by the development environment were excluded from that process-tree check. No second Runspace was created by the hosted runtime.

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

This proves the feasibility transport seam. A durable Product runtime consumer, Command Journal registration, final RPC schema, and UI projection are intentionally not part of this gate.

## Verdict

**WAVE HOSTED-RUNTIME GATE = GO**

This GO is limited to the real Wave/ConPTY hosted-runtime feasibility seam:

- one hosted process;
- one persistent Runspace;
- structured ordinary execution;
- structured sidechannel transport;
- live terminal output;
- native interactive handoff;
- native Ctrl+C recovery;
- same-session continuity;
- no second shell session and no second Runspace.

Still unproven and explicitly out of scope:

- Command Journal production consumer registration;
- Command Card, Copy Output, Copy All, and Product Evidence UI;
- exact interactive output capture;
- TUI, vim, fzf, ssh, alternate screen, and resize compatibility;
- crash/reconnect and sidechannel backpressure;
- final schema, RPC contract, persistence migration, and default-runtime rollout.
