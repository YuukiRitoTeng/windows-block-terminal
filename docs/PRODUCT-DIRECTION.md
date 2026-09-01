# Product Direction — Continuous Terminal + Block-Aware Functionality

Status: **CURRENT PRODUCT-DIRECTION AUTHORITY**  
Effective date: 2026-08-30

This document defines the intended user experience for Windows Block Terminal.
It governs product presentation and interaction direction. It does **not** replace
`CONDITIONAL-ARCHITECTURE-FREEZE.md`, which remains authoritative for runtime
responsibilities and truth semantics.

## 1. Product goal

Windows Block Terminal should feel, first and foremost, like a normal continuous
PowerShell terminal.

The target is:

> **Original terminal feel + reliable command-block functionality.**

The terminal should not default to a Warp-style card-per-command layout. The
live xterm surface remains visually primary and commands continue to appear as a
single continuous terminal stream.

The product adds logical command boundaries and reliable actions on top of that
continuous terminal experience.

## 2. Core user requirements

### P0 — Reliable command region semantics

For an ordinary command, the product must know which command record owns which
authoritative structured output.

The user-facing concept is a logical command region:

```text
command
+ only that command's output
```

A logical command region is not required to be a separate visual card.

### P0 — Copy command + corresponding output

The primary block-aware copy action copies:

```text
command
+ only the corresponding authoritative output
```

It must not accidentally include the next command, unrelated background output
or another command's output.

Trusted copy must continue to honor completeness, attribution, text-safety and
truncation guarantees. A visually convenient boundary is not by itself proof of
output ownership.

### P0 — Clear Visual History

Clear removes the current product-visible history and rendered terminal history
without restarting or replacing the user's PowerShell session.

It must preserve the shell, PTY, hosted PowerShell process, persistent Runspace,
working directory, environment, PowerShell variables and functions.

A raw xterm buffer clear is not equivalent to the product-level Clear Visual
History operation.

### P0 / P1 — Convenient copy and paste

Normal terminal selection copy and paste remain available. Block-aware copy is
an additional product action; it should not make the terminal feel less like a
normal terminal.

### P1 — Lightweight visual distinction

Commands may receive subtle command-aware presentation such as a gutter mark,
small status indicator, hover affordance, prompt emphasis or other lightweight
boundary cue.

Visual distinction is secondary to correctness and usability. Large per-command
cards, strong alternating backgrounds, heavy animation and large visual effects
are not product requirements.

## 3. Continuous terminal is the primary presentation

The default working surface should be the live Wave / ConPTY / xterm.js terminal.

A typical session should continue to read naturally as:

```text
PS C:\> command A
output A

PS C:\> command B
output B

PS C:\> command C
output C
```

Command-aware actions should layer onto this surface without turning every
command into a separate replacement renderer.

## 4. Role of CommandRecord and Command Journal

`CommandRecord` remains the logical/domain unit for execution and history.

It is **not** the same thing as a visual card and it is **not** a Wave Block.

The Command Journal, structured output metadata and trusted-output guarantees
remain valuable because the product requires reliable command/output ownership,
not merely a best-effort visual selection.

Durable persistence may support restart history and inspection, but durable
history is not the primary visual workspace.

## 5. Role of Command History / Command Cards

Command History and Command Cards are retained as an **optional inspector and
projection layer**.

They may expose:

- command metadata;
- status / exit code / duration / cwd;
- bounded authoritative output;
- Copy Command;
- Copy Output;
- Copy Command + Output;
- history inspection.

They should not permanently dominate or substantially shrink the live terminal
by default.

## 6. Legacy / superseded presentation direction

The first Visual Productization pass used a permanently visible Command History
panel and prominent Command Cards as the default presentation.

That implementation remains valid historical evidence that the structured
backend, copy guarantees, persistence and Clear behavior worked in a real GUI.
It is **not deleted or rewritten out of history**.

However, as a product-direction decision, the following is now superseded:

> **Card-first / always-visible Command History as the default terminal UX.**

Older commits, screenshots, evidence documents and descriptions of that first
visual pass should be read as **Legacy / Superseded Presentation**, not as the
final UX specification.

Cards remain a supported auxiliary presentation unless a later product decision
removes them explicitly.

## 7. Architecture that remains preserved

This product-direction rebaseline does not reopen the architecture freeze.
The following remain expected:

- Wave / ConPTY / xterm.js is the sole live terminal authority;
- `CommandRecord != Wave Block`;
- one hosted PowerShell process and one persistent Runspace;
- ordinary structured lifecycle/output comes from the authenticated hosted
  sidechannel;
- interactive workloads remain PTY/xterm-owned;
- `Execution Completion != Output Attribution != Output Completion`;
- trusted Copy/Show requires explicit output guarantees;
- Clear preserves the live session;
- no second ANSI/VT terminal renderer is introduced.

## 8. Interactive workloads

REPLs, SSH, vim, fzf and other TUI/full-screen workloads remain live-terminal
workloads.

The product must not invent exact post-hoc output ownership for interactive
content merely to make every visual region copyable. Exact interactive copy
requires separate causal evidence before it can be promised.

## 9. Implementation direction

The intended implementation sequence is:

1. Make continuous xterm the default primary surface.
2. Keep Command History / Cards available as an optional inspector.
3. Keep authoritative Copy All semantics backed by the structured data path.
4. Keep Clear Visual History available even when the inspector is closed.
5. Use the reliable CVA causal mapping already established between a
   command-aware region on the continuous terminal and the authoritative
   `CommandRecord` before exposing direct in-terminal block copy.
6. Add only lightweight visual distinction needed for usability.

Do not implement command-region mapping using command-text matching, timestamp
matching, prompt matching, row proximity, array index matching or other
heuristics that could misattribute output.

## 10. Decision test for future work

A proposed feature belongs in the core product when it directly improves one of:

- reliable command boundaries;
- command + corresponding-output copy;
- normal terminal usability;
- Clear Visual History;
- supported interactive compatibility;
- release reliability and supportability.

Features unrelated to those goals should not displace release blockers or the
continuous-terminal UX closure.

## 11. Relationship to older documents

Historical Phase documents, Product Evidence documents, RC evidence and first
Visual Productization records remain preserved as evidence of how the project
reached the current architecture.

Where an older document implies that prominent permanent Command Cards are the
final product UX, that presentation statement is superseded by this document.

Where an older document records architecture evidence, output-truth semantics,
packaging evidence, compatibility results or historical test results, those
facts remain valid unless separately superseded by newer evidence.
