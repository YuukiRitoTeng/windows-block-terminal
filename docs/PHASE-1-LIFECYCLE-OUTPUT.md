# Phase 1 — Command Lifecycle / Output Feasibility Gate

This phase adds only the feasibility seam. It does not create CommandRecord,
Command Journal persistence, Command Cards, UI, or a replacement terminal.

## Protocol

PowerShell 7 emits versioned OSC 16162 `C` (command started), `D` (command
finished), and `M` (shell metadata) envelopes. Each payload carries a session
epoch and monotonic hook sequence; command IDs are local to the shell epoch.
The PowerShell hook captures command text/cwd before acceptance and captures
`$?` plus `$LASTEXITCODE` at the prompt boundary. Native applications use
`$LASTEXITCODE`; PowerShell commands map success to `$?` and use exit code 0/1.

The backend decoder accepts BEL and ST terminators, split frames, duplicate and
foreign-epoch rejection, and unknown protocol versions without changing the
original bytes. Existing Wave/frontend OSC handling remains intact.

## Output seam

`blockcontroller.HandleAppendBlockFile` invokes a read-only observer immediately
before Wave file persistence. The observer receives the same raw byte slice and
must return quickly. `terminalruntime.OutputObserver` copies and queues bytes,
then decodes them asynchronously into ordered `OutputChunk` values. Wave's
terminal file, broker events, PTY loop, and xterm.js path remain authoritative
and unchanged.

`terminalruntime.RuntimeAdapter` exposes only product-neutral session, output,
and integration event types. It deliberately does not export Wave Block,
ShellController, PTY, RPC, file-store, or xterm types.

## Gate evidence and limits

Unit tests cover split/multiple OSC frames, BEL/ST framing, session/sequence
validation, and lossless ordering of accepted observer submissions. A static
test verifies that the PowerShell template contains the lifecycle hooks.
Interactive validation must run against the full Wave PTY on Windows 11 with
PowerShell 7 for successful/failed native commands, cmdlets, pipelines,
multiline input, Ctrl+C, shell crash, and integration loss. No product domain
work should begin until those cases meet the Phase 1 Go/No-Go conditions in
`docs/PHASE-0-LANDING-DESIGN.md`.
