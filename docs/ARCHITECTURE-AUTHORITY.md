# Architecture Document Authority

This file defines which architecture documents should be treated as current when older feasibility documents disagree with later production evidence.

## Current authority order

1. `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md`
2. Product Evidence Gate implementation/evidence in merged PR #46
3. `docs/WAVE-HOSTED-RUNTIME-GATE.md`
4. current `docs/ROADMAP.md`
5. older Phase 0-5 feasibility/design documents as historical evidence

## Supersession rule

Older documents remain useful for understanding how the project reached its current design, but they are not allowed to override later evidence.

In particular, treat these older ideas as historical when they conflict with the Conditional Architecture Freeze:

- OSC `D` or prompt lifecycle as proof that PTY output is physically complete;
- raw PTY observation as the authoritative ordinary-command output source;
- command-output attribution inferred from prompt boundaries, next-command boundaries, quiet periods or xterm scrollback;
- dual-shell / dual-Runspace state synchronization as the structured-command strategy;
- a plan in which Command Cards replace xterm for live interactive programs.

The current architecture uses a hosted PowerShell runtime with one persistent Runspace, authoritative structured sidechannel output for ordinary commands, PTY/xterm authority for interactive commands, an independent Command Journal, durable persistence, and an explicit output-guarantee contract.

## Reading guidance for agents and contributors

Before proposing changes to terminal/runtime architecture:

1. read `CONDITIONAL-ARCHITECTURE-FREEZE.md`;
2. treat older Phase documents as claims/evidence, not automatically current design;
3. preserve frozen invariants unless new evidence requires an explicit architecture review;
4. do not reopen previously rejected output-attribution heuristics as routine implementation options.

Implementation details listed as **not frozen** may evolve normally as long as the frozen responsibility and truth boundaries remain intact.
