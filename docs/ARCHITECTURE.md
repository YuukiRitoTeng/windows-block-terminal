# Architecture Baseline

## Product Direction

Windows 11 + PowerShell 7 Block Terminal.

## Current Status

Phase 0–5 currently constitute a backend feasibility and domain foundation.
They are not a fully frozen product architecture. The next gate is Product
Evidence Gate preparation / Phase 0–5 remediation.

## Runtime Authority

Wave Terminal remains the runtime for the real terminal session. Wave owns:

- PTY and shell process
- session lifecycle
- controller / RPC
- terminal byte stream
- xterm.js terminal compatibility and rendering

The product observes the PTY path asynchronously. Observation must never alter
or block the authoritative Wave/xterm terminal path.

## Product Domain

```text
Terminal Session
│
├─ Wave Runtime
│  └─ xterm.js active terminal
│
└─ Command Journal
   ├─ CommandRecord
   ├─ raw captured output metadata
   └─ future presentation / Card projections
```

Core invariants that are currently retained:

- Wave Block = terminal session
- CommandRecord = one product command, independent of Wave Block
- interactive applications remain in the real PTY/xterm path
- Command Cards must not replace the active xterm terminal
- Clear Visual History must not kill or reset the shell / PTY / session
- no custom terminal emulator is planned

## Product Data Boundary

```text
Raw captured output
        ≠
Presentation output
        ≠
Copy output
```

The current backend exposes raw captured output together with truncation,
completeness, attribution and text-safety metadata. Raw PTY bytes are not yet
the final Card or Copy Output contract.

## Lifecycle and Output Boundary Contract

PowerShell integration events have semantic, not physical-drain, meaning:

- `C` means command accepted / execution started.
- `D` means execution result known (`success`, `exitCode`, and execution
  `FinishedAt`).
- `P` is a prompt lifecycle signal.

`D` and `P` do not prove that ordinary PTY output has physically arrived. The
three concerns remain independent: execution completion, output attribution,
and output completion. `CommandRecord.State` describes execution;
`OutputState` describes capture finalization (`open`, `pending`, `closed`).
`OutputCompleteness` and `OutputAttribution` are conservative quality metadata.
A record starts with unknown output quality; only a proven causal output fence
may upgrade it to `complete` / `exclusive`.

After `D`, the Journal does not assign all later bytes to the finished command.
Next `C`, epoch change, runtime detach, and session close are liveness fences
that close unresolved output as `unknown` / `incomplete`, not proof of
attribution. The PTY, Wave terminal file, and xterm.js path remain unchanged.

## Not Yet Frozen

The following remain conditional until a real product vertical slice exists:

- final CommandRecord schema and API
- Output Store contract and overflow policy
- Card projection
- copy normalization
- frontend read model / RPC usage
- persistence product UX and retention policy

## Current Phase

Product Evidence Gate preparation / Phase 0–5 remediation.

The next product work must prove a minimal read/control path beside xterm.js
before a broader architecture freeze or visual productization.
