# RC Strategic Rebaseline

Status: **CURRENT STRATEGIC SEQUENCING AUTHORITY**  
Effective date: 2026-09-04  
Baseline main SHA: `a91430f8bd0422bf55a26a68b9dc7dd63a497903`

This document records the current strategic route from the completed M0/M1/M2 evidence work to a credible Windows release candidate.

It governs **forward sequencing, priority, evidence discipline, smart-model checkpoints, and manual Windows gates**.

It does not replace the existing authorities for other domains:

- `PROJECT-STATUS.md` — current project state;
- `PRODUCT-DIRECTION.md` — product goal and presentation direction;
- `CONDITIONAL-ARCHITECTURE-FREEZE.md` — architecture responsibilities and truth semantics;
- `RC-READINESS-GATE.md` — release acceptance inventory and evidence statuses.

Where older milestone labels or historical plans conflict with this document's forward sequencing, this strategic rebaseline wins.

## 1. Executive verdict

Windows Block Terminal is architecturally coherent and aligned with the current product direction, but it is **not yet release-ready**.

Current verdict:

- architecture: **KEEP**;
- product direction: **continuous terminal first + reliable block-aware functionality**;
- current engineering phase: **Release Candidate Readiness Gate**;
- M0/M1/M2 behavior and recovery work is materially closed;
- the remaining route is release closure, not a new architecture phase.

The next major principle is:

> Batch artifact-affecting work before one final source/package freeze, then build and validate one exact signed candidate.

## 2. Where the project actually stands

The project has already established:

- one hosted PowerShell process with one persistent Runspace;
- authenticated structured ordinary-command lifecycle/output;
- Command Journal and durable history;
- trusted output provenance/completeness/text-safety gates;
- session-preserving Clear Visual History;
- continuous xterm as the primary workspace;
- optional Command History / Card inspector;
- CVA causal command-region to authoritative `CommandRecord` binding;
- finite supported-configuration contract;
- M2A packaged interactive compatibility closure;
- M2B deterministic and packaged recovery closure;
- Windows packaging/install/upgrade evidence;
- candidate-level upstream maintainability rehearsal.

M2B is **COMPLETE — PASS** for the finite declared scope.

The project is still pre-RC because release-level closure remains open in product presentation, performance/history policy, data governance, identity, signing, update/rollback/support, exact candidate provenance, and final packaged revalidation.

## 3. Evidence discipline

### Proven for the current MVP foundation

- architecture and trust boundaries;
- structured ordinary-command semantics;
- CVA binding;
- finite M2A interactive scenarios;
- finite M2B recovery scenarios;
- packaging/runtime ordering and hosted-runtime presence;
- install/restart/upgrade history preservation evidence;
- candidate-level upstream seam isolation.

### Conditional / historical

- M2A/M2B packaged evidence is tied to specific source/artifact identities;
- historical RC artifacts are not automatically current RC evidence;
- the upstream rehearsal is **PASS WITH CONDITIONS**, not final release-level proof;
- implementation details such as transport, schema, history limits, polling, installer details, and hosted-runtime fallback policy are not architecture-frozen contracts.

### Release-level rule

A release `PASS` must eventually point to the **exact final candidate artifact and supported configuration**.

Do not repeatedly rerun already-closed M2 evidence merely for reassurance. Re-run the required finite set when final RC policy requires exact-candidate validation.

## 4. Architecture verdict

**KEEP**

No M2A/M2B evidence invalidates the Conditional Architecture Freeze.

Preserve:

- Wave / ConPTY / xterm.js as the sole live terminal authority;
- `CommandRecord != Wave Block`;
- one hosted PowerShell process;
- one persistent Runspace;
- authenticated structured sidechannel authority for ordinary commands;
- PTY/xterm ownership for interactive workloads;
- `Execution Completion != Output Attribution != Output Completion`;
- explicit trusted-output guarantees;
- durable history independent of xterm scrollback;
- Clear Visual History preserving shell / PTY / host / Runspace / session state;
- CVA causal binding for direct command-region actions.

Architecture Review is required only if future work must change one of those boundaries.

## 5. Product-direction verdict

The current product goal remains correct:

> **Original terminal feel + reliable command-block functionality.**

The final default experience should keep continuous xterm visually and operationally primary.

Command History / Cards remain optional inspection/projection UI, not the permanent dominant workspace.

Before RC, product-facing work should focus only on concrete release blockers:

- final continuous-terminal default behavior;
- reliable Copy / Copy All / Clear access;
- direct block-aware actions consuming authenticated CVA bindings;
- coherent settings / diagnostics / error-recovery UX;
- necessary product identity cleanup;
- HiDPI / multi-display validation where it affects RC usability.

Do not restore Card-first UX or expand into unrelated visual polish.

## 6. Remaining risk map

### P0 — RC blockers

- final continuous-terminal packaged UX closure;
- artifact provenance consolidated onto one final candidate;
- production code signing and signature verification;
- reproducible signed artifact generation;
- update channel policy and implementation/scope decision;
- rollback policy;
- support and diagnostics policy;
- final hosted-runtime default/fallback policy;
- privacy / retention / ACL / diagnostics closure;
- Apache-2.0 / NOTICE / third-party / final brand attribution review;
- final packaged revalidation against the exact signed candidate.

### P1 — release-quality closure

- startup / memory / scrolling / long-output budgets;
- 100-record visible-history policy;
- pagination / virtualization decision;
- large-history evidence;
- HiDPI / multi-display presentation validation;
- final release-level upstream rehearsal when a suitable upstream merge/release baseline exists.

### Intentionally deferred or unsupported

- exact retrospective attribution for interactive PTY output;
- macOS / Linux RC support;
- Windows 10 / ARM64 RC support;
- Windows PowerShell 5.1 / cmd / WSL as primary supported shell paths;
- AI / cloud / sync / search;
- advanced visual effects unrelated to release blockers.

## 7. Strategic roadmap

The old M3/M4/M5/M6 labels may remain useful as historical references, but they are **not the controlling forward framework**.

The current controlling route is the following five-stage RC closure sequence.

### Stage 1 — Pre-freeze product / UX / identity closure

**Objective:** finish all source, UI, runtime-policy, branding, asset, packaging, and installer changes that can alter final artifact bytes or behavior.

**Why now:** packaged validation should not be repeated after every small artifact-affecting change.

**Close with:** targeted automated checks plus one packaged Windows validation for final UX/runtime behavior.

**Ordinary Agent:** yes.

**Smart-model checkpoint:** only if a proposed change challenges a frozen architecture boundary or creates a real product-policy trade-off.

**Manual Windows gate:** yes, after artifact-affecting closure.

**STOP / escalate if:** the fix requires a second authoritative session, PTY heuristic attribution, CVA replacement, broad Wave-core rewrite, or another frozen-boundary change.

### Stage 2 — Performance / data / privacy / legal closure

**Objective:** define and verify resource, retention, governance, and legal commitments.

**Scope:** startup, memory, scrolling, long output, history scale, 100-record policy, pagination/virtualization, retention/delete behavior, ACL, diagnostics/privacy, legal/NOTICE/third-party/brand boundaries.

**Close with:** explicit budgets/contracts and deterministic tests; manual Windows checks only where automation cannot prove UI/ACL behavior.

**Ordinary Agent:** yes for audit, implementation, tests, and docs.

**Smart-model checkpoint:** only for material policy trade-offs or conflicting product/data requirements.

**Manual Windows gate:** conditional.

### Stage 3 — Release / support chain closure

**Objective:** make the candidate distributable and supportable.

**Scope:** signing identity, reproducible signed build, update feed/channel, rollback, install/upgrade/uninstall/update lifecycle, support/recovery/diagnostic runbooks.

**Close with:** verifiable signed artifact path plus tested release lifecycle and explicit support policy.

**Ordinary Agent:** yes for implementation and validation work.

**Smart-model checkpoint:** justified when signing/update/rollback/support policy is frozen or when release-chain trade-offs are material.

**Manual Windows gate:** yes, in an isolated Windows environment.

### Stage 4 — Final source freeze + exact RC revalidation

**Objective:** produce one definitive candidate and tie all required release evidence to it.

**Sequence:**

```text
freeze source + packaging configuration
→ build fresh Windows x64 candidate
→ sign with downstream release identity
→ verify signature + record exact hashes/provenance
→ run finite packaged RC revalidation on that exact artifact
→ rerun upstream rehearsal if a suitable final upstream baseline exists
```

**Close with:** no unresolved RC-blocking FAIL / NOT-YET / revalidation item for the declared scope, and every required PASS tied to the exact final candidate/configuration.

**Ordinary Agent:** yes for deterministic work and evidence collection.

**Smart-model checkpoint:** only if final evidence conflicts with architecture, product scope, or release policy.

**Manual Windows gate:** yes; one isolated final packaged gate.

### Stage 5 — RC decision / beta-support handoff

**Objective:** apply the RC exit policy and prepare controlled distribution.

**Close with:** explicit RC decision, release metadata, support/rollback handoff, and separation of deferred work from release claims.

**Ordinary Agent:** yes for packaging of evidence/docs/release metadata.

**Smart-model checkpoint:** useful for final go/no-go only if unresolved evidence or policy conflict remains.

**Manual Windows gate:** only the lifecycle checks required by the final release policy.

## 8. Sequencing discipline

All artifact-affecting changes belong **before Stage 4 final freeze**.

This includes, as applicable:

- continuous-terminal UX changes;
- direct CVA-backed in-terminal actions;
- branding / visible Wave-surface cleanup;
- settings / diagnostics / error UX;
- hosted-runtime default/fallback behavior;
- runtime dependencies;
- packaging configuration;
- bundled assets;
- installer behavior;
- updater behavior.

Policy-only documentation can proceed in parallel, but it must be settled before the final candidate is declared.

Do not build a new RC artifact after every minor change.

## 9. Smart-model checkpoints

Use a strong model only when:

- a frozen architecture authority/trust boundary is challenged;
- product/data/release policy has materially conflicting trade-offs;
- signing identity, update channel, rollback, or support contract must be frozen;
- final-candidate evidence conflicts with the current architecture or product contract;
- ordinary implementation cannot converge on the bounded seam;
- final upstream rehearsal reveals unexpected product-domain coupling.

Do not use a strong model for routine implementation, tests, lint, packaging diagnostics, or log analysis.

## 10. Manual Windows gates

Use isolated packaged Windows 11 x64 validation for behavior that automation cannot credibly prove, including:

- final continuous-terminal presentation;
- hosted-runtime readiness/fallback as exposed by the final product;
- required finite M2A/M2B exact-candidate revalidation;
- install / upgrade / uninstall / update / rollback;
- signature verification;
- visual, PTY, resize, HiDPI/multi-display, or ACL behavior where applicable.

Do not create permanent one-off infrastructure solely to reproduce already-closed historical gates.

## 11. Explicitly not now

Do not:

- build a new terminal emulator;
- replace Wave / ConPTY / xterm.js;
- add a second authoritative PowerShell process or Runspace;
- merge CommandRecord with Wave Block;
- infer authoritative attribution from prompt, text, timestamp, row, proximity, quiet time, or scrollback;
- rewrite Wave core / ShellController / PTY / xterm broadly without evidence;
- redesign Journal schema/transport merely for elegance;
- restore Card-first default UX;
- add AI / cloud / sync / search;
- pursue advanced visual polish unrelated to a concrete RC usability issue;
- expand RC scope to unsupported platforms/shells;
- promise exact retrospective attribution for interactive workloads;
- repeat already-closed M2 evidence unless required for the exact final candidate.

## 12. Immediate strategic position

The immediate next slice is **Stage 1 pre-freeze product / UX / identity closure**, beginning with an audit of concrete artifact-affecting P0 gaps.

That audit should not assume code changes are necessary. If current main already satisfies the product authority, record evidence and move forward instead of manufacturing work.

## 13. Confidence and unresolved questions

Plan confidence: **MEDIUM**.

Architecture confidence is high. Release-readiness confidence remains medium until the final candidate, signing identity, update/rollback/support contract, performance/history commitments, governance/legal closure, and final exact-artifact evidence are fixed.

Open questions to resolve during the RC gate:

- Which exact source/configuration becomes the final RC candidate?
- Which artifact-affecting changes remain before freeze?
- What signing identity and verification policy will be used?
- What update / rollback / support contract will be declared?
- Which performance and history budgets become release commitments?
- What upstream merge/release baseline will be used for the final rehearsal?
- How will final M2/RC artifacts and evidence be durably archived and audited?
