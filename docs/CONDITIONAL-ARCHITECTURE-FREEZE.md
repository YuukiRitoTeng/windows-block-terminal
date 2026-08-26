# Conditional Architecture Freeze

Status: **FREEZE WITH CONDITIONS**  
Scope: Windows Block Terminal MVP foundation  
Decision date: 2026-08-27  
Evidence baseline: Product Evidence Gate completed on PR #46

## 1. Decision

The MVP foundation is now conditionally frozen.

This freeze applies to **architecture responsibilities and truth semantics**. It does not freeze every field, schema, transport, UI detail, limit, polling interval, or packaging choice.

The product has enough real Windows/Wave evidence to stop revisiting the same foundational questions during normal feature work.

A future change may challenge a frozen invariant only when new production evidence shows that the invariant is false or blocks a required product capability. Such a change is an architecture review event, not routine refactoring.

## 2. Document authority and supersession

This document is the current architecture authority for the MVP foundation.

Where older Phase 0-5 design documents conflict with this document, **this document wins**.

In particular, older descriptions that treat PowerShell OSC C/D markers plus raw PTY observation as the intended ordinary-command authority are historical. They were useful feasibility work, but they were superseded after real production evidence showed that shell lifecycle completion is not a physical PTY output fence.

The current route is:

```text
Wave / ConPTY / xterm.js
        |
        | live terminal authority
        v
Hosted PowerShell Runtime
one host process + one persistent Runspace
        |
        | authenticated structured lifecycle/output for ordinary commands
        v
HostedRuntimeConsumer
        v
Command Journal
execution state + output state + provenance/guarantee
        v
Durable persistence
        v
Command History / Command Cards / Copy / Clear
```

Interactive commands follow the live PTY path and do not receive an invented exact post-hoc output guarantee.

## 3. Product Evidence Gate verdict

**PRODUCT EVIDENCE GATE = GO**

The real Wave UI was manually validated with the hosted runtime and durable Command Journal.

### Stage 1 - ordinary structured success

Command:

```powershell
Write-Output "product-gate-success"
```

Observed:

- live xterm output remained normal;
- a success Card was created;
- exit code was `0`;
- structured output was `22/22 bytes`;
- Show Output contained only `product-gate-success`;
- Copy Output contained only `product-gate-success`;
- command echo and prompt were not included in authoritative Card output.

Verdict: **PASS**.

### Stage 2 - direct native failure

Command:

```powershell
cmd /c exit 7
```

Observed:

- Card status was failed;
- exit code was `7`;
- execution mode was structured;
- output was legitimately empty (`0/0 bytes`);
- no fabricated error text was stored.

Verdict: **PASS**.

### Stage 3 - PowerShell failure

Command:

```powershell
throw "product-gate-powershell-failure"
```

Observed:

- xterm displayed the PowerShell error;
- Card status was failed;
- product exit code was `1`;
- authoritative output contained only `product-gate-powershell-failure`;
- Show Output and Copy Output did not include command echo or prompt.

Verdict: **PASS**.

### Stage 4 - mixed pipeline semantics

Commands:

```powershell
Write-Output x | cmd /c exit 7
cmd /c exit 7 | Write-Output
```

A native PowerShell 7.6.5 control run produced:

```text
$?=False
$LASTEXITCODE=7
```

for both cases.

The hosted runtime mapped the whole PowerShell pipeline result to failed / product exit `1`, rather than leaking the internal native `$LASTEXITCODE=7` as the product result.

Verdict: **PASS**.

### Stage 5 - Clear Visual History and session preservation

Before Clear, the session stored:

- environment variable;
- PowerShell variable;
- function;
- current working directory;
- process PID.

After Clear Visual History:

- old Cards disappeared;
- current xterm content disappeared;
- xterm scrollback no longer exposed pre-Clear history;
- shell/PTY/Hosted PowerShell remained alive;
- environment variable, variable, function and cwd were preserved;
- PID remained identical (`SAME=True`);
- new commands created new-generation Cards normally.

Verdict: **PASS**.

### Stage 6 - interactive command ownership

Command:

```powershell
python
```

The Python REPL accepted realtime keyboard input and output. After:

```python
print("interactive-product-gate")
exit()
```

control returned to the same `WBT>` session.

The Card was marked `interactive`. Show Output degraded conservatively instead of presenting PTY bytes as exact output, and Copy Output was unavailable.

Verdict: **PASS**.

### Stage 7 - restart persistence

Command:

```powershell
Write-Output "restart-persistence-check"
```

After completely closing and restarting Wave with the same product data/config roots:

- the durable Card was restored before re-running the command;
- status remained success;
- exit code remained `0`;
- execution mode remained structured;
- byte metadata remained valid;
- Show Output restored `restart-persistence-check`;
- Copy Output restored exactly `restart-persistence-check`;
- the new live hosted terminal started normally.

Verdict: **PASS**.

## 4. Frozen invariants

The following are now architectural invariants for the MVP foundation.

### 4.1 Live terminal authority

Wave / ConPTY / xterm.js is the only authoritative live terminal compatibility path.

The product must not implement a second ANSI/VT terminal emulator or replace xterm.js with HTML Cards for running interactive programs.

### 4.2 Wave Block and CommandRecord are different domains

A Wave Block remains a terminal session/runtime container.

A CommandRecord is a product-owned execution/history record.

`CommandRecord != Wave Block`.

Command Journal semantics must not be embedded into generic Wave Block persistence.

### 4.3 One authoritative PowerShell session state

The hosted PowerShell direction uses one host process and one persistent Runspace for the session.

A second long-lived `pwsh.exe` / second Runspace must not be introduced merely to obtain structured ordinary-command output and then synchronized with the interactive shell.

### 4.4 Ordinary structured commands

For ordinary hosted commands:

- lifecycle authority comes from the hosted runtime;
- structured output authority comes from the authenticated hosted sidechannel;
- PTY bytes remain the live terminal presentation path;
- PTY observation is not promoted back into exact ordinary Card output.

### 4.5 Interactive commands

For interactive programs:

- PTY/xterm owns realtime input/output;
- the Command Card must not take control away from xterm;
- execution lifecycle/status may be recorded;
- exact bounded post-hoc Copy Output is not promised unless a future independent mechanism proves it.

### 4.6 Execution completion is not output completion

The architecture permanently separates:

```text
Execution Completion
!= Output Attribution
!= Output Completion
```

A semantic command-finished event is not a physical PTY output-drained fence.

Prompt-ready, next-command, session-close, epoch-change or quiet-time observations may be liveness/recovery boundaries, but they are not by themselves proof of exact output attribution.

### 4.7 Trusted product output must be explicit

The product may expose authoritative Show/Copy Output only when the record proves the equivalent of:

```text
execution mode is not interactive
output state is closed
output completeness is complete
output attribution is exclusive
output text safety is plain_text
output is not truncated
```

Presentation-size limits may additionally bound UI actions, but the concrete byte limit is not an architecture invariant.

Unknown, incomplete, mixed, unsafe, truncated or interactive output must degrade honestly.

### 4.8 Exit semantics

Direct native invocation may use the native exit code.

PowerShell and mixed-pipeline execution uses PowerShell whole-command success semantics; an internal native `$LASTEXITCODE` must not be treated as the final product exit code for a mixed PowerShell pipeline.

### 4.9 Durable history ownership

Product history is backed by the product-owned durable store.

Wave circular terminal files, xterm rows, scrollback, frontend component state and prompt reconstruction are not durable Command Journal authority.

Persistence failures, dropped output or recovery uncertainty must downgrade metadata rather than preserve a false `complete/exclusive` claim.

### 4.10 Clear Visual History

Clear Visual History is a product visibility operation plus a rendered-terminal visual clear.

It must preserve the terminal session, PTY, Hosted PowerShell process, Runspace and shell state.

Clear Visual History and destructive history deletion remain distinct concepts.

## 5. Explicitly rejected/reframed approaches

The following are not normal implementation options anymore:

- treating shell `D` / prompt lifecycle as a PTY physical-output fence;
- quiet-period/sleep heuristics for exact output completion;
- attributing all bytes from command finish to next command wholesale;
- prompt matching as durable output attribution;
- reconstructing authoritative CommandRecord output from xterm scrollback;
- running two authoritative PowerShell sessions and trying to synchronize state;
- allowing HTML Cards to replace the live terminal for REPL/TUI/SSH interaction;
- rewriting the PTY/ShellController data path to create a custom terminal stack.

Reintroducing one of these requires new evidence and an explicit architecture review.

## 6. Not frozen

The following remain implementation/product decisions and may evolve without reopening the foundation:

- final `CommandRecord` field set;
- final `RecordView` / RPC contract;
- final SQLite schema and migration layout;
- final output chunk representation;
- loopback TCP / JSON as the permanent sidechannel transport;
- capture/protocol version numbering scheme;
- frontend refresh mechanism (including current polling);
- presentation byte limits;
- Command History height/layout;
- Card visual design and information density;
- Copy All formatting;
- pagination, lazy loading and virtualization;
- retention policy and destructive-delete UX;
- exact xterm visual-clear implementation details;
- default hosted-runtime cutover policy;
- packaging, updater and installer design;
- glass/animation/visual identity;
- performance budgets;
- search UX;
- release channel design.

These may be changed provided they preserve the frozen invariants.

## 7. Conditions and remaining gates

This freeze is conditional because Product Evidence Gate proves the primary vertical slice, not release-grade compatibility for every terminal workload.

Still outside this freeze:

- exhaustive vim/fzf/ssh/nested-shell compatibility;
- alternate-screen edge cases;
- resize stress/reflow behavior;
- reconnect/crash/backpressure hardening;
- performance at large history/output scale;
- installer/update/signing behavior;
- default-runtime rollout;
- final privacy/retention UX.

These are later engineering gates. Failure in one of them may require an adapter or implementation change. It does not automatically invalidate the frozen domain boundaries.

## 8. Architecture review triggers

Normal feature work must stop for architecture review if a change requires any of the following:

- changing live terminal authority away from Wave/ConPTY/xterm.js;
- changing from one authoritative PowerShell Runspace to synchronized dual sessions;
- making PTY heuristics authoritative for ordinary structured output;
- merging CommandRecord semantics into Wave Block semantics;
- claiming exact interactive output without new causal evidence;
- making Clear restart the shell/session;
- bypassing output guarantee metadata to enable Copy/Show;
- introducing a second durable history truth source;
- broad invasive changes to ShellController/PTY/xterm parsing to support Cards.

## 9. Next project stage

The next main-line objective is **Fork Isolation / Upstream Maintainability Rehearsal**.

The objective is no longer to re-prove whether Command Cards can coexist with a live terminal. That product hypothesis has passed the Product Evidence Gate.

The next work should prove that the architecture can absorb real Wave upstream change while keeping downstream product logic concentrated in narrow adapters and product-owned modules.

After that, continue the existing roadmap toward release hardening, Windows packaging/MVP performance, and finally visual productization.
