# Roadmap

## Current position

Windows Block Terminal has moved beyond the original Phase 0–5 implementation plan.

The active main-line stage is now:

# Release Candidate Readiness Gate

The goal is to turn the current installable Windows MVP foundation / preview into a supportable release candidate without reopening settled architecture questions or adding unrelated features.

For current project-state authority, read `PROJECT-STATUS.md` first.

## Completed checkpoints

The following checkpoints are materially complete and should not be repeated without new evidence:

1. Backend feasibility and domain foundation.
2. Product Evidence Gate — **GO**.
3. Conditional Architecture Freeze — **KEEP**.
4. Candidate-based upstream maintainability rehearsal — **PASS WITH CONDITIONS**.
5. Performance / data / security hardening.
6. Windows Packaging MVP.
7. Reproducible hosted PowerShell publish from isolated .NET SDK.
8. Windows installer A → B in-place upgrade rehearsal with durable-history preservation.
9. First Windows Block Terminal Visual Productization pass with manual GUI acceptance.

These checkpoints established the current MVP foundation. They do not by themselves constitute a signed, supported production release.

## Current gate: Release Candidate Readiness

The RC gate closes remaining release-level uncertainty in six areas.

### 1. Supported configuration and runtime policy

Define and verify the supported product configuration, including:

- Windows 11 and PowerShell 7 support baseline;
- hosted-runtime default and fallback behavior;
- one-host / one-persistent-Runspace invariant;
- sidechannel loss/failure behavior;
- supported startup modes and explicit unsupported cases.

### 2. Interactive and recovery matrix

Create a finite release-target matrix and either PASS or explicitly exclude each target.

The matrix should cover the release-relevant subset of:

- `vim`;
- `fzf`;
- `ssh`;
- nested PowerShell;
- representative REPL/TUI workloads;
- alternate screen;
- resize/reflow;
- shell crash;
- reconnect / integration loss;
- backpressure / long-running output.

Do not promise exact post-hoc interactive output unless independently proven.

### 3. Release and support chain

Close the distribution path for a real release candidate:

- production code signing;
- reproducible signed artifact generation;
- update feed/channel policy;
- rollback policy;
- support and diagnostic expectations.

Do not silently reuse Wave release infrastructure or signing identity.

### 4. Performance and history-scale decision

Set explicit budgets and product decisions for:

- startup;
- memory;
- history scrolling;
- long output;
- current 100-record visible-history limit;
- pagination / virtualization behavior.

The 100-record limit is currently an implementation/product decision, not an architecture invariant.

### 5. Data governance and legal closure

Document and validate:

- local data retention;
- destructive-delete behavior;
- ACL / local sensitive-data expectations;
- diagnostic/logging policy;
- privacy boundaries;
- Apache-2.0 / NOTICE / third-party attribution;
- brand attribution boundaries.

### 6. Product identity closure

Complete only the identity work required for a coherent Beta/RC:

- remove or reframe remaining user-facing Wave product surfaces where appropriate;
- preserve required legal attribution;
- make settings, errors and diagnostics coherent with Windows Block Terminal identity;
- validate HiDPI and multi-display presentation.

Advanced visual effects are not a release blocker unless they fix a concrete usability issue.

## RC exit criteria

Release Candidate Readiness is complete only when:

1. Supported configuration and runtime fallback behavior are explicit and verified.
2. Install, upgrade, restart, uninstall and durable-data preservation remain stable.
3. A reproducible signed Windows artifact exists.
4. Update/channel/rollback/support policy is documented and testable.
5. The target interactive/recovery matrix is PASS or explicitly scoped out.
6. Ordinary lifecycle, output-safety, persistence, Clear and frontend regressions remain green.
7. Performance budgets and history-scale behavior are explicit.
8. Privacy, retention, ACL, diagnostics, legal and brand boundaries are reviewed.
9. The architecture freeze remains preserved.
10. A release-level upstream rehearsal is rerun when a suitable final upstream merge/release baseline becomes available; until then the candidate verdict remains conditional and non-blocking.

## Upstream condition

The existing candidate rehearsal is sufficient for current development and remains **PASS WITH CONDITIONS**.

Do not treat the unmerged upstream candidate as a downstream dependency. When the relevant upstream work lands in a final merge/release baseline, repeat the established rehearsal policy against that final SHA.

## Explicitly not next

The RC gate is not permission to:

- implement a new ANSI/VT terminal emulator;
- replace Wave / ConPTY / xterm.js as live terminal authority;
- introduce synchronized dual PowerShell sessions;
- merge CommandRecord semantics into Wave Block;
- promote PTY heuristics to authoritative ordinary-command output;
- rewrite Wave core broadly;
- redesign schema or transport without release evidence;
- add unrelated AI, cloud, sync, search or shell features;
- spend the stage on advanced shader/glass/animation polish;
- repeat already-passed Product Evidence work without a new trigger.

## Historical roadmap documents

Older Phase 0–5 and feasibility documents remain in the repository as historical design/evidence records. They explain how the architecture was reached, but their old "current phase" and "next step" statements are superseded by `PROJECT-STATUS.md` and this roadmap.

The architecture responsibilities and truth semantics remain governed by `CONDITIONAL-ARCHITECTURE-FREEZE.md`.
