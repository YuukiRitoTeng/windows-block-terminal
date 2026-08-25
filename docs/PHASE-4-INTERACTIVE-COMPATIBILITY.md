# Phase 4 — Interactive Terminal Compatibility

Phase 4 keeps the outer-command model. `vim`, `fzf`, `less`, `ssh`, REPLs,
nested shells, and full-screen terminal applications remain one top-level
CommandRecord while their input, terminal modes, and output stay on the
authoritative PTY/Wave/xterm path.

## Ownership and integration guards

The rendered PowerShell integration installs once per top-level process. It
sets `WAVETERM_SI_OWNER_PID` to the owner process PID and
`WAVETERM_SI_INSTALLED=1`. Re-sourcing in the same process is a no-op. A child
process that inherits the owner marker is also a no-op, so nested PowerShell
does not create a second epoch, prompt wrapper, Enter handler, or lifecycle
stream.

The PID marker is only an installation-suppression owner marker. It is never a
CommandID or SessionEpoch.

## Foreign epoch isolation

While a top-level command is active, valid OSC 16162 M/P/C frames from a
foreign epoch are treated as nested integration control and ignored by the
product decoder. They produce no IntegrationEvent, do not abort or replace the
outer record, and do not change the outer epoch or hook sequence. The control
frames remain invisible to product output while all non-control PTY bytes
continue through the raw terminal path. Foreign D remains rejected.

When no command is active, a validated M/P/C frame may still establish an idle
epoch. A real top-level restart is owned by ShellController lifecycle cleanup,
which creates a new observer/decoder.

## Terminal compatibility

Alternate-screen, cursor, mouse, bracketed-paste, ANSI/CSI, and OSC bytes are
not lifecycle signals. No terminal parser, screen reconstruction, input
interceptor, or frontend replacement is added. Deterministic ConPTY coverage
verifies alternate-screen bytes and a foreground key remain in one finished
outer record. Nested PowerShell output likewise remains inside one outer
record.

Durable persistence, remote command trees, structured REPL history, Command
Cards, UI work, packaging, and Phase 5+ features remain deferred.
