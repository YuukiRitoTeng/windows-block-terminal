# RC-EVIDENCE-3 Recovery Evidence Batch 2

## Candidate and environment

- Candidate ID: `RC-EVIDENCE-3`
- Product source SHA: `02980db4f921c39357f19f91326aad98ee2de7aa`
- Installer: `Windows Block Terminal-win32-x64-0.14.5.exe`
- Installer SHA-256: `0C388EDB436D5CCC9586938BDBF457F57C437A74A47D8F40076B1D55331B0344`
- Preserved artifact: `C:\Users\ROG\Downloads\WBT-RC-EVIDENCE\RC-EVIDENCE-3\Windows Block Terminal-win32-x64-0.14.5.exe`
- Disposable data: `C:\Users\ROG\AppData\Local\Temp\wbt-rc3-data-20260829-124505`
- Disposable config: `C:\Users\ROG\AppData\Local\Temp\wbt-rc3-config-20260829-124505`
- Installed executable: `C:\Users\ROG\AppData\Local\Programs\windows-block-terminal\WindowsBlockTerminal.exe`
- Configuration: Windows 11 x64, installed packaged application, packaged Hosted
  PowerShell runtime, PowerShell 7.6.4.

## Clear Visual History — PASS

Before Clear, the hosted PowerShell session recorded:

- PID: `32300`
- cwd: `C:\Users\ROG\AppData\Local\Temp\wbt-rc3-clear`
- `WBT_RC3_CLEAR=preserved`
- `WbtRc3ClearFn` returned `WBT_CLEAR_FUNCTION_OK`
- normal output and Command Cards were present

The product's real `Clear Visual History` action was used. It cleared the
Command History Cards and rendered terminal scrollback without exiting the app.
The terminal remained usable.

After Clear:

- `$PID` and `$WbtClearPid` were both `32300`;
- cwd remained `C:\Users\ROG\AppData\Local\Temp\wbt-rc3-clear`;
- the environment value remained `preserved`;
- `WbtRc3ClearFn` still returned `WBT_CLEAR_FUNCTION_OK`;
- `Write-Output "WBT_CLEAR_AFTER"` succeeded and created a new ordinary Card.

No shell, host or Runspace reconstruction or corruption was observed.

## Packaged app restart — PASS

Before shutdown, the following commands completed as successful structured
Cards in the installed RC3 application:

```powershell
Write-Output "WBT_RESTART_RECORD_A"
Write-Output "WBT_RESTART_RECORD_B"
Get-Location
```

The application was closed normally through the window close action. An initial
restart attempt using the obsolete
`C:\Users\ROG\AppData\Local\WBT-Upgrade-Rehearsal` working directory failed
before application launch because that directory no longer existed. This was a
test-harness path error, not a product restart failure.

The same disposable data/configuration environment then launched the actual
installed executable:

`C:\Users\ROG\AppData\Local\Programs\windows-block-terminal\WindowsBlockTerminal.exe`

After restart, the app launched normally, displayed `WBT hosted PowerShell
ready`, and Command History reported `persistence: available`. The finished
records `WBT_RESTART_RECORD_A`, `WBT_RESTART_RECORD_B` and `Get-Location` were
restored without duplication, conversion to running state, migration error,
recovery error or apparent data loss. The follow-up command:

```powershell
Write-Output "WBT_RESTART_AFTER"
```

created a successful structured Card with exit 0.

## Scope note

This batch validates normal packaged restart and finished-history restoration.
It does not validate unfinished active-command crash recovery; the separate
`App restart` row therefore remains `EVIDENCE EXISTS — REVALIDATION NEEDED`.
