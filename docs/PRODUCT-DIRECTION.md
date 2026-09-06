# Product Direction — Continuous Terminal + Block-Aware Functionality

Status: **CURRENT PRODUCT-DIRECTION AUTHORITY**  
Effective date: 2026-09-06

This document defines the intended user experience for Windows Block Terminal.
It is the product and presentation authority. It does **not** replace
`CONDITIONAL-ARCHITECTURE-FREEZE.md`, which remains authoritative for runtime
responsibilities and truth semantics.

## 1. Product goal

Windows Block Terminal is a standalone Windows application. It should feel,
first and foremost, like a normal continuous PowerShell terminal while adding
reliable command-aware functionality.

> **Original terminal feel + reliable command-block functionality.**

The default experience is not a card-per-command renderer, a permanent history
panel or a dashboard. The live terminal remains visually primary, and each
terminal pane remains one continuous stream.

This direction does not remove the useful Wave terminal container capabilities.
Tabs, split panes, workspaces/layouts and multiple terminal sessions remain part
of the application. PowerShell/Windows-Terminal injection is an alternative
that was considered, but it is deferred/reconsiderable rather than the current
implementation direction.

## 2. Core product decisions

### 2.1 Continuous terminal first

The default working surface in every pane is the live Wave / ConPTY / xterm.js
terminal. A normal session should continue to read naturally:

```text
PS C:\> command A
output A

PS C:\> command B
output B
```

The terminal itself is the visible history. Product features layer onto that
surface without replacing it with HTML cards or a second dashboard.

### 2.2 Lightweight command identity

Each accepted command region should eventually have a subtle, distinct visual
identity: for example a lightweight marker, gutter cue, boundary or restrained
color treatment. The exact visual design is **PRODUCT DECIDED / PLANNED**, not
yet a frozen pixel specification.

Large command cards, heavy alternating backgrounds, persistent card panels and
large animation are not product requirements.

### 2.3 One primary local action: Copy All

Each logical ordinary-command region should eventually expose one primary local
action, **Copy All**:

```text
command
+ only that command's corresponding authoritative output
```

The action belongs visually to that command region, preferably near the end of
its output. Copy Command and Copy Output are not separate primary actions in
the target UX. This is a product requirement, not a claim that the final
end-of-region control is already implemented.

Trusted Copy All must continue to use authoritative Journal/structured-output
data and explicit completeness, attribution, safety and truncation guarantees.
It must never infer ownership from row, text, prompt, timestamp, proximity,
quiet time or scrollback heuristics.

### 2.4 Global Clear only

Clear is a global product operation, not a per-command delete, hide or clear
control. Global Clear Visual History clears the visible terminal/history
presentation while preserving the current shell, PTY, hosted process,
persistent Runspace, working directory, environment, variables and functions.

The existing backend-first Clear semantics remain authoritative. A raw xterm
buffer clear alone is not the product Clear operation.

### 2.5 Command navigation, not a history panel

The target command navigation is a thin Codex-like rail or scroll map attached
to terminal scrollback. Small marks correspond to real command regions; the
current or nearby command may be emphasized; previous/next navigation and
click-to-jump may be provided.

This rail is presentation metadata over the continuous terminal. It is not a
second history database and not a replacement card list. It must use the
existing causal visual-anchor (CVA) binding where an action needs a
`CommandRecord`; heuristic row matching is prohibited.

The rail and previous/next interaction are **PRODUCT DECIDED / PLANNED**. No
claim is made that the final rail is implemented today.

### 2.6 Shared actions and shortcuts

Future Settings may expose configurable shortcuts for Copy All, previous/next
command, global Clear Visual History and Open Settings. Default key combinations
are not frozen by this document. Buttons and shortcuts should consume one shared
product action model rather than duplicate semantics.

## 3. Multi-terminal container and pane model

Wave infrastructure remains useful and is retained for:

- multiple terminal tabs;
- split panes;
- multiple PowerShell terminals running in parallel;
- workspace and layout management.

Each pane may own its own PowerShell/session/runtime state. The product must not
synchronize independent panes into one authoritative PowerShell session. The
one-host/one-persistent-Runspace invariant applies per terminal session.

## 4. CommandRecord, Journal and causal authority

`CommandRecord` remains the logical/domain unit for execution and history. It is
not a visual card and it is not a Wave Block:

```text
CommandRecord != Wave Block
```

The Command Journal, structured output metadata, authenticated sidechannel and
CVA remain necessary reliability infrastructure even though the target product
does not expose a traditional History panel or permanent Cards. They provide
command identity, authoritative Copy All data, Clear semantics, recovery and
provenance guarantees.

Reliable causal visual-anchor → authoritative `CommandRecord` binding is
already established by CVA. Future direct terminal actions must consume that
binding; they must not recreate identity with command-text, prompt, timestamp,
row, array-index, proximity, quiet-time or scrollback heuristics.

## 5. Product surfaces removed from the target direction

The following are no longer desired WBT product features:

- Command History inspector as a normal user-facing destination;
- Command Cards as a user-facing primary feature;
- Web functionality in the default/product experience, including the starter
  web block/default upstream web destination;
- AI functionality, including Wave AI, BYOK and AI onboarding.

The first-run experience should be WBT-owned and PowerShell-first. It should not
make Wave AI, Wave community links or an upstream web destination part of the
default onboarding/workspace experience.

This is a **PRODUCT DECISION**, not a claim that every implementation
dependency has already been deleted. Current code and historical evidence may
still contain these surfaces. A later bounded dependency/removal audit must
identify what can be removed without breaking Command Journal, CommandRecord,
trusted output, CVA, recovery or other frozen contracts.

Until that implementation work lands, any remaining surface is an
implementation or historical state, not a change to this product direction.

## 6. Legacy / superseded presentation

The first Visual Productization pass used a permanently visible Command History
panel and prominent Command Cards as its default presentation. That work remains
valid historical evidence that structured execution, trusted output, persistence
and Clear worked in a real GUI. It is not deleted or rewritten out of history.

The following presentation statement is **LEGACY / SUPERSEDED**:

> Card-first / always-visible Command History as the default terminal UX.

Older commits, screenshots, evidence documents and GUI acceptance notes that
show that layout must be read as historical implementation/evidence, not as the
current UX specification. Valid backend, packaging, compatibility and test facts
inside those records remain valid unless separately superseded.

## 7. Architecture that remains preserved

This product-direction decision does not reopen the architecture freeze. Preserve:

- Wave / ConPTY / xterm.js as the sole live terminal authority;
- one hosted PowerShell process and one persistent Runspace per terminal session;
- the authenticated structured sidechannel for ordinary-command lifecycle/output;
- PTY/xterm ownership for interactive workloads;
- `Execution Completion != Output Attribution != Output Completion`;
- explicit trusted-output and provenance guarantees;
- durable history in the product-owned store, not xterm scrollback or term files;
- Clear session preservation;
- conservative interactive/TUI semantics;
- causal CVA binding for direct command-region actions.

No second terminal emulator, second authoritative shell or heuristic attribution
fallback is introduced by this product rebaseline.

## 8. Interactive workloads

REPLs, SSH, Vim, fzf and other TUI/full-screen workloads remain real PTY/xterm
workloads. Their interaction and session continuity are product concerns, but
they do not gain an exact retrospective output-attribution promise merely from
being visible in a command region. Exact interactive Copy All requires separate
causal evidence before it can be promised.

## 9. Forward implementation sequence

The near-term product sequence is:

1. Freeze this product/UX direction and reconcile authority documents.
2. Perform a bounded dependency/removal audit for History, Web and AI surfaces.
3. Make the default workspace terminal-only while retaining tabs, splits,
   workspaces and parallel terminal sessions.
4. Add per-command lightweight visual identity over the continuous terminal.
5. Expose CVA-backed per-command Copy All using authoritative Journal data.
6. Add the thin command navigation rail and previous/next navigation.
7. Keep global Clear available at the terminal/workspace level.
8. Add configurable shortcuts/settings using shared action semantics.
9. Build and validate one packaged Windows candidate after artifact-affecting
   work is batched.
10. Complete remaining RC/release closure.

Steps are ordered to avoid rebuilding a candidate after every small artifact
change. Product/UI items are planned until implementation and evidence say
otherwise.

## 10. Artifact and release sequencing

Any work that changes product code, packaging configuration, updater behavior,
runtime dependencies, bundled assets or installer behavior belongs before the
final RC source freeze. Policy-only documentation may proceed separately, but
must be settled before the candidate is declared.

The final packaged RC should be built once from the frozen source and packaging
configuration, then signed and revalidated against its exact identity.

## 11. Decision test for future work

A proposal belongs in the core product when it improves at least one of:

- normal continuous terminal usability;
- reliable command identity and boundaries;
- authoritative command + corresponding-output Copy All;
- global Clear with session preservation;
- supported interactive compatibility;
- release reliability and supportability.

Proposals that restore Card-first presentation, add Web/AI/cloud/sync/search,
replace the live terminal, or rely on heuristic attribution do not fit this
direction. They require an explicit new product decision and, where a frozen
architecture boundary is affected, Architecture Review.

## 12. Relationship to older documents

Historical Phase documents, Product Evidence, RC evidence and first Visual
Productization records remain preserved as evidence of how the project reached
the current architecture. Documents whose product/presentation statements are
obsolete should be treated as FROZEN, HISTORICAL or SUPERSEDED by this authority;
their historical facts must not be rewritten to imply that the current direction
was always the plan.

For current project state, sequencing, release acceptance and architecture
responsibilities, use the authority documents linked from
`docs/ARCHITECTURE-AUTHORITY.md`.
