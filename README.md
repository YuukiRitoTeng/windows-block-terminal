<div align="center">

<img src="public/logos/appicon-windows.png" width="96" alt="Windows Block Terminal" />

# Windows Block Terminal

**A continuous PowerShell terminal for Windows 11 — with reliable command-block actions layered on top.**

Windows 11 · x64 · PowerShell 7 · Apache-2.0

</div>

## What it is

Windows Block Terminal (WBT) is a Windows-first terminal. The live terminal stays the main surface: you get
one continuous PowerShell session, not a card-per-command replacement, and your shell keeps its own prompt,
history, completions and interactive programs.

What WBT adds is structure around the commands you already run. It recognises command boundaries inside that
continuous stream, so navigation, copying and clearing can act on *commands* rather than on screenfuls of
text — without asking you to change how you work.

## Highlights

- **Continuous terminal.** One live ConPTY session per pane, opened through your PowerShell 7 integration,
  with your normal interactive experience.
- **Command-aware navigation.** Move between the commands in the current session with Previous / Next and a
  navigation rail that tracks where you are.
- **Copy All.** Copies the current command's output as one block, using the terminal buffer with a journal
  fallback when a region is not readable on screen.
- **Clear visual history.** Clears what is displayed while keeping the PowerShell session itself intact and
  running.
- **Tabs, splits and workspaces.** Run several panes side by side and keep them across restarts.
- **Durable sessions.** Optional SSH session durability, so a session can survive a dropped connection or a
  sleep instead of ending with it.
- **Always Admin** (opt-in). When enabled, the application starts elevated so every shell it opens runs as
  administrator. See the notes below before using it.
- **Runs in the notification area.** Closing the last window hides it to the system tray instead of ending
  your sessions; use **Quit** from the tray to exit for real.

## Install

1. Download **`Windows-Block-Terminal-0.14.5-x64-Setup.exe`** from the
   [latest release](https://github.com/YuukiRitoTeng/windows-block-terminal/releases/latest).
2. Run it. It is a per-user install; installing does not require administrator rights.
3. Start **Windows Block Terminal** from the Start Menu.

**Requirements:** Windows 11 on x64, with PowerShell 7 (`pwsh`) available. Windows PowerShell 5.1 is
supported as a fallback shell, but PowerShell 7 is the intended experience.

### Verify your download

```
SHA-256  721240362F9263A6B87C89120D536741A893D4ACAB0D16F66E0706E382C26D5F
```

```powershell
Get-FileHash .\Windows-Block-Terminal-0.14.5-x64-Setup.exe -Algorithm SHA256
```

## This preview is unsigned

The installer and the application executable are **not** Authenticode-signed, and no publisher is claimed
for them. Because of that, Windows may show a SmartScreen or "unknown publisher" prompt when you run the
installer. That prompt is expected for an unsigned build. The SHA-256 above is published so you can confirm
that the file you downloaded is the file that was released.

## Status and known limitations

This is the **first public preview** (v0.14.5). It is usable day to day, but treat it as early software.

- **Windows x64 only.** This release ships one Windows x64 installer. There is no macOS or Linux package,
  and none is promised for this release.
- **No auto-update in this release.** Update by downloading the next release and running it. Release update
  metadata is published, but automatic updating is not offered as a capability of this release.
- **Unsigned build**, as described above.
- Interrupt handling in the bundled PowerShell integration is limited by the platform: ConPTY on Windows
  does not deliver Ctrl+C to the child process as an interrupt the way a classic console host does, so
  Ctrl+C inside the integrated shell can differ from a plain console window.
- Several features are opt-in and off by default, including durable sessions and Always Admin.

### Notes on Always Admin

Enabling Always Admin makes the whole application run elevated. Windows requires a UAC prompt for each
elevated start, and an elevated process cannot be de-elevated in place. While elevated, Explorer
drag-and-drop into the window stops working and mapped network drives are not visible. If your machine's
policy elevates without prompting, no prompt appears.

## Development

Building from source, packaging, and the internal architecture and phase documents live in
[`docs/`](docs/). Useful entry points:

- [`docs/PRODUCT-DIRECTION.md`](docs/PRODUCT-DIRECTION.md) — product goal and presentation direction
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture overview
- [`BUILD.md`](BUILD.md) — build and packaging instructions
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — roadmap and current status

## License and acknowledgements

Windows Block Terminal is licensed under **Apache-2.0** — see [`LICENSE`](LICENSE).

It is a downstream project built on the open-source **Wave Terminal** codebase, which is also Apache-2.0.
Upstream copyright, licence notices and third-party acknowledgements are preserved:

- [`NOTICE`](NOTICE) — upstream copyright notice
- [`ACKNOWLEDGEMENTS.md`](ACKNOWLEDGEMENTS.md) — third-party open-source components and licence report
