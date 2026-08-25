# Phase 2 — Command Record Vertical Slice

Phase 2 adds the first product-owned in-memory Command Journal without
changing Wave's terminal-session semantics.

## Identity

- `WaveBlockID` identifies the Wave terminal session and observer registration.
- `SessionEpoch` comes only from OSC 16162 lifecycle metadata/events.
- `CommandRecord.ID` is the lifecycle `CommandID`.

These identities are independent and are never substituted for one another.

## Ordered stream

`terminalruntime.Decoder.FeedOrdered` is the single OSC 16162 parser. It emits
ordinary output segments and validated integration events in their original
PTY byte order. Valid product control frames are removed from product output;
other terminal bytes remain ordinary output. `Feed` remains as the Phase 1
event-only compatibility API.

## Command Journal

`pkg/commandjournal` owns a thread-safe in-memory journal with one active
record per Wave block and completed records per block. A valid C creates a
running record. Output segments are appended only while that block has an
active record. A matching D with success and exit code finalizes the record.
Output snapshots and record getters use defensive copies.

This is an in-memory vertical slice. Persistence, normalization, pagination,
and UI projections are deferred.

## Production wiring

`ShellController` creates one runtime observer when a shell process starts and
registers it by `BlockId` before the PTY read loop consumes output. On shell
stop or read-loop termination, the observer unregisters and closes. The
observer copies/enqueues raw bytes; parsing and journal updates remain off the
PTY critical path.

## Deferred scope

Command Cards, persistence, output normalization, Clear Visual History,
crash/reconnect recovery, integration-loss recovery, advanced TUI/REPL
compatibility, and UI work remain future phases.
