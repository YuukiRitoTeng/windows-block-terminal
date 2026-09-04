# Roadmap

## Current position

Windows Block Terminal has moved beyond the original Phase 0–5 implementation plan.

The active main-line stage remains:

# Release Candidate Readiness Gate

The goal is to turn the current installable Windows MVP foundation / preview into a supportable release candidate without reopening settled architecture questions or adding unrelated features.

For current strategic sequencing, priority, evidence discipline, smart-model checkpoints and manual Windows gates, read `RC-STRATEGIC-REBASELINE.md` first.
For current product direction, read `PRODUCT-DIRECTION.md`.
For current project-state authority, read `PROJECT-STATUS.md`.
For architecture truth semantics, read `CONDITIONAL-ARCHITECTURE-FREEZE.md`.
For the release acceptance inventory, read `RC-READINESS-GATE.md`.

Older M3/M4/M5/M6 labels may still be useful when reading historical plans, but they are no longer the controlling forward framework. The controlling route is the five-stage RC closure sequence defined below and in `RC-STRATEGIC-REBASELINE.md`.

## Product-direction checkpoint

The project's architecture remains valid, but its presentation priority has been rebaselined.

The final default UX should be:

> **continuous terminal first + reliable block-aware functionality**

not:

> permanently visible Card-first Command History as the primary terminal experience.

The first Card-oriented Visual Productization pass is preserved as historical implementation and GUI evidence. Its default presentation direction is now marked **Legacy / Superseded**. Command Cards remain useful as an optional history/inspection projection.

This product-direction correction does **not** trigger Architecture Review.

## Completed checkpoints

The following checkpoints are materially complete and should not be repeated without new evidence or an exact-final-candidate revalidation requirement:

1. Backend feasibility and domain foundation.
2. Product Evidence Gate — **GO**.
3. Conditional Architecture Freeze — **KEEP**.
4. Candidate-based upstream maintainability rehearsal — **PASS WITH CONDITIONS**.
5. Performance / data / security hardening foundation.
6. Windows Packaging MVP.
7. Reproducible hosted PowerShell publish from isolated .NET SDK.
8. Windows installer A → B in-place upgrade rehearsal with durable-history preservation.
9. First Windows Block Terminal Visual Productization pass with manual GUI acceptance — preserved as evidence; its permanent Card-first default is superseded by the current product direction.
10. Milestone 0 CVA final-leg closure with packaged frontend anchor/binding evidence.
11. Milestone 1 supported-configuration contract and finite RC matrix.
12. M2A finite packaged interactive compatibility closure.
13. M2B deterministic and packaged recovery closure, including hosted/runspace failure, authenticated sidechannel disconnect, bounded backpressure, frontend reconnect, crash/recovery and durable-history recovery.

These checkpoints established the current MVP foundation. They do not by themselves constitute a signed, supported production release.

Historical M0/M1/M2 labels describe completed evidence work. Historical M3/M4/M5/M6 labels may be used as cross-references, but the current forward route is now rebaselined around the RC gate.

## Current strategic sequence

### Stage 1 — Pre-freeze product / UX / identity closure

Finish all artifact-affecting changes before the final source/package freeze:

- continuous-terminal UX closure;
- Command History / Cards reduced to optional inspector/presentation rather than permanent dominant UI;
- reliable Clear Visual History entry points;
- preservation of authoritative Copy All semantics;
- direct in-terminal actions consuming the completed CVA binding;
- final product branding / remaining Wave-derived user-facing surface cleanup;
- settings / diagnostics / error-recovery presentation;
- final hosted-runtime default/fallback behavior that changes product behavior;
- packaging configuration, runtime dependencies, bundled assets and installer/updater behavior that affect final artifact identity.

Do not assume code changes are required. Audit first; if current main already satisfies a requirement, record evidence instead of manufacturing work.

Close this stage with targeted automated checks and a packaged Windows validation for the final product behavior after artifact-affecting work is complete.

### Stage 2 — Performance / data / privacy / legal closure

Define and verify release commitments for:

- startup;
- memory;
- continuous-terminal scrolling;
- optional history inspection;
- long output;
- current 100-record visible-history limit;
- pagination / virtualization behavior;
- local data retention and destructive deletion;
- ACL / local sensitive-data expectations;
- diagnostics / logging / privacy boundaries;
- Apache-2.0 / NOTICE / third-party attribution;
- final brand-attribution boundaries.

Use deterministic automated evidence where possible. Reserve manual Windows checks for UI, ACL or environment behavior that automation cannot credibly prove.

### Stage 3 — Release / support chain closure

Close the distribution path for a real release candidate:

- production signing identity;
- reproducible signed artifact generation;
- signature verification;
- update feed/channel policy and implementation/scope decision;
- rollback policy;
- install / upgrade / uninstall / update lifecycle;
- support, diagnostics and recovery expectations.

Do not silently reuse Wave release infrastructure or signing identity.

### Stage 4 — Final source freeze + exact candidate revalidation

After all artifact-affecting work is complete:

```text
freeze source + packaging configuration
→ build fresh Windows x64 candidate
→ sign with downstream release identity
→ verify signature and record exact artifact hashes/provenance
→ execute finite packaged RC revalidation on that exact signed artifact
→ rerun upstream rehearsal if a suitable final upstream baseline exists
```

All release-level PASS claims must ultimately point to the exact declared candidate artifact and supported configuration.

Historical M2A/M2B evidence remains valid for its recorded artifact identities, but do not treat it as exact-final-candidate proof. Revalidate the required finite set once against the final candidate; do not rerun closed M2 evidence repeatedly before then.

### Stage 5 — RC decision / beta-support handoff

Apply the RC exit policy and prepare controlled distribution:

- final RC go/no-go decision;
- publish/update metadata where applicable;
- rollback/support runbook;
- Beta feedback and issue triage;
- explicit separation of deferred work from release claims.

## Pre-freeze artifact-affecting discipline

Before the final RC candidate source freeze, batch together changes that alter final artifact bytes or behavior so packaged validation is not repeated unnecessarily.

Do not freeze and rebuild a release candidate after every small artifact-affecting change.

Policy-only documentation can proceed in parallel, but it must be settled before the final candidate is declared.

## Current gate: Release Candidate Readiness

The RC gate closes remaining release-level uncertainty in the following areas.

### Product-direction closure

Make the default product experience match `PRODUCT-DIRECTION.md`:

- live xterm is the primary continuous terminal surface;
- ordinary commands retain reliable logical record/output semantics;
- Copy All remains `command + only corresponding authoritative output`;
- Command History / Cards are optional inspector/projection UI rather than a permanent primary workspace;
- Clear Visual History remains available without resetting the session;
- visual distinction stays lightweight and functional;
- no direct in-terminal block action is exposed through heuristic row/text/prompt matching.

CVA now provides the causal binding for direct command-region actions to the authoritative `CommandRecord`. Future in-terminal UI actions must consume and preserve that binding; heuristic row/text/prompt mapping remains prohibited.

### Supported configuration and runtime policy

The supported-configuration declaration and finite matrix are complete. Remaining work is to revalidate the declared items on the exact final RC artifact and close any explicitly blocking gaps, including:

- Windows 11 and PowerShell 7 support baseline;
- hosted-runtime default and fallback behavior;
- one-host / one-persistent-Runspace invariant;
- sidechannel loss/failure behavior;
- supported startup modes and explicit unsupported cases.

### Interactive and recovery matrix

The finite M2A interactive matrix is complete on its validated packaged Windows target: Python REPL, nested PowerShell, external `pwsh` fallback, native Ctrl+C, Vim and alternate screen, fzf, localhost SSH, and resize/reflow. Interactive PTY workloads retain conservative semantics; exact post-hoc output attribution is not promised.

M2B recovery validation is **COMPLETE — PASS** for shell/runspace failure, authenticated sidechannel disconnect, frontend reconnect, crash/recovery, durable-history recovery and bounded backpressure. The evidence preserves the existing authority boundaries and represents interrupted work conservatively; it does not promise transparent continuation or exact retrospective attribution for interactive PTY workloads.

These finite M2A/M2B gates are closed for the current engineering stage. They are re-run only when required for exact-final-candidate RC evidence.

### Release and support chain

Close the distribution path for a real release candidate as described in Stage 3.

### Performance and history-scale decision

Set explicit budgets and product decisions as described in Stage 2.

The 100-record limit is currently an implementation/product decision, not an architecture invariant. Durable history may remain useful without becoming the primary visual workspace.

### Data governance and legal closure

Close retention, delete behavior, ACL, diagnostics/privacy, legal/NOTICE/third-party and attribution boundaries as described in Stage 2.

### Product identity closure

Complete only the identity work required for a coherent Beta/RC:

- remove or reframe remaining user-facing Wave product surfaces where appropriate;
- preserve required legal attribution;
- make settings, errors and diagnostics coherent with Windows Block Terminal identity;
- validate HiDPI and multi-display presentation;
- validate the final continuous-terminal default UX in the packaged application.

Advanced visual effects are not a release blocker unless they fix a concrete usability issue.

## Smart-model checkpoints

Use a strong model only when:

- a proposed change would alter a frozen authority/trust boundary;
- product, data or release policy choices have materially conflicting trade-offs;
- signing identity, update channel, rollback or support policy must be frozen;
- final-candidate evidence conflicts with the architecture or current product contract;
- ordinary implementation cannot converge on a bounded seam;
- final upstream rehearsal reveals unexpected product-domain coupling.

Do not use a strong model for routine implementation, tests, lint, packaging diagnostics or log analysis.

## Manual Windows gates

Use isolated packaged Windows 11 x64 validation for behavior automation cannot credibly prove, including:

- final continuous-terminal presentation;
- final hosted-runtime readiness/fallback behavior;
- required finite M2A/M2B exact-candidate revalidation;
- install / upgrade / uninstall / update / rollback;
- signature verification;
- visual, PTY, resize, HiDPI/multi-display or ACL behavior where applicable.

Do not create permanent one-off validation infrastructure solely to reproduce already-closed historical gates.

## RC exit criteria

Release Candidate Readiness is complete only when:

1. The default presentation matches the continuous-terminal product direction while preserving trusted block-aware actions.
2. Supported configuration and runtime fallback behavior are explicit and verified.
3. Install, upgrade, restart, uninstall and durable-data preservation remain stable.
4. A reproducible signed Windows artifact exists.
5. Update/channel/rollback/support policy is documented and testable.
6. The target interactive/recovery matrix is PASS or explicitly scoped out on the exact final candidate as required by RC policy.
7. Ordinary lifecycle, output-safety, persistence, Clear and frontend regressions remain green.
8. Performance budgets and history-scale behavior are explicit.
9. Privacy, retention, ACL, diagnostics, legal and brand boundaries are reviewed.
10. The architecture freeze remains preserved.
11. A release-level upstream rehearsal is rerun when a suitable final upstream merge/release baseline becomes available; until then the candidate verdict remains conditional and non-blocking.
12. Required release evidence is tied to the exact final signed candidate and supported configuration.

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
- repeat already-passed Product Evidence or closed M2 work without a new exact-candidate requirement;
- expand the current RC to unsupported platforms or primary shell configurations;
- promise exact retrospective attribution for interactive workloads.

## Historical roadmap documents

Older Phase 0–5, Product Evidence, first Visual Productization, M0/M1/M2 and feasibility documents remain in the repository as historical design/evidence records. They explain how the architecture and product evidence were reached.

Their old "current phase", "next step", M3/M4/M5/M6 sequencing and final-UX statements are superseded when they conflict with:

1. `RC-STRATEGIC-REBASELINE.md` for current forward sequencing and execution discipline;
2. `PRODUCT-DIRECTION.md` for product goal/presentation;
3. `PROJECT-STATUS.md` for current project state;
4. `CONDITIONAL-ARCHITECTURE-FREEZE.md` for architecture responsibility/truth semantics;
5. `RC-READINESS-GATE.md` for release acceptance evidence status.

Historical evidence should be preserved rather than rewritten to hide the old Card-first presentation or earlier milestone language.
