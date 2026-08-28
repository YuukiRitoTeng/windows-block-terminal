# Architecture Baseline

## Current status

Windows Block Terminal is an **installable Windows MVP foundation / preview**.

The architecture foundation is conditionally frozen. The active project stage is the **Release Candidate Readiness Gate**; the project is no longer in Phase 5 implementation.

For current roadmap state, read `PROJECT-STATUS.md`. For frozen architecture responsibilities and truth semantics, read `CONDITIONAL-ARCHITECTURE-FREEZE.md`.

## Product direction

Windows 11 + PowerShell 7 Block Terminal.

The product keeps a real terminal as the live interaction surface and adds a product-owned structured command/history layer for ordinary commands.

## Runtime authority

Wave / ConPTY / xterm.js remains the authoritative live terminal compatibility path.

Wave owns the real PTY/session/controller/rendering path. The product must not block, replace or reconstruct this path in order to create Command Cards.

Interactive programs remain owned by the live PTY/xterm surface.

## Hosted PowerShell direction

The supported architecture uses:

- one hosted PowerShell process;
- one persistent Runspace;
- terminal-visible stdout/stderr through the PTY/xterm path;
- an authenticated structured sidechannel for ordinary-command lifecycle/output.

A synchronized second long-lived PowerShell session is not part of the architecture.

## Product domain

```text
Wave / ConPTY / xterm.js
        |
        | live terminal authority
        v
Hosted PowerShell Runtime
one host process + one persistent Runspace
        |
        | authenticated ordinary-command lifecycle/output
        v
HostedRuntimeConsumer
        v
Command Journal
  - CommandRecord
  - execution state
  - output state
  - provenance / guarantee metadata
        v
Durable persistence
        v
Command History / Command Cards / Copy / Clear
```

A Wave Block represents a terminal session/runtime container.

A `CommandRecord` represents a product-owned command/history record.

`CommandRecord != Wave Block`.

## Lifecycle and output truth

The architecture permanently separates:

```text
Execution Completion
!= Output Attribution
!= Output Completion
```

Shell lifecycle signals are semantic events, not proof that PTY output has physically drained.

For ordinary hosted commands:

- lifecycle authority comes from the hosted runtime;
- structured output authority comes from the authenticated hosted sidechannel;
- PTY bytes remain the live terminal presentation path.

For interactive commands:

- PTY/xterm owns realtime input/output;
- a lifecycle/status record may exist;
- exact bounded post-hoc output is not promised unless a future independent mechanism proves it.

## Trusted product output

Show/Copy Output is only authoritative when the record proves the equivalent of:

- execution mode is not interactive;
- output state is closed;
- output completeness is complete;
- output attribution is exclusive;
- output text safety is plain text;
- output is not truncated;
- any product presentation-size limit is satisfied.

Unknown, incomplete, mixed, unsafe, truncated or interactive output must degrade honestly.

## Durable history

Product history is owned by the product durable store.

Wave circular terminal files, xterm rows/scrollback, prompt reconstruction and transient frontend component state are not Command Journal authority.

Persistence uncertainty must downgrade guarantees rather than preserve a false complete/exclusive claim.

## Clear Visual History

Clear Visual History is a product visibility transaction plus a terminal visual clear.

It must preserve:

- shell process;
- PTY;
- hosted PowerShell process;
- persistent Runspace;
- session state such as cwd, environment and PowerShell state.

Clear Visual History and destructive durable-history deletion are separate concepts.

## Frozen invariants

The current architecture freeze keeps the following responsibilities stable:

- Wave / ConPTY / xterm.js is the sole live terminal authority;
- CommandRecord remains separate from Wave Block;
- one authoritative hosted PowerShell process / persistent Runspace;
- authenticated hosted ordinary-command lifecycle/output authority;
- conservative interactive semantics;
- execution / attribution / completion separation;
- explicit trusted-output provenance gate;
- product-owned durable history;
- Clear preserves the live session;
- no custom terminal emulator.

## Not frozen

The following may evolve without architecture review when frozen invariants remain intact:

- final CommandRecord / RecordView fields;
- RPC/read-model shape;
- SQLite schema/chunk layout;
- loopback transport implementation;
- frontend polling/refresh implementation;
- presentation byte limits;
- history layout and Card visual design;
- Copy All formatting;
- pagination / lazy loading / virtualization;
- retention and destructive-delete UX;
- hosted-runtime default/fallback policy;
- packaging/updater implementation;
- performance budgets;
- release-channel design.

## Architecture review triggers

Stop normal work and reopen Architecture Review if a required change would:

- replace Wave / ConPTY / xterm.js as live terminal authority;
- introduce synchronized dual authoritative PowerShell sessions;
- make PTY heuristics authoritative for ordinary structured output;
- merge CommandRecord semantics into Wave Block semantics;
- claim exact interactive output without new causal evidence;
- make Clear restart the shell/session;
- bypass output-guarantee metadata for Show/Copy;
- introduce a second durable history truth source;
- require broad invasive ShellController/PTY/xterm changes to support Cards.

The current Release Candidate Readiness Gate does **not** itself trigger architecture review.
