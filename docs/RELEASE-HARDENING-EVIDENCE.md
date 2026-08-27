# Release Hardening Evidence

This document records the Performance / Data / Security hardening pass for the
MVP foundation. The Conditional Architecture Freeze remains authoritative.

## Baseline and scope

- Baseline: `de75c8162a223e28417f3d7f2ccca5d939612aee`
- Scope: bounded history reads and refresh work, persistence/output failure
  behavior, and hosted sidechannel/token handling.
- No terminal authority, session, Runspace, CommandRecord, or Clear semantics
  were changed.

## Confirmed findings and fixes

### Performance

`ReadVisibleRecords` previously materialized every visible row on each frontend
refresh. It now asks SQLite for the newest 100 rows using the existing
`(wave_block_id, visibility_generation, started_at_ms)` index and restores
chronological order in memory. The frontend retains its 100-card presentation
bound. History refreshes also suppress overlapping requests; the existing
request epoch still rejects stale block/Clear responses.

Output remains lazy: ordinary history refreshes read metadata only. Output is
loaded only for an explicit card action and remains bounded by the existing
10 MiB durable limit and 64 KiB presentation limit.

### Data

Existing persistence evidence covers queue overflow, incomplete output
metadata, stale-running recovery, generation/Clear/Delete transactions,
restart reconciliation, and fail-closed output guarantees. No new data
authority or cache was introduced.

Stress regression: `TestReadVisibleRecordsIsBoundedToRecentHistory` inserts 150
records for one block and verifies that the product read returns exactly the
100 newest records in chronological order. Output payloads are not queried by
that read.

### Security

The hosted sidechannel remains loopback-bound, uses a per-runtime 256-bit
random token, authenticates the initial hello, and relies on the existing
host/runspace identity validation before Journal mutation. The new
`TestHostedSidechannelRejectsUnauthenticatedHello` regression verifies loopback
binding, token shape, and that an invalid token delivers no event.

Swap tokens, packed tokens, and full command strings containing token material
are no longer written to Wave logs. Token values are still passed only through
the existing process/environment paths.

## Areas already sufficiently covered

- bounded output queue/chunk/store limits
- output truncation and metadata reconciliation
- fail-closed persistence degradation and provenance
- authenticated hosted lifecycle and stale identity rejection
- Clear/Delete separation and session preservation
- xterm/PTY and hosted runtime authority boundaries

## Verification

- `go test ./pkg/commandjournal/... ./pkg/terminalruntime ./pkg/shellexec ./pkg/blockcontroller ./pkg/service/commandjournalservice/...`
- `go test -race ./pkg/commandjournal/... ./pkg/terminalruntime ./pkg/shellexec`
- `go vet ./pkg/commandjournal/... ./pkg/terminalruntime ./pkg/shellexec ./pkg/blockcontroller ./pkg/service/commandjournalservice/...`
- `npm test -- --run frontend/app/view/term/command-history.test.ts`
- `npx --no-install eslint frontend/app/view/term/command-history.tsx`
- `npm run build:dev`
- `git diff --check`

All commands passed in the release-hardening worktree.

## Remaining non-blocking gaps

- History beyond the bounded latest 100 requires a future explicit pagination
  product decision; no current product path requests it.
- Windows ACL/secure-storage policy is not part of the current architecture
  contract and was not introduced here.
- The upstream Wave PR condition remains unchanged; this pass does not merge or
  upgrade upstream.

## Architecture review status

No Architecture Review trigger was encountered. Frozen invariants are
preserved: Wave/ConPTY/xterm remains live authority, CommandRecord remains
product-owned and distinct from Wave Block, hosted execution remains one
authoritative Runspace, interactive output remains conservative, and durable
history remains independent of xterm scrollback and Wave term files.
