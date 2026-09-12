# Task 1 — WBT Command Rail and Copy All

## Status

Implemented and committed from the isolated `codex/terminal-first` worktree. The protected primary checkout at `C:\Users\ROG_School\Downloads\myproject` was not written. No Go command, packaging command, Electron GUI run, or external Windows Terminal work was performed.

## Changed files

- `frontend/app/view/term/command-copy-all.ts` — shared authoritative Copy All operation. It gates on `canCopyOutput`, obtains output only from `CommandJournalService.GetOutput(record.id)`, applies `projectOutput`, writes exactly `command + "\n" + output`, and returns displayable output/clipboard failure reasons with no fallback.
- `frontend/app/view/term/command-copy-all.test.ts` — Copy All success and unsafe-record rejection tests.
- `frontend/app/view/term/command-navigation-rail.tsx` — compact confirmed-anchor rail, exact `commandId` Journal matching, stale request epoch, settling refresh, marker jump, and shared Copy All action.
- `frontend/app/view/term/command-navigation-rail.test.ts` — exact-id matching, stale epoch, and React/xterm source integration contract.
- `frontend/app/view/term/termwrap.ts` — public read-only confirmed-anchor snapshot/subscription API and exact marker scrolling; notifications occur on confirmed anchor, marker disposal, visual clear, and dispose.
- `frontend/app/view/term/visual-anchor.test.ts` — source-contract coverage for the xterm-bound API and lifecycle notifications.
- `frontend/app/view/term/term.tsx` — replaces the default `CommandHistory` mount with `CommandNavigationRail`; retained source is untouched as an available export.
- `frontend/app/view/term/command-history.tsx` and `.test.ts` — retained All action delegates to the shared Copy All operation.
- `frontend/app/view/term/term.scss` — narrow terminal-edge rail, mark, Copy All, and status presentation only.

## TDD evidence

1. Copy All success RED: `npm test -- --run frontend/app/view/term/command-copy-all.test.ts` failed because `copyCommandAndOutput` was absent. GREEN: the same command passed 1 test after the minimal operation was added.
2. Copy All trust gate RED: the unsafe-record test failed because the operation requested output before gating and returned the projection reason. GREEN: after the `canCopyOutput` early return, the same command passed 2 tests and proved neither output nor clipboard was called.
3. Rail exact-id RED: `npm test -- --run frontend/app/view/term/command-navigation-rail.test.ts` failed because `matchConfirmedAnchors` was absent. GREEN: it passed after the map keyed only by `record.id` was added.
4. Rail stale-response RED: the same test failed because `RailRequestEpoch` was absent. GREEN: it passed after epoch capture/bump/current semantics were added.
5. TermWrap API/lifecycle RED: `npm test -- --run frontend/app/view/term/visual-anchor.test.ts` failed for missing snapshot, subscription, exact scroll, and notification contracts. GREEN: it passed 6 tests after the registry-backed API was added.
6. Rail mount RED: the rail integration contract failed because `term.tsx` still mounted `CommandHistory`. GREEN: focused tests passed after the replacement mount and shared operation wiring.

## Commands and results

- `npm test -- --run frontend/app/view/term/command-copy-all.test.ts frontend/app/view/term/command-navigation-rail.test.ts frontend/app/view/term/visual-anchor.test.ts` — PASS, 3 files / 11 tests.
- `npm test -- --run frontend/app/view/term/command-history.test.ts frontend/app/view/term/terminal-ingress.test.ts` — PASS, 2 files / 21 tests.
- `npx vitest run` — PASS, 22 files / 88 tests. Existing test output included expected layout validation stderr and Sass deprecation warnings; no test failures.
- `npx tsc --noEmit --pretty false` — existing repository preview-mock errors remain (`defaultconfig`, `preview-electron-api`, `processviewer.preview`); `touched_type_errors=0` after filtering all task files.
- `npx eslint` for task files — exit 0; one pre-existing unused `blockId` warning in `term.tsx`.

## Self-review

- Anchor presentation comes exclusively from `visualAnchorCues` entries which also have a live `VisualAnchorRegistry.get(nonce)` confirmation. Journal rows are joined exclusively by exact `commandId` / `RecordView.id` equality.
- No command text, terminal rows, prompts, timestamps, proximity, quiet time, scrollback, second store, card list, persistence, OSC parser, CVA trust rule, Clear contract, PTY, hosted PowerShell, or external terminal integration was changed.
- A rail record only exposes Copy All when the established `canCopyOutput` trust gate permits it. Both active rail and retained history call the same operation.
- Async Journal updates are scoped by a request epoch that is bumped on terminal/block effect changes; intervals exist only while anchors lack a record or the authoritative record remains running/open.

## Concerns and acceptance boundary

- Unit tests validate the helper contracts and permitted source-level xterm/React integration seam. Electron/real xterm DOM, packaged-app, and real clipboard acceptance were not run and are not claimed.
- Repository-wide TypeScript remains blocked by unrelated preview mock errors listed above. No task-file TypeScript error remains.
- Prettier rewrote the four new files, but `prettier --check frontend/app/view/term/command-copy-all.test.ts` still reported that same test file non-idempotent under the repository formatter configuration; no broad formatting rewrite was applied to existing files.

## Fix round 1 — bounded rail polling

### Changed files

- `frontend/app/view/term/command-navigation-rail.tsx` — replaced the `records`-dependent React polling effect with `RailRecordPoller`. The controller owns one timer, suppresses overlapping requests, waits the complete 750ms interval after an unsettled response, stops on settled/empty-anchor state, invalidates stale responses through `RailRequestEpoch`, and queues one refresh for a confirmed-anchor change received while a request is in flight. `subscribeCommandAnchors` is a small lifecycle seam that forwards the current snapshot and returns the exact TermWrap unsubscribe function.
- `frontend/app/view/term/command-navigation-rail.test.ts` — added fake-timer tests for no early requery before 750ms, stopping after a settled matching record and after a subscription sends the empty snapshot, unsubscribing the listener, and a queued requery after an in-flight response is invalidated by an anchor change.

### Test command and output

- RED: `npm test -- --run frontend/app/view/term/command-navigation-rail.test.ts` failed with `RailRecordPoller` / `subscribeCommandAnchors` absent; the added in-flight-anchor test then failed with `expected spy to be called 2 times, but got 1 times` before the queued-refresh path was added.
- GREEN: `npm test -- --run frontend/app/view/term/command-navigation-rail.test.ts` — PASS, 1 file / 6 tests.
- `npm test -- --run frontend/app/view/term/command-copy-all.test.ts frontend/app/view/term/command-navigation-rail.test.ts frontend/app/view/term/visual-anchor.test.ts` — PASS, 3 files / 14 tests.
- `npm test -- --run frontend/app/view/term/command-history.test.ts frontend/app/view/term/terminal-ingress.test.ts` — PASS, 2 files / 21 tests.

### Self-review

- Successful Journal responses now update React presentation state only; they do not recreate an effect or start a new immediate request. The only ordinary repeat trigger is the controller timer at 750ms, and its `inFlight` guard prevents overlap.
- The poller is presentation-local and does not persist records or create a Journal/CVA store. Matching remains exact `commandId` / `RecordView.id`; anchor snapshots and subscription ownership remain TermWrap/CVA-backed.
- Empty anchor snapshots clear rendered records and stop the timer. Disposal bumps the epoch and clears the timer, so a late response cannot update a replacement terminal/block.
- Electron/xterm DOM and packaged acceptance remain unrun and are not claimed.

## Fix round 2 — response-driven settling delay

### Changed files

- `frontend/app/view/term/command-navigation-rail.tsx` — changed `RailRecordPoller` from a fixed `setInterval` to a one-shot `setTimeout`. The next timeout is created only after an unsettled response resolves, so the 750ms bound starts at response completion. Empty anchors, disposal, settled records, in-flight suppression, epoch invalidation, and queued anchor changes remain intact; an explicit anchor change also clears any pending timeout before its immediate refresh.
- `frontend/app/view/term/command-navigation-rail.test.ts` — added a deferred/slow-query fake-timer test that resolves the second unsettled response one millisecond before the old interval tick and proves no third query occurs until a full 750ms after that response. Existing instant polling, settled-stop, subscription-removal, and queued-anchor-change tests remain.

### Covering test commands and output

- RED: `npm test -- --run frontend/app/view/term/command-navigation-rail.test.ts` — 1 failing test; the deliberate slow-response test observed `expected "spy" to be called 2 times, but got 3 times` with the fixed interval.
- GREEN: `npm test -- --run frontend/app/view/term/command-navigation-rail.test.ts` — PASS, 1 file / 7 tests.
- `npm test -- --run frontend/app/view/term/command-copy-all.test.ts frontend/app/view/term/command-navigation-rail.test.ts frontend/app/view/term/visual-anchor.test.ts` — PASS, 3 files / 15 tests.
- `npm test -- --run frontend/app/view/term/command-history.test.ts frontend/app/view/term/terminal-ingress.test.ts` — PASS, 2 files / 21 tests.

### Self-review

- `RailRecordPoller` has no fixed interval: after each unsettled successful response, one timeout is scheduled for exactly `intervalMs`; its callback clears its handle before issuing the next request. A slow request therefore cannot be followed by a near-immediate fixed tick.
- `inFlight` still suppresses overlap, `RailRequestEpoch` rejects stale block/terminal or anchor-invalidated responses, and `pendingRefresh` preserves one immediate follow-up for an anchor change observed during an in-flight request.
- Settled output stops scheduling, an empty CVA-backed anchor snapshot clears records and cancels the timeout, and component cleanup unsubscribes and disposes the poller.
- Scope remains limited to the rail controller/test/report. Exact `commandId` matching, CVA/Journal authority, Copy All safety, and all brief non-goals are unchanged. Electron/xterm DOM, packaged, and GUI acceptance remain unrun.
