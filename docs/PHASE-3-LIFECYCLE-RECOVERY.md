# Phase 3 — Abnormal Lifecycle Recovery

Phase 3 separates normal command completion from deterministic recovery. A
valid `D` produces a finished record with the real success and exit code. A
recovery fence produces an aborted record with an explicit reason and unknown
result; recovery never fabricates a failure exit code.

## CommandRecord contract

Records are `running`, `finished`, or `aborted`. Finished records have
`CompletionReason=normal`, non-nil `Success` and `ExitCode`, and the real D
hook sequence. Aborted records have a non-normal reason, nil `Success` and
`ExitCode`, and `FinishHookSequence=0`.

The supported recovery reasons are `missing_finish`, `superseded`,
`session_ended`, `controller_stop`, `pty_error`, and `epoch_changed`.

## Prompt boundary

PowerShell emits OSC 16162 `P` (`PromptReady`) after `D` and before the real
prompt text. Its versioned payload requires a non-empty `epoch` and positive
`seq`, and carries `cwd64`. The first prompt emits `M`, then `P`, then OSC 7.

If `P` arrives while a command is active, the decoder emits an internal
`CommandAborted(missing_finish)` before `PromptReady`. Prompt bytes after the
fence cannot be attributed to the aborted record.

## Decoder recovery fences

- A newer same-epoch `C` aborts the active command as `superseded`, then starts
  the new command.
- A valid new-epoch `M`, `P`, or `C` may reconcile an old active command as
  `epoch_changed` when the decoder is operating without the Phase 4 nested
  integration guard. Phase 4 tightens the active-command case: foreign
  M/P/C frames are ignored as nested control, while idle epoch adoption and
  ShellController-owned restart cleanup remain available.
- A foreign-epoch `D` is rejected and cannot change session identity.
- Aborted events are internal product events; they are never encoded as wire
  `D` frames.

## Backend termination

The PTY read loop owns final observer cleanup. It continues consuming final
bytes, unregisters the observer, closes and drains its accepted queue, and
only then aborts any still-active record with the deterministic termination
reason. Journal lifetime is controller-owned and survives observer detach so
an aborted record remains visible across a shell restart.

No timeout or watchdog infers command completion. Durable persistence,
reconnect persistence, UI, nested sessions, and other Phase 4+ concerns remain
deferred.
