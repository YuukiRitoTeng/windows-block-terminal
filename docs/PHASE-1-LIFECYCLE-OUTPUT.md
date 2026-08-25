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

## Local validation — 2026-08-25

### Automated CLI verified

- A CLI integration harness starts PowerShell 7, loads the current
  `pwsh_wavepwsh.sh` template, emits the same versioned OSC 16162 envelopes,
  captures stdout/stderr, and feeds the resulting byte stream through the
  existing `RuntimeAdapter` and decoder.
- Success, native failure (`cmd /c exit 7`), PowerShell failure, pipeline, and
  multiline scriptblock cases each produce exactly one C/D pair.
- Command IDs are paired, the session epoch is stable, hook sequences are
  strictly monotonic, and native exit code 7 is preserved.
- Multiple captured chunks have strictly increasing `OutputChunk.Sequence`
  values.
- Existing decoder tests continue to cover split markers, multiple markers,
  BEL/ST terminators, plain bytes, malformed frames, unknown versions, and
  stale/foreign sequences.

### Manual real Wave PTY verified

- The user verified ordinary commands, pipelines, multiline input, consecutive
  commands, Ctrl+C recovery, and the subsequent command in a real Wave PTY.
- xterm.js and PTY surface behavior showed no regression.

### Not in Phase 1 scope

- vim, ssh, fzf, REPL, nested PowerShell, crash/reconnect, and integration-loss
  recovery remain later-phase compatibility work.

### Deferred to later phases

- shell crash and reconnect recovery
- integration-loss recovery
- background output attribution
- vim, ssh, fzf, Python REPL, and nested PowerShell compatibility
- Command Journal persistence
- Command Cards

### Known limitation

The CLI harness cannot reproduce PSReadLine's physical Enter-key acceptance
boundary. Multiline lifecycle semantics are verified for a real PowerShell
multiline scriptblock and separately covered by the user's manual Wave PTY
verification; physical PSReadLine editing remains manual evidence.

### Verdict

The Phase 1 feasibility contract is **GO**. No Command Journal, Command Card,
UI, Wave Block, ShellController loop, or xterm renderer work was added.
