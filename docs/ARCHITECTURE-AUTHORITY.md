# Architecture and Project-State Document Authority

This file defines which repository documents are authoritative when older feasibility, roadmap, status or presentation text disagrees with later production evidence or current product decisions.

## Authority by concern

### Product goal and presentation direction

1. `docs/PRODUCT-DIRECTION.md`
2. `docs/PROJECT-STATUS.md`
3. current `README.md`

These sources govern what Windows Block Terminal is trying to feel like and how its block semantics should be presented to users.

The current product direction is:

> **continuous terminal first + reliable block-aware functionality**

The live xterm surface should remain the primary working surface. Reliable command boundaries, trusted command/output copy and Clear are core product capabilities. Permanently visible Card-first Command History is not the final default UX.

Command History / Cards remain valid optional inspection/projection UI unless a later product decision explicitly removes them.

### Architecture responsibilities and truth semantics

1. `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md`
2. Product Evidence Gate implementation/evidence in merged PR #46
3. `docs/WAVE-HOSTED-RUNTIME-GATE.md`

These sources govern the frozen responsibility boundaries: live terminal authority, one hosted Runspace, CommandRecord/Wave Block separation, ordinary structured-output authority, interactive conservatism, trusted-output guarantees, durable-history ownership and Clear session preservation.

The product-direction rebaseline does not by itself reopen Architecture Review.

### Current project state and roadmap

1. `docs/PROJECT-STATUS.md`
2. `docs/ROADMAP.md`
3. current `README.md`

These sources govern where the project currently is and what the next stage is.

The current strategic verdict is **ARCHITECTURE KEEP / PRODUCT PRESENTATION REBASELINED**: the architecture route remains valid, while the active stage is still the **Release Candidate Readiness Gate**.

### Fork / upstream maintainability

For fork-isolation and upstream-maintainability work, read `docs/UPSTREAM-MAINTAINABILITY-REHEARSAL-DECISION.md`.

That record is authoritative for the completed candidate-based rehearsal against Wave PR #3484. Its result is **PASS WITH CONDITIONS**, Architecture Review is **NOT TRIGGERED**, and the Conditional Architecture Freeze remains **KEEP**.

It is candidate-level evidence only. It does not make an unmerged upstream candidate a downstream dependency and does not constitute release-level maintainability proof.

Future rehearsal decisions must still consider conflict locality, dependency direction, product isolation, frozen-invariant preservation and regression evidence; a clean Git merge alone is not sufficient.

## Superseded status and presentation text

Older documents remain useful as historical evidence, but old status/next-step/final-presentation statements do not override current authority.

In particular, the following are historical when they describe the active project stage or final product presentation:

- `README.md` text that previously described Phase 0 / early feasibility;
- `docs/ARCHITECTURE.md` text that previously described Phase 5 as active;
- old Phase 0–5 design documents;
- the `Next project stage` section of `CONDITIONAL-ARCHITECTURE-FREEZE.md`, which correctly described the next step at the time of the freeze but has since been completed;
- roadmap text that treats Product Evidence Gate, upstream rehearsal, hardening, packaging or first visual productization as still pending;
- first Visual Productization text that implies an always-visible Card-first Command History panel is the final default UX.

The first Card-oriented visual pass remains valid historical implementation/evidence. It should be labeled mentally and in future references as **Legacy / Superseded Presentation**, not deleted or rewritten out of history.

The architecture invariants in `CONDITIONAL-ARCHITECTURE-FREEZE.md` remain authoritative even where its old timeline/status paragraph has been superseded.

## Historical architecture ideas

Treat the following as historical/rejected when they conflict with the Conditional Architecture Freeze:

- OSC `D` or prompt lifecycle as proof that PTY output is physically complete;
- raw PTY observation as authoritative ordinary-command output;
- output attribution inferred from prompt boundaries, next-command boundaries, quiet periods or xterm scrollback;
- dual-shell / dual-Runspace state synchronization as the structured-command strategy;
- Command Cards replacing xterm for live REPL/TUI/SSH interaction.

The current architecture uses a hosted PowerShell runtime with one persistent Runspace, authenticated structured sidechannel output for ordinary commands, PTY/xterm authority for interactive commands, an independent Command Journal, durable persistence and explicit output-guarantee metadata.

## Product-direction implications

The current product direction changes presentation priority, not output truth.

Therefore:

- `CommandRecord` remains a logical/domain record even when no visible Card is shown;
- durable history may remain useful without being the primary workspace;
- trusted Copy All must continue to use authoritative structured output rather than xterm row guessing;
- lightweight command markers/decorations may be added to the continuous terminal, but a visual marker alone does not prove output ownership;
- a direct in-terminal command-region action must have a reliable causal binding to the authoritative `CommandRecord` before it may claim exact block-aware copy;
- Clear remains a product visibility operation plus terminal visual clear, not merely `xterm.clear()`.

## Reading guidance

Before proposing project work:

1. read `PRODUCT-DIRECTION.md` to establish the current user-facing goal;
2. read `PROJECT-STATUS.md` to establish the current stage;
3. read `CONDITIONAL-ARCHITECTURE-FREEZE.md` before changing terminal/runtime architecture;
4. read `UPSTREAM-MAINTAINABILITY-REHEARSAL-DECISION.md` for upstream work;
5. treat older Phase and first Visual Productization documents as historical claims/evidence, not current status or final UX authority;
6. preserve frozen invariants unless new evidence requires explicit Architecture Review;
7. do not repeat completed gates merely because an older document still names them as future work.

Implementation details explicitly listed as **not frozen** may evolve normally as long as the frozen responsibility/truth boundaries and current product direction remain intact.
