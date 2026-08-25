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
Direct native invocations preserve the native process exit code. PowerShell
commands and mixed pipelines use PowerShell success semantics and map to exit
code 0/1.

The backend decoder accepts BEL and ST terminators, split frames, stale and
mismatched D rejection, and unknown protocol versions without changing the
original bytes. Later Phase 3 recovery permits only validated M/P/C frames to
establish a new epoch; a foreign D can never switch session identity. Existing
Wave/frontend OSC handling remains intact.

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
physical multiline input, Ctrl+C, and terminal-path invariance. Shell crash,
reconnect, and integration-loss recovery are explicitly deferred. No product
domain work should begin until the required cases meet the Phase 1 Go/No-Go conditions in
`docs/PHASE-0-LANDING-DESIGN.md`.

## Local validation — 2026-08-25

### Automated CLI verified

- The helper/protocol CLI harness starts PowerShell 7, loads the current
  `pwsh_wavepwsh.sh` template, exercises the emit/completion helpers, captures
  stdout/stderr, and feeds the resulting byte stream through the existing
  `RuntimeAdapter` and decoder.
- A Windows-only CLI ConPTY test starts the real `pwsh.exe`, loads the same
  integration script, writes command characters and Enter through the PTY, and
  verifies the PSReadLine Enter hook, command buffer capture, real execution,
  and prompt completion boundary.
- Success and native failure (`cmd /c exit 7`) each produce exactly one C/D
  pair through the real interactive path. Physical multiline input also
  produces exactly one C/D pair with the complete command captured in START.
  PowerShell failure and pipeline semantics are covered by the helper/protocol
  harness.
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

### Runtime consumer registration

At the end of Phase 1, `RegisterOutputObserver` had no product consumer. Phase
2 and later remediation now provide a production `RuntimeObserver` and a
narrow backend service seam. This historical Phase 1 document does not claim
that the product read model or persistence UX is complete.

### Verdict

The Phase 1 feasibility contract is **GO**. No Command Journal, Command Card,
UI, Wave Block, ShellController loop, or xterm renderer work was added.
