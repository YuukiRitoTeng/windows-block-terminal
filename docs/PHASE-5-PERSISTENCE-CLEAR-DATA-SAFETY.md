# Phase 5 — Persistence / Clear / Data Safety

Phase 5 establishes product-owned command history persistence without changing
Wave's terminal-session model.

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

## Recovery and visibility

Running rows found at startup are completed as `aborted` with reason
`app_restart_recovery`, retaining their stored output. Clear advances a durable
visibility generation in O(1) and leaves the shell, PTY, and active command
intact. Delete History removes finished/aborted rows with foreign-key cascade,
while preserving a running row in the new generation.

The frontend exposes only a narrow `TermWrap.clearVisualBuffer()` seam. It
clears rendered xterm state and does not restart or truncate the shell session.
