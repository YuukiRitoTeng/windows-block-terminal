# Project Status — Release Candidate Rebaseline

Status date: 2026-08-28  
Reconciliation baseline: `0abf1bda753dbfe9a55f2e878fa88029529fa504`  
Strategic verdict: **REFRAME NEXT STAGE**

## Authority scope

This document is the current authority for **project state, roadmap position and next-stage priority**.

It does not replace `CONDITIONAL-ARCHITECTURE-FREEZE.md`, which remains the architecture authority for responsibility boundaries and truth semantics.

If an older roadmap, Phase document, README section or status paragraph says the project is still in Phase 0–5, Product Evidence Gate preparation, upstream rehearsal, packaging preparation or first visual productization, that status is historical and this document wins.

## Where the project actually is

Windows Block Terminal is now an **installable Windows MVP foundation / preview**.

Merged evidence and implementation cover:

- Product Evidence Gate Stage 1–7;
- Conditional Architecture Freeze;
- one hosted PowerShell process with one persistent Runspace;
- authenticated ordinary-command structured lifecycle/output;
- product-owned Command Journal and SQLite persistence;
- trusted-output provenance / completeness / text-safety gating;
- Clear Visual History with session preservation;
- performance / data / security hardening;
- Windows x64 packaging, installation, uninstall and durable data preservation;
- isolated reproducible hosted-runtime publish;
- Installer A → B in-place upgrade rehearsal with durable-history preservation;
- first Windows Block Terminal visual productization pass and manual GUI acceptance.

The project is **not** yet a production-ready release.

## Roadmap alignment

The architecture route remains valid. The state baseline was stale.

Historical phase names should now be read as completed evidence checkpoints rather than the active development state:

- Phase 0–5: feasibility, runtime/domain foundation and remediation — materially completed;
- Product Evidence Gate — GO;
- Conditional Architecture Freeze — KEEP;
- Phase 6 candidate upstream rehearsal — PASS WITH CONDITIONS;
- Phase 7 hardening / Windows packaging foundation — materially completed;
- Phase 8 first visual productization — completed as a first pass, not final Beta identity closure;
- Phase 9 production release — not completed.

No current evidence requires reopening Architecture Review.

## Architecture check

The following remain supported by current code and evidence:

- Wave / ConPTY / xterm.js is the authoritative live terminal path;
- `CommandRecord` remains separate from Wave Block;
- Hosted PowerShell uses one host process and one persistent Runspace;
- ordinary structured output is sourced from the authenticated hosted sidechannel;
- PTY/xterm remains the live presentation path;
- interactive output remains conservative and non-exact unless independently proven;
- execution completion, output attribution and output completion remain separate;
- trusted output remains gated by provenance, completeness and safety metadata;
- durable product history does not depend on xterm scrollback or Wave terminal files;
- Clear Visual History preserves shell / PTY / Runspace / session state.

Architecture Review is **not triggered**.

## Proven / completed

The following have direct repository or manual evidence sufficient for the current MVP foundation:

- structured ordinary PowerShell command lifecycle;
- direct native failure and PowerShell failure semantics;
- mixed-pipeline whole-command success semantics;
- output provenance / completeness / text-safety gate;
- durable Command History and restart restore;
- Clear Visual History state preservation;
- bounded 100-record visible history and lazy bounded output projection;
- Windows x64 hosted-runtime publish;
- Windows installer build, install, uninstall and in-place upgrade;
- durable-history preservation across installer upgrade;
- first independent Windows Block Terminal window/Card visual identity;
- candidate-based upstream rehearsal with clean merge, expected seam locality and no new Wave→product dependency.

## Conditionally stable / implementation detail

These are current implementation choices, not permanent protocol or product contracts:

- packaged Windows hosted-runtime auto-enable strategy;
- loopback transport details;
- frontend polling/refresh mechanism;
- SQLite schema/chunk details;
- RPC/read-model details;
- 100-record presentation limit;
- pagination / virtualization strategy;
- current visual treatment;
- installer/updater implementation details;
- final hosted-runtime default/fallback policy.

They may evolve while preserving the Conditional Architecture Freeze.

## Still open

### Compatibility / recovery evidence

Still insufficiently proven as a release-level matrix:

- vim / fzf / ssh / nested PowerShell / broader REPL-TUI behavior;
- alternate-screen and resize/reflow stress;
- shell crash, reconnect, integration loss and backpressure;
- all startup modes and hosted-runtime fallback behavior;
- background output attribution and exact interactive-copy semantics.

### Release gaps

- production code signing;
- release/update feed, channel, rollback and support policy;
- reproducible signed release pipeline;
- privacy, retention, ACL and diagnostic/logging policy;
- Apache-2.0 / NOTICE / third-party and final brand attribution review.

### Product gaps

- final navigation/settings/error-recovery/diagnostic UX;
- HiDPI and multi-display validation;
- Beta feedback loop;
- systematic cleanup of remaining Wave-derived product surfaces while preserving legal attribution;
- final product identity specification beyond the first visual pass.

### Scale decision

Large-history behavior still needs an explicit product decision and performance budget around the current 100-record visible-history strategy, pagination and virtualization.

## Fork / upstream status

Current fork risk is:

**acceptable now; needs another rehearsal later; not currently blocking**.

The candidate-based rehearsal remains **PASS WITH CONDITIONS**. It is not release-level maintainability proof because the chosen upstream candidate has not become the final merged/release baseline.

When a suitable upstream merge SHA exists, rerun the same rehearsal policy against that final baseline. Until then, keep the condition explicit rather than treating the candidate as a downstream dependency.

## Recommended next stage

# Release Candidate Readiness Gate

This is a release-closure gate, not another feature phase and not an architecture redesign.

Its purpose is to turn the current installable MVP foundation into a boundary-defined, repeatably verifiable and supportable release candidate.

## Exit criteria

The gate is complete only when all of the following are true:

1. Supported configuration is explicit: Windows 11 + PowerShell 7, hosted-runtime default/fallback policy, one-host/one-Runspace behavior and sidechannel-failure behavior.
2. Install, upgrade, restart, uninstall and durable-data preservation remain stable.
3. A reproducible **signed** Windows artifact exists with documented update/channel/rollback/support policy.
4. The target interactive/recovery matrix is either PASS or explicitly excluded; there are no silent compatibility assumptions.
5. Ordinary lifecycle, persistence, Clear, output-safety and frontend regressions remain green.
6. Performance budgets and the 100-record / pagination / virtualization decision are explicit.
7. Privacy, retention, ACL, diagnostics, Apache/NOTICE/third-party and brand boundaries are reviewed and documented.
8. When the relevant upstream candidate becomes a final merged baseline, rerun the upstream rehearsal against the final merge SHA; until then keep the current conditional verdict.

## Explicitly not next

Do not use the RC gate as justification to:

- build a custom terminal emulator;
- replace the Wave / ConPTY / xterm live path;
- introduce a second authoritative PowerShell process or Runspace;
- merge CommandRecord into Wave Block;
- make PTY heuristics authoritative for ordinary structured output;
- perform broad Wave-core deletion or rewrite;
- redesign schema/transport without evidence;
- add advanced Liquid Glass shaders, large animation work or visual polish ahead of release blockers;
- add AI, cloud, sync, search or unrelated shell features;
- repeat the Product Evidence Gate without new evidence requiring it.

## Evidence confidence

### Verified

Current main implementation, merged Product Evidence / Freeze / hardening / packaging / upgrade / visual evidence, and candidate upstream rehearsal records.

### Strong inference

The project is an installable Windows Block Terminal MVP foundation / preview and the correct next stage is Release Candidate Readiness rather than another architecture or feature phase.

### Insufficient evidence

Full compatibility/recovery matrix, release-level upstream rehearsal, large-history final behavior, signed distribution/update/rollback/support closure, complete privacy/data-governance closure and final hosted-runtime default policy.
