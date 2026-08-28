# Architecture and Project-State Document Authority

This file defines which repository documents are authoritative when older feasibility, roadmap or status text disagrees with later production evidence.

## Authority by concern

### Architecture responsibilities and truth semantics

1. `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md`
2. Product Evidence Gate implementation/evidence in merged PR #46
3. `docs/WAVE-HOSTED-RUNTIME-GATE.md`

These sources govern the frozen responsibility boundaries: live terminal authority, one hosted Runspace, CommandRecord/Wave Block separation, ordinary structured-output authority, interactive conservatism, trusted-output guarantees, durable-history ownership and Clear session preservation.

### Current project state and roadmap

1. `docs/PROJECT-STATUS.md`
2. `docs/ROADMAP.md`
3. current `README.md`

These sources govern where the project currently is and what the next stage is.

The current strategic verdict is **REFRAME NEXT STAGE**: the architecture route remains valid, while the active stage is now the **Release Candidate Readiness Gate**.

### Fork / upstream maintainability

For fork-isolation and upstream-maintainability work, read `docs/UPSTREAM-MAINTAINABILITY-REHEARSAL-DECISION.md`.

That record is authoritative for the completed candidate-based rehearsal against Wave PR #3484. Its result is **PASS WITH CONDITIONS**, Architecture Review is **NOT TRIGGERED**, and the Conditional Architecture Freeze remains **KEEP**.

It is candidate-level evidence only. It does not make an unmerged upstream candidate a downstream dependency and does not constitute release-level maintainability proof.

Future rehearsal decisions must still consider conflict locality, dependency direction, product isolation, frozen-invariant preservation and regression evidence; a clean Git merge alone is not sufficient.

## Superseded status text

Older documents remain useful as historical evidence, but old status/next-step statements do not override current state authority.

In particular, the following are historical when they describe the active project stage:

- `README.md` text that previously described Phase 0 / early feasibility;
- `docs/ARCHITECTURE.md` text that previously described Phase 5 as active;
- old Phase 0–5 design documents;
- the `Next project stage` section of `CONDITIONAL-ARCHITECTURE-FREEZE.md`, which correctly described the next step at the time of the freeze but has since been completed;
- roadmap text that treats Product Evidence Gate, upstream rehearsal, hardening, packaging or first visual productization as still pending.

The architecture invariants in `CONDITIONAL-ARCHITECTURE-FREEZE.md` remain authoritative even where its old timeline/status paragraph has been superseded.

## Historical architecture ideas

Treat the following as historical/rejected when they conflict with the Conditional Architecture Freeze:

- OSC `D` or prompt lifecycle as proof that PTY output is physically complete;
- raw PTY observation as authoritative ordinary-command output;
- output attribution inferred from prompt boundaries, next-command boundaries, quiet periods or xterm scrollback;
- dual-shell / dual-Runspace state synchronization as the structured-command strategy;
- Command Cards replacing xterm for live REPL/TUI/SSH interaction.

The current architecture uses a hosted PowerShell runtime with one persistent Runspace, authenticated structured sidechannel output for ordinary commands, PTY/xterm authority for interactive commands, an independent Command Journal, durable persistence and explicit output-guarantee metadata.

## Reading guidance

Before proposing project work:

1. read `PROJECT-STATUS.md` to establish the current stage;
2. read `CONDITIONAL-ARCHITECTURE-FREEZE.md` before changing terminal/runtime architecture;
3. read `UPSTREAM-MAINTAINABILITY-REHEARSAL-DECISION.md` for upstream work;
4. treat older Phase documents as historical claims/evidence, not current status;
5. preserve frozen invariants unless new evidence requires explicit Architecture Review;
6. do not repeat completed gates merely because an older document still names them as future work.

Implementation details explicitly listed as **not frozen** may evolve normally as long as the frozen responsibility and truth boundaries remain intact.
