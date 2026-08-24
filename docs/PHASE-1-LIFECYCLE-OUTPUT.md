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

## Local validation — 2026-08-24

### Unit verified

- `go test ./pkg/terminalruntime` — passed.
- `go test ./pkg/util/shellutil/shellintegration` — passed.
- `go test -race ./pkg/terminalruntime ./pkg/util/shellutil/shellintegration` — passed.
- `go vet ./pkg/terminalruntime ./pkg/util/shellutil/shellintegration` — passed.
- PowerShell parser validation of the templated integration script — passed.
- PowerShell helper execution produced a real OSC 16162 `D` frame — passed.

`go test ./pkg/blockcontroller` was attempted locally. It could not complete
because the machine could not download the existing, pinned Go dependencies
from `proxy.golang.org`; no dependency versions were changed.

### Local runtime verified

None. The full Electron + wavesrv + PTY + xterm.js runtime was not started in
this validation pass, so no ordinary command, native failure, PowerShell
failure, pipeline, multiline, consecutive-command, or Ctrl+C case is claimed
as runtime-verified.

### Runtime prerequisites found

The repository's official Windows development commands are `task dev` (Vite
development server) and `task start` (standalone Electron). `BUILD.md` requires
Task, Zig for Windows CGO builds, Node.js 22 LTS, and the normal locked
dependencies. This machine currently has no `task`, no `zig`, no `node_modules`
or built `dist/bin` artifacts, and reports Node.js `v24.13.0`. Network access
to the Go module proxy also failed. No installation, upgrade, or build-system
change was performed.

### Not tested yet

- Real PowerShell 7 C/D counts and metadata inside Wave.
- Native `cmd /c exit 7` exit-code propagation.
- PowerShell failure `$?` mapping.
- Pipeline single-lifecycle behavior.
- PSReadLine multiline behavior.
- Consecutive command output ownership and `OutputChunk.Sequence` in a live PTY.
- Ctrl+C recovery and subsequent lifecycle pairing.
- xterm.js behavior under the new observer in a live Electron session.

### Known limitation and verdict

The implementation remains a Phase 1 feasibility candidate, not a completed
GO gate. Because the full local runtime could not be launched, the official
verdict remains **NO-GO / runtime validation blocked**. No Command Journal,
Command Card, UI, Wave Block, ShellController loop, or xterm renderer work was
added.
