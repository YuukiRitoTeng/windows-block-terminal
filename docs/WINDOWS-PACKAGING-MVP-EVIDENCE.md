# Windows Packaging MVP Evidence

## Build

- Target: Windows x64 NSIS installer
- Artifact: `make/Windows Block Terminal-win32-x64-0.14.5.exe`
- Size: 185,156,313 bytes
- SHA-256: `3EEE83A1569455B2DD3A2B7344D8345ABCED58CEF71B2B506AC674CA3DFC2EF8`
- Signing: unsigned MVP (no signing certificate was configured)
- Hosted runtime: self-contained publish closure included under `resources/hostedpwsh/win-x64`
- Update feed: no upstream Wave publish endpoint is configured; packaged builds skip auto-update when no downstream feed manifest exists.

## Install / startup evidence

The NSIS installer installed successfully in a disposable per-user directory. The installed tree contains `WindowsBlockTerminal.exe`, `resources/app.asar.unpacked/dist/bin/wavesrv.x64.exe`, and `resources/hostedpwsh/win-x64/WbtHostedPowerShell.exe`. The installed executable launched and created the downstream data directory; the runtime log showed wavesrv ready and the downstream updater was skipped because no update feed was configured.

Interactive command-card smoke (ordinary success, native failure, Show/Copy actions, and Clear) was not automated in this CLI-only run and remains a manual acceptance step.

## Data safety

The installed product uses the downstream data identity `windows-block-terminal` rather than Wave's data directory. A disposable uninstall removed the installed application while a marker in `%LOCALAPPDATA%\\windows-block-terminal\\Data` remained, confirming that durable user data is not deleted by the default uninstaller.

Upgrade rehearsal was not run because only one version artifact was produced in this MVP build.

## Reproducibility note

The machine has no system .NET SDK. The bundled hosted runtime was taken from the previously verified self-contained Windows publish closure for the same source tree; the `Taskfile.yml` packaging target remains the canonical reproducible `dotnet publish` command for a packaging machine with the SDK installed.
