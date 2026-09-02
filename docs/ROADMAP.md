# Roadmap

## Current position

Windows Block Terminal has moved beyond the original Phase 0–5 implementation plan.

The active main-line stage remains:

# Release Candidate Readiness Gate

The goal is to turn the current installable Windows MVP foundation / preview into a supportable release candidate without reopening settled architecture questions or adding unrelated features.

For current product direction, read `PRODUCT-DIRECTION.md` first.
For current project-state authority, read `PROJECT-STATUS.md`.

## Product-direction checkpoint

The project's architecture remains valid, but its presentation priority has been rebaselined.

The final default UX should be:

> **continuous terminal first + reliable block-aware functionality**

not:

> permanently visible Card-first Command History as the primary terminal experience.

The first Card-oriented Visual Productization pass is preserved as historical implementation and GUI evidence. Its default presentation direction is now marked **Legacy / Superseded**. Command Cards remain useful as an optional history/inspection projection.

This product-direction correction does **not** trigger Architecture Review.

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
9. First Windows Block Terminal Visual Productization pass with manual GUI acceptance — preserved as evidence; its permanent Card-first default is superseded by the current product direction.
10. Milestone 0 CVA final-leg closure with packaged frontend anchor/binding evidence.
11. Milestone 1 supported-configuration contract and finite RC matrix.

These checkpoints established the current MVP foundation. They do not by themselves constitute a signed, supported production release.

## Pre-freeze artifact-affecting closure

Before the next final RC candidate source freeze, batch together changes that alter final artifact bytes or behavior so packaged validation is not repeated unnecessarily.

This batch should include, as applicable:

- continuous-terminal UX closure;
- Command History / Cards reduced to optional inspector/presentation rather than permanent dominant UI;
- reliable Clear Visual History entry points;
- preservation of authoritative Copy All semantics;
- final product branding cleanup;
- updater/update-channel behavior;
- packaging configuration;
- runtime dependency changes;
- bundled assets;
- installer behavior.

Do not freeze and rebuild a release candidate after every small artifact-affecting change.

After this batch:

```text
freeze source + packaging configuration
→ build fresh Windows x64 candidate
→ sign with downstream release identity
→ verify signature and record final artifact hash
→ execute packaged RC revalidation on that exact signed artifact
→ publish/update release metadata
→ RC closure
```

## Current gate: Release Candidate Readiness

The RC gate closes remaining release-level uncertainty in seven areas.

### 1. Product-direction closure

Make the default product experience match `PRODUCT-DIRECTION.md`:

- live xterm is the primary continuous terminal surface;
- ordinary commands retain reliable logical record/output semantics;
- Copy All remains `command + only corresponding authoritative output`;
- Command History / Cards are optional inspector/projection UI rather than a permanent primary workspace;
- Clear Visual History remains available without resetting the session;
- visual distinction stays lightweight and functional;
- no direct in-terminal block action is exposed through heuristic row/text/prompt matching.

CVA now provides the causal binding for direct command-region actions to the
authoritative `CommandRecord`. Future in-terminal UI actions must consume and
preserve that binding; heuristic row/text/prompt mapping remains prohibited.

### 2. Supported configuration and runtime policy

The Milestone 1 support declaration and finite matrix are complete. Remaining
work is to revalidate the declared items on the final RC artifact and close any
explicitly blocking gaps, including:

- Windows 11 and PowerShell 7 support baseline;
- hosted-runtime default and fallback behavior;
- one-host / one-persistent-Runspace invariant;
- sidechannel loss/failure behavior;
- supported startup modes and explicit unsupported cases.

### 3. Interactive and recovery matrix

The finite M2A interactive matrix is complete on the packaged Windows target:
Python REPL, nested PowerShell, external `pwsh` fallback, native Ctrl+C, Vim
and alternate screen, fzf, localhost SSH, and resize/reflow. Interactive PTY
workloads retain conservative semantics; exact post-hoc output attribution is
not promised.

M2B remains for shell/runspace failure, sidechannel/frontend reconnect,
crash/recovery, durable-history recovery and backpressure. Each item must be
validated or explicitly excluded without weakening the existing authority
boundaries.

### 4. Release and support chain

Close the distribution path for a real release candidate:

- production code signing;
- reproducible signed artifact generation;
- update feed/channel policy;
- rollback policy;
- support and diagnostic expectations.

Do not silently reuse Wave release infrastructure or signing identity.

### 5. Performance and history-scale decision

Set explicit budgets and product decisions for:

- startup;
- memory;
- continuous-terminal scrolling;
- optional history inspection;
- long output;
- current 100-record visible-history limit;
- pagination / virtualization behavior.

The 100-record limit is currently an implementation/product decision, not an architecture invariant. Durable history may remain useful without becoming the primary visual workspace.

### 6. Data governance and legal closure

Document and validate:

- local data retention;
- destructive-delete behavior;
- ACL / local sensitive-data expectations;
- diagnostic/logging policy;
- privacy boundaries;
- Apache-2.0 / NOTICE / third-party attribution;
- brand attribution boundaries.

### 7. Product identity closure

Complete only the identity work required for a coherent Beta/RC:

- remove or reframe remaining user-facing Wave product surfaces where appropriate;
- preserve required legal attribution;
- make settings, errors and diagnostics coherent with Windows Block Terminal identity;
- validate HiDPI and multi-display presentation;
- validate the final continuous-terminal default UX in the packaged application.

Advanced visual effects are not a release blocker unless they fix a concrete usability issue.

## RC exit criteria

Release Candidate Readiness is complete only when:

1. The default presentation matches the continuous-terminal product direction while preserving trusted block-aware actions.
2. Supported configuration and runtime fallback behavior are explicit and verified.
3. Install, upgrade, restart, uninstall and durable-data preservation remain stable.
4. A reproducible signed Windows artifact exists.
5. Update/channel/rollback/support policy is documented and testable.
6. The target interactive/recovery matrix is PASS or explicitly scoped out.
7. Ordinary lifecycle, output-safety, persistence, Clear and frontend regressions remain green.
8. Performance budgets and history-scale behavior are explicit.
9. Privacy, retention, ACL, diagnostics, legal and brand boundaries are reviewed.
10. The architecture freeze remains preserved.
11. A release-level upstream rehearsal is rerun when a suitable final upstream merge/release baseline becomes available; until then the candidate verdict remains conditional and non-blocking.

## Upstream condition

The existing candidate rehearsal is sufficient for current development and remains **PASS WITH CONDITIONS**.

Do not treat the unmerged upstream candidate as a downstream dependency. When the relevant upstream work lands in a final merge/release baseline, repeat the established rehearsal policy against that final SHA.

## Explicitly not next

The RC gate and product-direction rebaseline are not permission to:

- implement a new ANSI/VT terminal emulator;
- replace Wave / ConPTY / xterm.js as live terminal authority;
- introduce synchronized dual PowerShell sessions;
- merge CommandRecord semantics into Wave Block;
- promote PTY heuristics to authoritative ordinary-command output;
- reconstruct authoritative copy from xterm scrollback;
- rewrite Wave core broadly;
- redesign schema or transport without release evidence;
- turn the terminal into a new card-per-command HTML renderer;
- add unrelated AI, cloud, sync, search or shell features;
- spend the stage on advanced shader/glass/animation polish;
- repeat already-passed Product Evidence work without a new trigger.

## Historical roadmap documents

Older Phase 0–5, Product Evidence, first Visual Productization and feasibility documents remain in the repository as historical design/evidence records. They explain how the architecture and product evidence were reached.

Their old "current phase", "next step" and final-UX statements are superseded when they conflict with:

1. `PRODUCT-DIRECTION.md` for product goal/presentation;
2. `PROJECT-STATUS.md` for current stage and priorities;
3. this roadmap for future sequencing;
4. `CONDITIONAL-ARCHITECTURE-FREEZE.md` for architecture responsibility/truth semantics.

Historical evidence should be preserved rather than rewritten to hide the old Card-first presentation.
