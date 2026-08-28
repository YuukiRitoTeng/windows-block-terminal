# RC-EVIDENCE-2 Interactive Batch 1

## Candidate and test target

- Candidate ID: `RC-EVIDENCE-2`
- Source SHA: `d15a30e5ee637eab8103d99e94d5ed35115fd96a`
- Installer: `Windows Block Terminal-win32-x64-0.14.5.exe`
- Installer SHA-256: `345E27D4E3F3194E6A80F72952B24252473043825A9BF5C29BA8AE14DEC8FA20`
- Test time: 2026-08-29 (manual session; exact wall-clock time was not captured)
- Configuration: Windows 11 x64, installed packaged application, packaged Hosted
  PowerShell runtime, PowerShell 7.6.4.

This batch used the preserved RC-EVIDENCE-2 installer, not a development build
or an unpacked build. The packaged application was launched with a disposable
process-local data/config directory because the prior data directory contained
an undeletable stale `wave.sock`; this did not modify the installer, source or
production code.

## Manual results

### Python REPL — PASS

Commands:

```powershell
python
print("WBT_RC2_PYTHON_REPL")
exit()
Write-Output "WBT_RC2_AFTER_PYTHON"
```

The REPL entered successfully, printed `WBT_RC2_PYTHON_REPL` in real time,
returned to the original PowerShell session, and the follow-up command printed
`WBT_RC2_AFTER_PYTHON`. No session restart, corruption or false ordinary
Command Card from REPL input was observed.

### Nested PowerShell — PASS

Commands:

```powershell
$WbtOuterPid = $PID
$env:WBT_RC2_NESTED = "preserved"
$WbtOuterCwd = (Get-Location).Path
$PID
$WbtOuterCwd
pwsh -NoLogo
Write-Output "WBT_RC2_NESTED_PWSH"
exit
$PID
$WbtOuterPid
$env:WBT_RC2_NESTED
(Get-Location).Path
$WbtOuterCwd
Write-Output "WBT_RC2_AFTER_NESTED"
```

Nested PowerShell entered and exited normally. The outer PID remained `6388`,
the environment value remained `preserved`, cwd remained `C:\Users\ROG`, and
`WBT_RC2_AFTER_NESTED` executed successfully. No session restart, corruption or
false structured Card from nested input was observed.

### Native Ctrl+C — FAIL

Command:

```powershell
ping 127.0.0.1 -t
```

Ctrl+C terminated the foreground process and the prompt recovered. The host
remained alive with PID `6388`, and the follow-up command
`Write-Output "WBT_RC2_AFTER_CTRL_C"` succeeded. However, ping output did not
refresh in real time; accumulated output appeared only after Ctrl+C. The
Command History also recorded the interrupted ping as `failed`, exit `0`,
`structured`, `19.21 s`, `1375/1375 bytes`. This is an observed anomaly and is
not treated as a pass.

### Not tested

- `vim + resize`: NOT YET TESTED (`vim` unavailable in the test environment)
- `fzf`: NOT YET TESTED (`fzf` unavailable in the test environment)

## Batch verdict

Python REPL: PASS
Nested PowerShell: PASS
Native Ctrl+C: FAIL
vim + resize: NOT YET TESTED
fzf: NOT YET TESTED
