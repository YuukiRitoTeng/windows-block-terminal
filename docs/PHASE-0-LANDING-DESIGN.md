# Phase 0 — Implementation Landing Design

> Repository: windows-block-terminal
>
> Wave source baseline: main @ a4447c1563b2df285ab89e76c82f91e1a1a49c1e
>
> Scope: implementation landing design only. No product code is implemented in this phase.

Historical note: Phase 0–5 now provide a backend feasibility and domain
foundation. They do not constitute a fully frozen product architecture; the
product read/control path, output projection and persistence UX remain subject
to the Product Evidence Gate.

## 1. Verdict

B2+ has a viable landing path on the current Wave source, with one material qualification: Wave has an OSC 16162 parser, but its current PowerShell 7 integration does not emit command lifecycle events. The current script emits one M event with integration:false and OSC 7 for the current directory.

Recommended landing:

1. Add a read-only output observer in pkg/blockcontroller/blockcontroller.go:369-388, inside HandleAppendBlockFile before Wave persistence and publication.
2. Add PowerShell C/D emission to pkg/util/shellutil/shellintegration/pwsh_wavepwsh.sh:1-66.
3. Decode OSC 16162 in the raw output observer for Journal events, while preserving the existing xterm.js OSC handler.
4. Keep Command Journal in a new product-owned backend module; do not add CommandRecord to waveobj.Block.
5. Add future history UI beside TermWrap in frontend/app/view/term/term.tsx:181-345; do not put cards in TermWrap or xterm rendering.

This is low-to-medium intrusion if the observer is non-blocking and the PowerShell hook is isolated. It is No-Go if it requires rewriting ShellController, waveobj.Block, or xterm.js data flow.

## 2. Current Wave Integration Map

Runtime:

- pkg/blockcontroller/blockcontroller.go:68-75 defines Controller with Start, Stop, runtime status, connection name, and SendInput.
- pkg/blockcontroller/blockcontroller.go:324-331 routes input through the controller registry.
- pkg/blockcontroller/shellcontroller.go:51-80 stores BlockId, process status, exit code, and ShellProc.
- pkg/blockcontroller/shellcontroller.go:85-94 starts the controller.
- pkg/blockcontroller/shellcontroller.go:675-703 resolves the local shell.
- pkg/util/shellutil/shellutil.go:87-95 prefers pwsh, then powershell, then powershell.exe on Windows.
- pkg/shellexec/shellexec.go:583-692 starts the local process with pty.StartWithSize; PowerShell receives -ExecutionPolicy Bypass -NoExit -File at lines 610-612.

PTY and storage:

- pkg/blockcontroller/shellcontroller.go:525-569 owns the interactive PTY read loop.
- ShellProc.Cmd.Read reads bytes at lines 552-555 and passes them unchanged to HandleAppendBlockFile at lines 555-558.
- pkg/blockcontroller/blockcontroller.go:369-388 calls filestore.WFS.AppendData and publishes wps.Event_BlockFile with base64 data.
- Interactive term storage is circular: pkg/blockcontroller/shellcontroller.go:378-381 and pkg/blockcontroller/blockcontroller.go:45-46.
- Durable remote output has another path: pkg/jobcontroller/jobcontroller.go:814-835, handleAppendJobFile, and doWFSAppend.

Frontend:

- Generic Block view selection: frontend/app/block/block.tsx:29-43 and :269-301.
- TerminalView: frontend/app/view/term/term.tsx:181-201.
- TermWrap construction: frontend/app/view/term/term.tsx:296-334.
- Terminal file subscription and initialization: frontend/app/view/term/termwrap.ts:382-442.
- Terminal file append to xterm: frontend/app/view/term/termwrap.ts:479-518.
- Controller status subscription: frontend/app/view/term/term-model.ts:342-348.
- Event subscription: frontend/app/store/wps.ts:67-85.
- Terminal file subject: frontend/app/store/wps.ts:111-127.

## 3. PowerShell Integration Landing

Current file:

C:\Users\ROG\Downloads\my project2\waveterm-study\pkg\util\shellutil\shellintegration\pwsh_wavepwsh.sh

Confirmed current behavior:

- Lines 1-13 load the generated Wave script and completions.
- Lines 15-17 skip OSC setup below PowerShell 7.
- Lines 31-39 emit OSC 7 using $PWD.Path.
- Lines 41-52 emit one OSC 16162 M event.
- Line 47 sends integration:false.
- Lines 54-66 wrap only prompt metadata/current-directory behavior.
- There is no PSConsoleHostReadLine wrapper, C event, or D event.

Future C is added to this same template at the PowerShell input boundary immediately before the command is returned for execution. The hook obtains command text and cwdBefore from $PWD.Path and emits a shell-local monotonic hookSequence.

Future D is added to the wrapped prompt before the original prompt runs. The hook captures $? for PowerShell success semantics, $LASTEXITCODE for native-process semantics, $PWD.Path for cwdAfter, the same hookSequence, and sessionEpoch.

Ownership:

- PowerShell hook: command text, cwdBefore/cwdAfter, $?, $LASTEXITCODE, hookSequence.
- TerminalRuntimeAdapter: session identity and sessionEpoch.
- CommandJournalService: product CommandRecord.id and lifecycle state.
- The product stores both success and nullable exitCode; cmdlet status mapping is a Phase 1 decision.

The first event payload should include sessionEpoch, hookSequence, command text, cwdBefore, and protocolVersion. Product IDs must not be generated by waveobj.Block or persisted by the PowerShell script.

## 4. OSC C/D Event Path

Current real path:

~~~text
PowerShell bytes
  → ShellController.manageRunningShellProcess / ShellProc.Cmd.Read
  → HandleAppendBlockFile
  → Wave term file + Event_BlockFile
  → frontend/app/store/wps.ts file subject
  → TermWrap.handleNewFileSubjectData
  → TermWrap.doTerminalWrite
  → xterm.js parser
  → registerOscHandler(16162)
  → handleOsc16162Command
  → SetRTInfoCommand / local atoms
~~~

Locations:

- OSC registration: frontend/app/view/term/termwrap.ts:183-207.
- Parsing: frontend/app/view/term/osc-handlers.ts:284-305.
- C handling: frontend/app/view/term/osc-handlers.ts:98-137 and :325-327.
- D handling: frontend/app/view/term/osc-handlers.ts:348-355.
- RT info update: frontend/app/view/term/osc-handlers.ts:370-381.
- Wave runtime fields: pkg/waveobj/objrtinfo.go:10-20.

The frontend parser is real, but it updates Wave RT info asynchronously and is not a backend Journal source.

Recommended future path:

~~~text
raw bytes at HandleAppendBlockFile
  → per-session ShellIntegrationDecoder
  → normalized IntegrationEvent
  → TerminalRuntimeAdapter
  → CommandJournalService
~~~

The decoder parses only OSC 16162 framing/JSON, handles partial frames across reads, validates payloads, pairs C/D by sessionEpoch + hookSequence, and never alters original bytes. The existing frontend handler remains for Wave runtime metadata.

## 5. PTY Output Tap

Recommended hook:

~~~text
File: pkg/blockcontroller/blockcontroller.go
Function: HandleAppendBlockFile
Range: 369-388
Position: before filestore.WFS.AppendData
Input: blockId, blockFile, data []byte
~~~

Call relationship:

~~~text
ShellController.manageRunningShellProcess
  → ShellProc.Cmd.Read
  → HandleAppendBlockFile(blockId, "term", buf[:nr])
      → read-only output tap
      → existing filestore.WFS.AppendData
      → existing Event_BlockFile
      → unchanged xterm path
~~~

This point receives the same raw slice entering Wave storage, avoids editing the PTY loop, and precedes base64/event/frontend processing. The observer must use an immutable copy, avoid unbounded synchronous work, and have an explicit Phase 1 queue/backpressure policy.

The tap identifies blockId + blockFile. C/D spans, not guessed byte provenance, decide which bytes become CommandOutputSpan.

Not primary taps:

- frontend/app/store/wps.ts and TermWrap are too late and frontend-only.
- Event_BlockFile is UI delivery, not the authoritative raw-byte tap.
- Editing ShellController would couple Journal to process mechanics.
- pkg/jobcontroller/jobcontroller.go:814-835 is a separate durable remote path and needs a later adapter or explicit MVP exclusion.

## 6. TerminalRuntimeAdapter Boundary

Minimum product-facing capability set:

~~~text
TerminalRuntimeAdapter
├─ sessionIdentity(waveBlockId, sessionEpoch, shell metadata)
├─ sendInput(bytes)
├─ sendSignal(signal)
├─ resize(rows, cols)
├─ subscribeOutput(OutputChunk)
├─ subscribeIntegration(IntegrationEvent)
├─ subscribeStatus(SessionStatus)
├─ getShellMetadata()
└─ requestResync()
~~~

Wave internals must not cross the adapter: waveobj.Block/BlockDef, blockcontroller.Controller/ShellController/BlockInputUnion, shellexec.ShellProc/CmdWrap, wps.WaveEvent/WSFileEventData, wshrpc.CommandBlockInputData, RpcApi, Jotai atoms, TermWrap, or xterm.js Terminal.

The adapter translates Wave identities, controller calls, events, and byte chunks into product types. Journal owns command lifecycle and output attribution; Wave owns session lifetime.

## 7. Command Journal Boundary

Command Journal is a new backend module, not a Wave object extension.

Design-only layout:

~~~text
commandjournal/
├─ model/
├─ lifecycle/
├─ output/
├─ runtime/
└─ persistence/

frontend/commandjournal/
├─ CommandHistory
├─ CommandCard
└─ command-journal-store
~~~

No code directories are created in Phase 0.

CommandRecord is created by CommandJournalService on validated C. A matched D
completes execution and records success/exit code, while output attribution and
output completion remain independent. An explicit abnormal terminal state can
close unresolved output conservatively. `waveBlockId` is a reference only and
does not change Wave Block semantics.

## 8. Output Sequencer / Store

The tap feeds an ordered sequencer that assigns:

~~~text
sessionEpoch
sequence       // monotonic chunk/event order
byteOffset     // monotonic raw byte position
byteLength
waveBlockId
~~~

Decoder and sequencer consume the same ordered input. C establishes execution
and capture ownership; D is an execution-result event, not a physical output
fence. Only a separately proven causal fence can close output as complete;
otherwise liveness events close it as unknown/incomplete. OSC envelopes are
excluded from copy output and bytes outside a proven attribution window are not
silently assigned.

Command history cannot use Wave term as truth:

- Interactive term is circular and limited by DefaultTermMaxFileSize; see pkg/blockcontroller/shellcontroller.go:378-381 and pkg/blockcontroller/blockcontroller.go:45-46.
- Durable job output is circular with a 10 MiB setting in pkg/jobcontroller/jobcontroller.go:683-687.
- TermWrap restoration in frontend/app/view/term/termwrap.ts:521-552 is for resync, not immutable history.

CommandOutputStore must be append-only or chunk-addressed and independent from Wave term. Raw bytes are retained separately from any normalized copy-text snapshot.

## 9. Frontend Landing

Current relationship:

~~~text
Block → BlockFrame → view registry → TerminalView
  → TermViewModel → TermWrap → xterm.js Terminal
~~~

Minimum future layout:

~~~text
TerminalView
├─ CommandHistory
│  └─ completed Command Cards
└─ Active Terminal
   └─ existing TermWrap
      └─ existing xterm.js Terminal
~~~

The minimum existing component to change is frontend/app/view/term/term.tsx, because it owns TerminalView and creates TermWrap. Add a product-owned history sibling around the existing terminal container.

Do not modify TermWrap to render cards. Do not make generic Block/BlockFrame carry Journal semantics. Keep unchanged: TermWrap.onData → sendDataToController, ControllerInput RPC, WPS file subject → doTerminalWrite → terminal.write, xterm ANSI/VT parsing, OSC 16162 compatibility, resize, and resync.

## 10. Clear Ownership

Clear Visual History belongs to product UI and Journal projection, not Wave Runtime.

Future semantics:

~~~text
Clear Visual History
  → advance Journal visibility/history generation
  → hide/detach completed Card projections
  → clear xterm visual scrollback at a safe UI boundary
  → keep the same Wave Block, PTY, PowerShell, cwd, env, and venv
~~~

Do not use HandleTruncateBlockFile as product Clear:

- pkg/blockcontroller/blockcontroller.go:391-417 writes an empty terminal file, deletes cache, and publishes truncate.
- frontend/app/view/term/termwrap.ts:479-483 reacts by calling terminal.clear().

That is a Wave storage/resync operation. Product Clear must not truncate the Wave runtime stream.

## 11. End-to-End Event Flow

Current:

~~~text
PowerShell startup script
  → current M / OSC 7
  → PTY
  → ShellController.manageRunningShellProcess
  → ShellProc.Cmd.Read
  → HandleAppendBlockFile
  → Wave term file
  → Event_BlockFile
  → frontend WPS file subject
  → TermWrap.doTerminalWrite
  → xterm parser / RT-info handler
~~~

Future C:

~~~text
PowerShell input wrapper
  → OSC 16162 C
  → PTY bytes
  → HandleAppendBlockFile output tap
  → ShellIntegrationDecoder
  → IntegrationEvent(C, sessionEpoch, hookSequence, command, cwd)
  → TerminalRuntimeAdapter
  → CommandJournalService
  → CommandRecord RUNNING
~~~

The same bytes continue through the existing Wave term file, Event_BlockFile, TermWrap, and xterm.js path.

Future D/output:

~~~text
PTY bytes
  ├─→ existing Wave term stream → existing xterm.js
  └─→ output tap → OutputSequencer → CommandOutputStore → CommandOutputSpan

PowerShell prompt wrapper
  → OSC 16162 D
  → tap decoder
  → IntegrationEvent(D, sessionEpoch, hookSequence, success, exitCode, cwdAfter)
  → CommandJournalService
  → CommandRecord execution FINISHED, output PENDING/UNKNOWN
  → Command Card Projection only when output quality permits
~~~

The remaining validation concerns are ordering, partial OSC frames, queue/backpressure, and PowerShell exit semantics—not a missing PTY path.

## 12. Downstream Patch Budget

Expected Wave modifications:

| File | Reason | Change type | Intrusion |
|---|---|---|---|
| pkg/blockcontroller/blockcontroller.go | Read-only observer in HandleAppendBlockFile before persistence | Small hook/observer registration | Low–Medium |
| pkg/util/shellutil/shellintegration/pwsh_wavepwsh.sh | PowerShell C/D lifecycle and session metadata | Isolated integration change | Medium |
| frontend/app/view/term/term.tsx | Mount product-owned CommandHistory beside TermWrap | Additive composition | Low |
| pkg/wshrpc/ | Only if additive Journal query/clear/status RPCs need new transport | Additive API | Low–Medium |

No Phase 1 feasibility change should require modifying shellcontroller.go, shellexec.go, termwrap.ts, osc-handlers.ts, waveobj/wtype.go, waveobj/objrtinfo.go, block.tsx, or blockframe.tsx.

Future product-owned additions:

~~~text
commandjournal/
├─ model
├─ lifecycle
├─ output
├─ runtime
└─ persistence
frontend/commandjournal/
├─ CommandHistory
├─ CommandCard
└─ command-journal-store
~~~

## 13. Files That Must Remain Untouched

Preserve Wave Block meaning and persistence in pkg/waveobj/wtype.go. Preserve PTY creation/read/write in pkg/shellexec/shellexec.go and pkg/blockcontroller/shellcontroller.go. Preserve controller input routing except for the narrow observer hook. Preserve xterm creation, parser, terminal.write, onData, resize, and resync in termwrap.ts and term.tsx. Preserve Wave's existing OSC 16162 RT-info behavior in osc-handlers.ts. Preserve generic Block/BlockFrame semantics and existing terminal-file/RPC semantics.

Violating these boundaries is an architecture review event, not a routine feature change.

## 14. Phase 1 Go / No-Go Gate

### GO

Proceed when:

- PowerShell C/D are emitted exactly once for ordinary test commands.
- C/D pair by stable session identity + hookSequence.
- The raw tap receives the same byte order Wave sends to its terminal stream.
- Tap/decoder do not alter xterm-visible bytes.
- Split OSC sequences across reads are handled.
- Native success, native failure, PowerShell cmdlet, and multiline/pipeline cases have defined results.
- The same PowerShell process, cwd, env, and venv remain active after completion.
- Output spans exclude C/D envelopes, prompt, command echo, and next prompt.
- No rewrite of ShellController, waveobj.Block, or xterm.js is required.
- Journal remains independent behind the adapter.
- Wave remains clean and its terminal path remains operational.

### NO-GO / Re-evaluate

Re-evaluate B2+ or use a hybrid control-side-channel design if:

- PowerShell cannot reliably emit paired C/D.
- $? and $LASTEXITCODE cannot be captured before prompt mutation.
- Boundaries require xterm line positions rather than raw-byte sequencing.
- The observer blocks or rewrites the primary PTY path.
- CommandRecord must be inserted into waveobj.Block.
- Journal must depend on React state or delayed RT-info RPCs.
- xterm input, alternate screen, resize, or resync must change for Cards.
- Durable remote and local output cannot be separated by the adapter.
- Downstream changes must span ShellController, shellexec, TermWrap, and waveobj simultaneously.

## 15. Open Questions

1. Can a durable non-blocking observer queue avoid silent byte loss under slow storage?
2. Should sessionEpoch be adapter-generated and injected into the shell, or hook-generated and announced in metadata?
3. Should Phase 1 carry hookSequence only, or later return CommandRecord.id through a control side channel?
4. What exact mapping covers cmdlet errors, native exit codes, pipeline failures, and $??
5. How should interleaved background output be marked without false attribution?
6. Is the durable remote path excluded from MVP or given a second adapter?
7. What persistence and retention policy will CommandOutputStore use?
8. Can a backend decoder distinguish child-emitted OSC 16162 from trusted integration, or is a side channel needed?
9. What additive RPC/event surface delivers Card projections and Clear visibility generations?
10. At which prompt boundary can UI clear xterm scrollback without disturbing alternate screen or resync?

Phase 0 conclusion: B2+ is technically plausible, the local PowerShell path has a narrow output hook, and the primary unresolved risk is reliable PowerShell C/D emission plus lossless ordered output capture. No Phase 1 implementation is included here.
