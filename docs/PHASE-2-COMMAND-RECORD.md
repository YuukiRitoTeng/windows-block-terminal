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

The Journal keeps execution and output lifecycles separate. `C` opens output
capture with unknown quality. `D` records execution success/exit code and moves
the record to execution `finished`, but leaves output `pending`; it does not
prove output completion. `P`, next `C`, epoch change, detach, or session close
only provide liveness for unresolved output. Without a proven causal fence,
the record closes as `unknown` / `incomplete` and later bytes are not guessed
into the previous command.

## Command Journal

`pkg/commandjournal` owns a thread-safe in-memory journal with one active
record per Wave block and completed records per block. A valid C creates a
running record with open output capture. Output segments are appended only
while that block has an active execution record. A matching D with success and
exit code finalizes execution; output finalization is independent and requires
a proven output boundary.
Output snapshots and record getters use defensive copies.

The Journal remains the product-owned domain boundary. The hosted structured
runtime now feeds it through the production adapter, while the existing
persistence seam stores the resulting records. This phase does not add a new
SQLite schema migration, final normalization policy, pagination API, or UI
projection.

## Production wiring

`ShellController` creates the PTY observer and the hosted structured consumer
before the shell process starts. Hosted sidechannel events are authenticated,
bound to one host/Runspace/command identity, and applied directly to the
controller-owned Journal. PTY observation remains asynchronous and does not
block the authoritative terminal path. On shell stop or read-loop termination,
both observers close fail-closed; any still-active record is recovered by the
existing termination fence.

## Deferred scope

Command Cards, final persistence schema/UX, output normalization, Clear Visual History,
crash/reconnect recovery, integration-loss recovery, advanced TUI/REPL
compatibility, and UI work remain future phases.
