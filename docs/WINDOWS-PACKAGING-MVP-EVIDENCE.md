# Windows Packaging MVP Evidence

## Build

- Target: Windows x64 NSIS installer
- Artifact: `make/Windows Block Terminal-win32-x64-0.14.5.exe`
- Size: 237,610,664 bytes
- SHA-256: `59B5739542D9F05B1E20EDA468A7112CBE016AC5710537873EB96E811EBDFE65`
- Signing: unsigned MVP (no signing certificate was configured)
- Hosted runtime: self-contained publish closure included under `resources/hostedpwsh/win-x64`
- Update feed: no upstream Wave publish endpoint is configured; packaged builds skip auto-update when no downstream feed manifest exists.

## Install / startup evidence

The NSIS installer installed successfully in a disposable per-user directory. The installed tree contains `WindowsBlockTerminal.exe`, `resources/app.asar.unpacked/dist/bin/wavesrv.x64.exe`, and `resources/hostedpwsh/win-x64/WbtHostedPowerShell.exe`. The installed executable launched and created the downstream data directory; the runtime log showed wavesrv ready and the downstream updater was skipped because no update feed was configured.

## Installed product manual acceptance

Manual acceptance was completed on the installed packaged application on 2026-08-27. The user reported that the installed product behaved exactly as expected for the requested smoke sequence.

Verified manually:

- ordinary structured command `Write-Output "packaging-mvp-success"` displayed normally in xterm and produced the expected successful Command Card;
- authoritative Show Output and Copy Output matched the structured command output;
- direct native failure `cmd /c exit 7` produced the expected failed result with exit code `7` and the session remained usable;
- Clear Visual History removed the visible history while preserving the live PowerShell session/state and process identity;
- a durable command record created before full application exit was restored after restarting the installed application;
- restored Show Output / Copy Output remained correct after restart.

This closes the manual installed-product smoke and restart/persistence acceptance gaps for this artifact.

## Data safety

The installed product uses the downstream data identity `windows-block-terminal` rather than Wave's data directory. A disposable uninstall removed the installed application while a marker in `%LOCALAPPDATA%\\windows-block-terminal\\Data` remained, confirming that durable user data is not deleted by the default uninstaller.

## Reproducible hosted-runtime publish

- Source baseline: `5a7a7ab362bddde4d68b77eef7687c20f346f874`
- SDK: .NET 8.0.424, isolated at `%TEMP%\\wbt-packaging-closure\\dotnet`
- Command: `dotnet publish tools/hostedpwsh/WbtHostedPowerShell.csproj --configuration Release --runtime win-x64 --self-contained true --output dist/hostedpwsh/win-x64`
- Restore, build, and publish: exit code `0`
- Fresh executable: `dist/hostedpwsh/win-x64/WbtHostedPowerShell.exe`
- Fresh executable size: `152,064` bytes
- Fresh executable SHA-256: `CEAD5FF1139EFE0C986B9211F85EAA1916790A2B31F1B30FC0C42AB10668D112`
- Packaged copy SHA-256: `CEAD5FF1139EFE0C986B9211F85EAA1916790A2B31F1B30FC0C42AB10668D112`

## Upgrade rehearsal

- Installer A: `make/Installer-A-0.14.5.exe`, 237,610,664 bytes, SHA-256 `59B5739542D9F05B1E20EDA468A7112CBE016AC5710537873EB96E811EBDFE65`
- Installer B: `make/Windows Block Terminal-win32-x64-0.14.6.exe`, 237,610,728 bytes, SHA-256 `9AD6C6D7A1DF2A89420381FA8D509CF723CACEC420C061861E10CA1F121E1E68`
- Installation mode: Installer A was installed, then Installer B was applied with NSIS silent overlay (`/S`) to the same target without uninstalling A; installer exit code was `0`.
- Installed product registration after overlay: Windows Block Terminal `0.14.6`.
- The isolated data root was `%TEMP%\\wbt-packaging-closure\\upgrade-home`; the rehearsal did not use the normal user data directory.
- The upgraded application launched successfully and reported `wavesrv ready`.
- The installed Hosted PowerShell executable was present under `resources/hostedpwsh/win-x64` and its SHA-256 matched the fresh publish.
- No migration or recovery errors were observed during the overlay startup (routine command-journal migration checks completed normally).

## Durable history preservation after upgrade

Before the upgrade, the isolated database contained six real CommandRecord rows with IDs:

```text
578eb4ef8e324098b0e2b8e0d03d7db5-1
578eb4ef8e324098b0e2b8e0d03d7db5-2
578eb4ef8e324098b0e2b8e0d03d7db5-3
578eb4ef8e324098b0e2b8e0d03d7db5-4
578eb4ef8e324098b0e2b8e0d03d7db5-5
578eb4ef8e324098b0e2b8e0d03d7db5-6
```

After the A-to-B overlay, the same database contained seven rows. All six original IDs remained present, including `Write-Output "packaging-restart-persistence"` with its output metadata intact. The additional row was the A-version hosted-runtime check (`Write-Output "upgrade-a-hosted"`). No schema recovery or data-loss condition was observed.

## Remaining release gaps

- production code signing.

These are release-readiness gaps and do not invalidate the completed installed-product smoke, persistence/restart, uninstall, updater-isolation, or architecture-preservation evidence above.
