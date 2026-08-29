# RC-EVIDENCE-3 Targeted Revalidation

## Candidate and test target

- Candidate ID: `RC-EVIDENCE-3`
- Source SHA: `02980db4f921c39357f19f91326aad98ee2de7aa`
- Installer: `Windows Block Terminal-win32-x64-0.14.5.exe`
- Installer SHA-256: `0C388EDB436D5CCC9586938BDBF457F57C437A74A47D8F40076B1D55331B0344`
- Preserved artifact: `C:\Users\ROG\Downloads\WBT-RC-EVIDENCE\RC-EVIDENCE-3\Windows Block Terminal-win32-x64-0.14.5.exe`
- Configuration: Windows 11 x64, installed packaged application, packaged Hosted
  PowerShell runtime, PowerShell 7.6.4.
- Installed application: `C:\Users\ROG\AppData\Local\WBT-Upgrade-Rehearsal\WindowsBlockTerminal.exe`
- Installed hosted runtime SHA-256: `63E64F092A19550724E3ABC956B70D8C3A2B3EEEB57899639A4789048857A22C`
- Installed hosted runtime matched the packaged runtime hash.

The application was launched with disposable process-local data/configuration
directories because the default data directory contained a stale `wave.sock`.
No real user data or preserved artifact was modified.

## Structured streaming probe — PASS

Command:

```powershell
Write-Output "WBT_RC3_FIRST"; Start-Sleep -Seconds 3; Write-Output "WBT_RC3_SECOND"
```

`WBT_RC3_FIRST` appeared during command execution, before the three-second
delay completed. `WBT_RC3_SECOND` appeared after the delay. Each appeared once
and the command completed normally. This is supporting evidence for streaming,
not a separate RC matrix row.

## Native Ctrl+C — PASS

Commands:

```powershell
$WbtRc3Pid = $PID
$WbtRc3Pid
ping 127.0.0.1 -t
```

Ping replies appeared line by line while the foreground workload was still
running; at least five realtime replies were observed. Ctrl+C terminated ping
and the prompt recovered without the application exiting. The follow-up
commands were:

```powershell
Write-Output "WBT_RC3_AFTER_CTRL_C"
$PID
$WbtRc3Pid
```

`WBT_RC3_AFTER_CTRL_C` succeeded. Both PID values were `32300`. The interrupted
Command Card visibly showed `FAILED`, `exit 1`, `structured`; the terminal also
showed `The pipeline has been stopped.` No `failed + exit 0` combination was
observed. CompletionReason and output attribution fields were not claimed as
visually observed; their interrupted/unknown semantics are covered by the
source-level regression tests for this source SHA.

RC-EVIDENCE-2 recorded the same scenario as FAIL because output was not
realtime and the interrupted record showed `failed / exit 0`. The RC3 installed
artifact revalidated both realtime output and consistent non-success
interruption behavior.

## Python REPL — PASS

Commands:

```powershell
python
print("WBT_RC3_PYTHON_REPL")
exit()
Write-Output "WBT_RC3_AFTER_PYTHON"
```

The REPL entered normally, output appeared, `exit()` returned to the original
PowerShell session, and the follow-up command succeeded. No session restart or
false ordinary structured Card from REPL input was observed.

## Nested PowerShell — PASS

Outer setup and checks:

```powershell
$WbtOuterPid = $PID
$env:WBT_RC3_NESTED = "preserved"
$WbtOuterCwd = (Get-Location).Path
$PID
$WbtOuterCwd
pwsh -NoLogo
Write-Output "WBT_RC3_NESTED"
exit
$PID
$WbtOuterPid
$env:WBT_RC3_NESTED
(Get-Location).Path
$WbtOuterCwd
Write-Output "WBT_RC3_AFTER_NESTED"
```

The outer PID remained `32300`; cwd remained `C:\Users\ROG`; the environment
value remained `preserved`; and the follow-up command succeeded. No session
restart or false ordinary structured Card from nested input was observed.

## Not tested

- `vim + resize`: NOT YET TESTED (`vim` unavailable)
- `fzf`: NOT YET TESTED (`fzf` unavailable)

## Batch result

- Structured streaming: PASS (supporting evidence)
- Native Ctrl+C: PASS
- Python REPL: PASS
- Nested PowerShell: PASS
- `vim + resize`: NOT YET TESTED
- `fzf`: NOT YET TESTED
