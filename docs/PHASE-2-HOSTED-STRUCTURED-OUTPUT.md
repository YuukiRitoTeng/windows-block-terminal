# Phase 2 — Hosted Structured Output Migration

## Production data path

```text
WbtHostedPowerShell
    │
    ├─ one persistent PowerShell Runspace
    ├─ live stdout/stderr → existing Wave PTY/xterm path
    └─ authenticated loopback sidechannel
          │
          ▼
    Wave backend receiver
          │
          ▼
    HostedRuntimeConsumer
          │
          ▼
    Command Journal → CommandRecord
```

The transport DTO is not the domain record. `HostedRuntimeConsumer` binds
events to one host identity, one Runspace identity, and one command identity;
events from another identity fail closed.

## Output authority

For hosted ordinary commands, structured host output is the authoritative
Journal source. PTY bytes remain authoritative for the live terminal and
continue to support the existing/default runtime, but are ignored as Journal
output while a hosted structured record is active. This prevents command echo,
prompt bytes, and duplicate PTY output from entering the record.

Structured `command_finished` closes execution and structured output together
only because the host has explicitly finished its structured output stream.
This does not change the Phase 1 rule that `D` or `P` are not physical PTY
output fences.

Interactive events are recorded with `executionMode=interactive`, while their
output guarantee remains unknown/unavailable; the live PTY/xterm path remains
the authority.

## Exit semantics

The Journal consumes the host result without re-inferring exit status:

- direct native failure preserves `exitCode=7`;
- PowerShell failure maps to `exitCode=1`;
- mixed pipelines use the host's PowerShell success semantics and do not reuse
  a stale internal `$LASTEXITCODE`.

## Persistence and UI scope

The existing persistence boundary stores the authoritative structured output,
execution result, and output quality state. No new SQLite migration, final
schema freeze, frontend projection, Command Card, Copy Output, or Clear
redesign is part of this phase. The default non-hosted Wave runtime remains
unchanged.

## Real Wave evidence

On Windows 11 with the hosted feature flag enabled, one real Wave session
produced these Journal records in one block and one Runspace:

| Command | State | Success | Exit code | Output |
| --- | --- | --- | --- | --- |
| `Write-Output "phase2-structured-success"` | finished | true | 0 | exact structured output, 27/27 bytes |
| `cmd /c exit 7` | finished | false | 7 | empty |
| `throw "phase2-powershell-failure"` | finished | false | 1 | structured error output, 27/27 bytes |

The structured records were `complete`, `exclusive`, and `closed`; no prompt
or command echo was present in their authoritative output.
