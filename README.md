# Windows Block Terminal

Windows Block Terminal is a Windows-first block terminal for Windows 11 and PowerShell 7.

Its product goal is simple:

> **Keep the normal continuous terminal experience, but add reliable command-block semantics and actions.**

The live terminal remains visually primary. Windows Block Terminal should feel close to a normal PowerShell / Wave terminal rather than a card-per-command replacement UI.

> **Project status:** installable Windows MVP foundation / preview. The current main-line stage is the **Release Candidate Readiness Gate**. This repository is not yet a production-ready signed release.

## Product direction

The target UX is:

```text
PS C:\> command A
output A

PS C:\> command B
output B

PS C:\> command C
output C
```

The terminal remains one continuous xterm surface, while the product tracks logical command boundaries and trusted structured output behind it.

The core product requirements are:

- reliable logical command boundaries for ordinary commands;
- block-aware copy where **Copy All = command + only that command's corresponding output**;
- normal terminal copy/paste remains available;
- Clear Visual History clears product-visible and rendered history without restarting the PowerShell session;
- interactive programs remain real PTY/xterm workloads;
- visual distinction is lightweight and secondary to correctness.

See `docs/PRODUCT-DIRECTION.md` for the current product/presentation authority.

## What works today

- Real Wave / ConPTY / xterm.js terminal path remains active and authoritative.
- Ordinary hosted PowerShell commands produce structured `CommandRecord` lifecycle and output data.
- Command History is durable across application restart.
- Trusted output is gated by completeness, attribution, text-safety and truncation metadata.
- Copy Command is independently available; Copy Output and Copy All are available only when the authoritative output guarantee permits trusted use.
- Clear Visual History removes visible history without restarting the PowerShell session, PTY or Runspace.
- Windows x64 packaging, install, uninstall and in-place installer upgrade have been exercised with durable-history preservation.
- A first Windows Block Terminal visual productization pass was completed and manually accepted.

## Legacy / superseded presentation note

The first visual productization pass made a permanently visible Command History / Command Card panel a prominent part of the default terminal layout.

That work is **not discarded**. It remains useful historical evidence that the structured backend, trusted copy path, durable history and Clear behavior worked in a real GUI.

However, the following presentation direction is now **Legacy / Superseded**:

> **Always-visible Card-first Command History as the default terminal experience.**

Command Cards remain useful as an optional history/inspection projection, but the intended default product experience is now **continuous terminal first**.

Older screenshots, commits and evidence documents that show the Card-first default should be read as historical presentation evidence, not as the final UX specification.

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
trusted Copy / Clear / optional History Inspector
```

Ordinary structured commands use the hosted runtime as lifecycle/output authority. Interactive workloads such as `vim`, `ssh`, `fzf`, REPLs and full-screen TUIs remain owned by the live PTY/xterm path. Interactive output is intentionally conservative and is not presented as exact post-hoc structured output without independent proof.

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
- first Visual Productization pass — preserved as historical evidence, with its Card-first default now superseded as product direction.

The current stage is the **Release Candidate Readiness Gate**. Before the next release-candidate source freeze, artifact-affecting work should converge on the continuous-terminal product direction, release identity, update behavior and other remaining release blockers so that packaged revalidation is not repeated unnecessarily.

See `docs/PROJECT-STATUS.md` and `docs/ROADMAP.md` for the current state and exit criteria.

## Distribution status

The Windows x64 packaging path is proven, but release distribution is not complete.

Current release gaps include production code signing, update/channel/rollback/support policy, broader compatibility/recovery evidence, privacy/retention/ACL/diagnostic policy, final legal/third-party/brand closure, and packaged validation of the final continuous-terminal presentation.

## Upstream and licensing

Windows Block Terminal is a downstream fork of Wave Terminal source. Wave remains the runtime foundation and is licensed under Apache-2.0.

The initial Wave baseline used for the fork was:

`a4447c1563b2df285ab89e76c82f91e1a1a49c1e`

The candidate-based upstream rehearsal remains **PASS WITH CONDITIONS** until a suitable upstream merge/release baseline exists for a release-level rehearsal.

Historical Wave attribution, Apache-2.0 notices and third-party acknowledgements must be preserved. Warp may be used only as an architectural or interaction-design reference; Warp source code is not copied into this project.

## Key documents

- `docs/PRODUCT-DIRECTION.md` — current product goal and presentation direction
- `docs/PROJECT-STATUS.md` — current project state and next-stage authority
- `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md` — frozen architecture responsibilities and truth semantics
- `docs/ARCHITECTURE-AUTHORITY.md` — document authority and supersession rules
- `docs/UPSTREAM-MAINTAINABILITY-REHEARSAL-DECISION.md` — candidate rehearsal verdict and conditions
- `docs/WINDOWS-PACKAGING-MVP-EVIDENCE.md` — Windows packaging and upgrade evidence
- `docs/ROADMAP.md` — current roadmap and Release Candidate Readiness Gate

Older Phase 0–5, Product Evidence and first Visual Productization documents remain historical evidence. They must not override the current product-direction, project-state or architecture authorities.
