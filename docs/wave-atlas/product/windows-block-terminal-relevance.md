# Windows Block Terminal Relevance

## Runtime Core

PTY, PowerShell shell process, ShellController, blockcontroller, RPC/event transport, terminal stream/file boundary, xterm.js/TermWrap, session/workspace lifecycle, resize/input/output paths.

## Shared Infrastructure

wshrpc types/clients/server, event history, filestore, workspace model, Electron startup and packaging. These may be indirectly required even when Wave product features are hidden.

## Wave Product Layer

AI/Agent, Browser, Editor, Widgets, Preview and associated views are product-surface candidates, subject to coupling review.

## New Product Layer

Command Journal, CommandRecord, lifecycle state machine, Output Sequencer/Store, Command History/Card projection, Clear Visual History and Liquid Glass UI. Likely seams: TerminalRuntimeAdapter around controller/output observation; independent persistence beside filestore; frontend history mounted beside TermWrap.