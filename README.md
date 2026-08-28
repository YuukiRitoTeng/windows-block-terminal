# Windows Block Terminal

Windows Block Terminal is a Windows-first block terminal for Windows 11 and PowerShell 7.

It keeps a real terminal as the live interaction surface while turning completed ordinary commands into durable, structured command records and readable Command Cards.

> **Project status:** installable Windows MVP foundation / preview. The current main-line stage is the **Release Candidate Readiness Gate**. This repository is not yet a production-ready signed release.

## What works today

- Real Wave / ConPTY / xterm.js terminal path remains active and authoritative.
- Ordinary hosted PowerShell commands produce structured `CommandRecord` lifecycle and output data.
- Command History is durable across application restart.
- Command Cards expose status, exit code, duration, cwd and bounded output metadata.
- Copy Command, Copy Output, Copy All and Show/Hide Output are available when the output guarantee permits them.
- Clear Visual History removes visible history without restarting the PowerShell session, PTY or Runspace.
- Windows x64 packaging, install, uninstall and in-place installer upgrade have been exercised with durable-history preservation.
- The first Windows Block Terminal visual identity pass is merged, including Windows 11 Mica-based window material and productized Command History/Card presentation.

## Compatibility model

The product does **not** replace the terminal emulator with HTML Cards.

```text
Wave / ConPTY / xterm.js
        |
        | authoritative live terminal
        v
Hosted PowerShell Runtime
one host process + one persistent Runspace
        |
        | authenticated structured lifecycle/output
        v
HostedRuntimeConsumer
        v
Command Journal
        v
Durable persistence
        v
Command History / Command Cards / Copy / Clear
```

Ordinary structured commands use the hosted runtime as lifecycle/output authority. Interactive workloads such as `vim`, `ssh`, `fzf`, REPLs and full-screen TUIs remain owned by the live PTY/xterm path. Interactive output is intentionally conservative and is not presented as exact post-hoc Card output without independent proof.

## Core architecture invariants

- Wave / ConPTY / xterm.js is the sole live terminal compatibility authority.
- `CommandRecord != Wave Block`.
- Hosted PowerShell uses one authoritative host process and one persistent Runspace.
- Ordinary structured output comes from the authenticated hosted sidechannel, not PTY heuristics.
- Execution completion, output attribution and output completion are separate truths.
- Trusted Show/Copy Output requires explicit completeness, attribution, text-safety and truncation guarantees.
- Durable product history is owned by the product store, not xterm scrollback or Wave terminal files.
- Clear Visual History must preserve the shell, PTY, hosted process, Runspace and session state.

The detailed architecture authority is `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md`.

## Current roadmap

Completed checkpoints include:

- backend feasibility and domain foundation;
- Product Evidence Gate — GO;
- Conditional Architecture Freeze — KEEP;
- candidate-based upstream maintainability rehearsal — PASS WITH CONDITIONS;
- performance / data / security hardening;
- Windows Packaging MVP and reproducible hosted-runtime publish;
- installer A → B upgrade rehearsal with durable-history preservation;
- first Visual Productization pass.

The current stage is the **Release Candidate Readiness Gate**. Its purpose is not to add another architecture layer or a new feature set. It closes the remaining release, compatibility, support, data-governance and product-identity gaps required for a supportable release candidate.

See `docs/PROJECT-STATUS.md` and `docs/ROADMAP.md` for the current state and exit criteria.

## Distribution status

The Windows x64 packaging path is proven, but release distribution is not complete.

Current release gaps include production code signing, update/channel/rollback/support policy, broader compatibility/recovery evidence, privacy/retention/ACL/diagnostic policy, and final legal/third-party/brand closure.

## Upstream and licensing

Windows Block Terminal is a downstream fork of Wave Terminal source. Wave remains the runtime foundation and is licensed under Apache-2.0.

The initial Wave baseline used for the fork was:

`a4447c1563b2df285ab89e76c82f91e1a1a49c1e`

The candidate-based upstream rehearsal remains **PASS WITH CONDITIONS** until a suitable upstream merge/release baseline exists for a release-level rehearsal.

Historical Wave attribution, Apache-2.0 notices and third-party acknowledgements must be preserved. Warp may be used only as an architectural or interaction-design reference; Warp source code is not copied into this project.

## Key documents

- `docs/PROJECT-STATUS.md` — current project state and next-stage authority
- `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md` — frozen architecture responsibilities and truth semantics
- `docs/ARCHITECTURE-AUTHORITY.md` — document authority and supersession rules
- `docs/UPSTREAM-MAINTAINABILITY-REHEARSAL-DECISION.md` — candidate rehearsal verdict and conditions
- `docs/WINDOWS-PACKAGING-MVP-EVIDENCE.md` — Windows packaging and upgrade evidence
- `docs/ROADMAP.md` — current roadmap and Release Candidate Readiness Gate

Older Phase 0–5 design documents remain historical evidence and must not override later production evidence or current authority documents.
