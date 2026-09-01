# Project Status — Release Candidate Rebaseline

Status date: 2026-08-30  
Strategic verdict: **ARCHITECTURE KEEP / PRODUCT PRESENTATION REBASELINED**

## Authority scope

This document is the current authority for **project state, roadmap position and next-stage priority**.

For current product goal and presentation direction, read `PRODUCT-DIRECTION.md`.

For architecture responsibilities and truth semantics, `CONDITIONAL-ARCHITECTURE-FREEZE.md` remains authoritative.

If an older roadmap, Phase document, README section, screenshot or status paragraph conflicts with these current authorities, the current authority documents win.

## Where the project actually is

Windows Block Terminal is an **installable Windows MVP foundation / preview**.

Merged implementation and evidence cover:

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
- Milestone 0 CVA final-leg closure, including packaged frontend anchor/binding evidence;
- Milestone 1 supported-configuration contract and finite RC matrix.

The project is **not** yet a production-ready release.

Milestones 0 and 1 are complete. The remaining Release Candidate Readiness work
is item-level revalidation and release closure, not a reopening of CVA or the
supported-configuration contract.

## Product-direction rebaseline

The original visual productization pass proved that structured records, trusted output, durable history, Copy and Clear worked in a real GUI. It used a permanently visible Command History / Command Card panel as a prominent default presentation.

That historical work remains valid evidence, but its default presentation is no longer the target UX.

The current product direction is:

> **Continuous PowerShell terminal first; reliable command-block functionality layered on top.**

The default product experience should preserve the normal continuous xterm surface while providing:

- reliable logical command boundaries;
- `Copy All = command + only that command's corresponding output`;
- normal terminal copy/paste;
- Clear Visual History without session reset;
- lightweight command distinction where useful;
- Command History / Cards as an optional inspector rather than the permanent primary workspace.

This change is a **presentation/product-priority correction**, not an architecture reversal.

## Legacy / superseded presentation

The following presentation direction is now marked **Legacy / Superseded**:

> permanently visible Card-first Command History as the final default terminal UX.

Do not delete the corresponding historical commits, screenshots, Phase records, Product Evidence or GUI acceptance notes. They remain part of the project's evidence trail.

When those older documents describe the Card-first layout as the expected future product shape, that statement is historical and is superseded by `PRODUCT-DIRECTION.md`.

## Roadmap alignment

The architecture route remains valid. The product presentation has been rebaselined.

Historical phase names should now be read as completed evidence checkpoints rather than the active development state:

- Phase 0–5: feasibility, runtime/domain foundation and remediation — materially completed;
- Product Evidence Gate — GO;
- Conditional Architecture Freeze — KEEP;
- Phase 6 candidate upstream rehearsal — PASS WITH CONDITIONS;
- Phase 7 hardening / Windows packaging foundation — materially completed;
- Phase 8 first visual productization — completed as evidence, but its Card-first default presentation is superseded;
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

Architecture Review is **not triggered** by the continuous-terminal presentation reframe.

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

The first Card-oriented visual pass is counted here as **historical implementation/evidence**, not as the final presentation specification.

## Conditionally stable / implementation detail

These are current implementation choices, not permanent protocol or product contracts:

- packaged Windows hosted-runtime auto-enable strategy;
- loopback transport details;
- frontend polling/refresh mechanism;
- SQLite schema/chunk details;
- RPC/read-model details;
- 100-record presentation limit;
- pagination / virtualization strategy;
- Command History / Card layout and visibility;
- exact continuous-terminal command marker/decoration treatment;
- installer/updater implementation details;
- final hosted-runtime default/fallback policy.

They may evolve while preserving the Conditional Architecture Freeze and the product direction in `PRODUCT-DIRECTION.md`.

## Still open

### Product-direction closure

Before the next release-candidate source freeze, the product presentation must converge on the current target:

- continuous xterm remains the default primary surface;
- Command History / Cards are optional inspection/projection UI rather than a permanent dominant panel;
- Clear remains accessible without requiring the inspector to be open;
- trusted Copy All semantics are preserved;
- a future direct in-terminal command-region action must not rely on heuristic xterm-row → `CommandRecord` matching;
- lightweight visual command distinction should not become a large redesign project.

The remaining hard technical question is how to causally bind an actionable command region on the continuous terminal to the authoritative `CommandRecord` without reintroducing PTY/prompt heuristics.

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
- packaged validation of the final continuous-terminal presentation.

### Scale decision

Large-history behavior still needs an explicit product decision and performance budget around the current 100-record visible-history strategy, pagination and virtualization.

Durable history remains useful, but it is not the primary visual workspace under the current product direction.

## Fork / upstream status

Current fork risk is:

**acceptable now; needs another rehearsal later; not currently blocking**.

The candidate-based rehearsal remains **PASS WITH CONDITIONS**. It is not release-level maintainability proof because the chosen upstream candidate has not become the final merged/release baseline.

When a suitable upstream merge SHA exists, rerun the same rehearsal policy against that final baseline. Until then, keep the condition explicit rather than treating the candidate as a downstream dependency.

## Recommended next stage

# Release Candidate Readiness Gate

This remains a release-closure gate, not a new architecture phase.

Before freezing the next release-candidate artifact, batch together artifact-affecting changes that still alter the final product experience or release behavior, including:

- continuous-terminal UX closure;
- product branding cleanup;
- updater/update-channel behavior;
- packaging/runtime dependency changes;
- bundled assets and installer behavior.

Then freeze source and packaging configuration once, build a fresh Windows x64 candidate, sign the final artifact and perform packaged revalidation against that exact signed identity.

## Exit criteria

The gate is complete only when all of the following are true:

1. Supported configuration is explicit: Windows 11 + PowerShell 7, hosted-runtime default/fallback policy, one-host/one-Runspace behavior and sidechannel-failure behavior.
2. Install, upgrade, restart, uninstall and durable-data preservation remain stable.
3. The default presentation matches the continuous-terminal product direction and preserves trusted block-aware actions.
4. A reproducible **signed** Windows artifact exists with documented update/channel/rollback/support policy.
5. The target interactive/recovery matrix is either PASS or explicitly excluded; there are no silent compatibility assumptions.
6. Ordinary lifecycle, persistence, Clear, output-safety and frontend regressions remain green.
7. Performance budgets and the 100-record / pagination / virtualization decision are explicit.
8. Privacy, retention, ACL, diagnostics, Apache/NOTICE/third-party and brand boundaries are reviewed and documented.
9. When the relevant upstream candidate becomes a final merged baseline, rerun the upstream rehearsal against the final merge SHA; until then keep the current conditional verdict.

## Explicitly not next

Do not use the RC gate or product-direction rebaseline as justification to:

- build a custom terminal emulator;
- replace the Wave / ConPTY / xterm live path;
- introduce a second authoritative PowerShell process or Runspace;
- merge CommandRecord into Wave Block;
- make PTY heuristics authoritative for ordinary structured output;
- perform broad Wave-core deletion or rewrite;
- redesign schema/transport without evidence;
- turn every command into a new HTML replacement renderer;
- add advanced Liquid Glass shaders, large animation work or visual polish ahead of release blockers;
- add AI, cloud, sync, search or unrelated shell features;
- repeat the Product Evidence Gate without new evidence requiring it.

## Evidence confidence

### Verified

Current architecture implementation, merged Product Evidence / Freeze / hardening / packaging / upgrade / first visual evidence, and candidate upstream rehearsal records.

### Product-direction decision

The continuous-terminal-first target and de-emphasis of permanent Card-first presentation are current product decisions recorded in `PRODUCT-DIRECTION.md`.

### Insufficient evidence

Full compatibility/recovery matrix, release-level upstream rehearsal, large-history final behavior, signed distribution/update/rollback/support closure, complete privacy/data-governance closure, final hosted-runtime default policy, packaged validation of the final continuous-terminal UX, and reliable direct in-terminal command-region → authoritative `CommandRecord` binding.
