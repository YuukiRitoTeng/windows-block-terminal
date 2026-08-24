# Architecture Baseline

## Product Direction

Windows 11 + PowerShell 7 Block Terminal.

## Runtime

Wave Terminal is currently used as the terminal session runtime.

Wave owns:

- PTY
- Shell process
- session lifecycle
- controller / RPC
- terminal byte stream
- xterm.js compatibility layer

## Product Domain

The product introduces an independent Command Journal domain.

```text
Terminal Session
│
├─ Wave Runtime
│
└─ Command Journal
   ├─ CommandRecord
   ├─ CommandOutput
   └─ Command Card Projection
```

## Core Boundaries

- Wave Block = Terminal Session
- CommandRecord = one PowerShell command
- xterm.js = active terminal and compatibility layer
- Command Card = completed command projection
- TerminalRuntimeAdapter isolates Wave from the product domain

## Current Rule

Do not modify Wave's core Block semantics.

Do not replace xterm.js with HTML command cards.

Do not implement a custom terminal emulator.

## Current Phase

Phase 0 — Implementation Landing Design.

The next step is to map the B2+ architecture onto real Wave source-code integration points before starting product development.
