# Phase 5 — Persistence / Clear / Data Safety

Phase 5 establishes product-owned command history persistence without changing
Wave's terminal-session model.

This phase is a backend foundation, not a completed product history surface.
The next remediation adds the narrow product read/control seam and makes
recorder lag, output incompleteness and persistence health observable.

## Ownership and storage

The journal is stored as `command-journal.sqlite` beneath Wave's existing user
data directory (`wavebase.GetWaveDataDir()`). Schema migrations are embedded
and applied with the repository's existing `migrateutil`/golang-migrate path.
Command records and output chunks are separate tables; output is chunked and
bounded to the configured per-command limit (10 MiB by default).

## Runtime safety

The journal uses one FIFO writer and an explicit `Flush`/`Close` barrier. PTY
observation only enqueues events. Persistence failures mark the store
degraded and are logged; they never terminate the shell or delete existing
data. Persistence can be disabled through `Options.Enabled`.

Production shutdown waits for controller cleanup and then calls
`persistence.CloseDefault()`, which drains and closes the process-wide writer.

## Recovery and visibility

Running rows found at startup are completed as `aborted` with reason
`app_restart_recovery`, retaining their stored output. Clear advances a durable
visibility generation in O(1) and leaves the shell, PTY, and active command
intact. Delete History removes finished/aborted rows with foreign-key cascade,
while preserving a running row in the new generation.

The frontend exposes only a narrow `TermWrap.clearVisualBuffer()` seam. It
clears rendered xterm state and does not restart or truncate the shell session.

The seam is not yet a product Clear command. Product orchestration must advance
the Journal generation and clear the rendered xterm state without truncating
the Wave terminal stream.

The persistence layer supports disabled mode through `Options.Enabled`. Phase 5
production wiring defaults persistence to enabled; no user-facing settings
toggle is introduced in this phase.
