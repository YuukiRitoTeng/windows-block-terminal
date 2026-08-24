# Windows Block Terminal

A modern block-based terminal experience for Windows 11 and PowerShell 7.

## Vision

Traditional terminals render commands and output as one continuous text stream.

Windows Block Terminal aims to turn completed commands into structured, readable and directly actionable command cards while preserving full terminal compatibility.

## Core Experience

- One structured record per completed command
- Clear separation between command and output
- Success / failure status
- Exit code and execution duration
- Copy Command
- Copy Output
- Copy All
- Clear visual history without restarting the PowerShell session
- Preserve cwd, environment and virtual environments
- Keep interactive terminal applications fully functional

## Terminal Compatibility

The active terminal remains xterm.js based.

Interactive applications such as:

- vim
- ssh
- fzf
- Python REPL
- nested PowerShell
- full-screen TUI applications

remain inside the real terminal runtime.

Command Cards are projections of completed commands, not a replacement for the terminal emulator.

## Architecture

Current architecture:

```text
Wave Runtime
    │
    ├─ PTY
    ├─ PowerShell 7
    ├─ Session
    ├─ Controller / RPC
    └─ xterm.js
          │
          ▼
TerminalRuntimeAdapter
          │
          ▼
Command Journal
    ├─ CommandRecord
    ├─ Command Output
    └─ Command Card Projection
```

Wave Block represents a terminal session.

CommandRecord represents one command.

The product domain is intentionally isolated from Wave internals.

## UI Direction

The long-term visual direction is a Windows 11 native-inspired interface with:

- Mica / Acrylic
- glass command cards
- subtle motion
- status highlighting
- Liquid Glass-inspired visual effects

Advanced visual work will not precede terminal correctness and compatibility.

## Development Strategy

The project follows a staged technical roadmap.

The first major risk gate validates:

- PowerShell command lifecycle events
- output boundaries
- exit semantics
- compatibility with the existing Wave runtime

The project will not proceed into heavy product development until these assumptions are validated.

See:

`docs/ROADMAP.md`

## Upstream

The current runtime foundation is based on Wave Terminal.

Wave Terminal is licensed under Apache-2.0.

Warp is used only as an architectural and interaction-design reference where appropriate.

## Status

Early architecture and feasibility stage.

Current phase:

**Phase 0 — Implementation Landing Design**

No production release is available yet.
