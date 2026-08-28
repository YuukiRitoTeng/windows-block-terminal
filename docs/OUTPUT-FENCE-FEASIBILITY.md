# Windows/ConPTY Output-Fence Feasibility

> **Historical diagnostic evidence.** This document records the evidence that rejected OSC `D` / prompt lifecycle as a physical PTY output fence. That conclusion remains part of the current architecture. The Product Evidence Gate later became **GO** by using hosted structured output for ordinary commands; no ConPTY fence was discovered or promoted to authority. For current status, read `docs/PROJECT-STATUS.md`. For the current output-truth contract, read `docs/CONDITIONAL-ARCHITECTURE-FREEZE.md`.

This is a diagnostic record for the execution/output contract correction. It
does not introduce a production protocol or use timing as a correctness rule.

## Environment

- Windows 11 Home, build `10.0.26200` (x64)
- PowerShell `7.6.4`
- Wave source baseline: `199410bb`
- Runtime path: Wave `ShellController` → `shellexec` → Windows PTY/ConPTY
- Test path: real `pwsh.exe`, the current `pwsh_wavepwsh.sh` template, and the
  existing `creack/pty` Windows harness

## Candidate tested

The existing OSC 16162 `D` event was tested as the only currently available
candidate execution/output fence. `P`, OSC 7, and the next `C` were observed as
semantic/liveness events; no new marker or side channel was added.

The diagnostic harness repeated ordinary `Write-Output` commands in a fresh
PowerShell PTY and also exercised native failure, a pipeline, physical
multiline input, large fragmented output, background-job output, and Ctrl+C
recovery. A short post-prompt collection window was used only to observe
relative ordering; it is not a production boundary.

## Observed ordering

The same fresh ConPTY path produced both forms:

```text
C → output → D → P
C → D → P → output
```

The matrix also observed output markers after `P` for pipeline, multiline and
background cases, and many output chunks for a large command spanning the
lifecycle markers. OSC 7 and prompt bytes were present in the same stream.

These observations match the two previously captured Wave production runs and
are sufficient to reject `D` as a physical output fence on this baseline.

## Result at this diagnostic stage

No reliable causal output fence was found. The system at this stage therefore
kept execution records usable while degrading PTY-derived output quality
conservatively:

- `D` records execution success, exit code, and execution finish time.
- Output starts with unknown quality and becomes pending after `D`.
- `P`, next `C`, epoch change, detach, and session close close unresolved
  output as unknown/incomplete; they do not prove attribution.
- Bytes after `D` are not assigned wholesale to the previous command.
- `complete` / `exclusive` PTY-derived output remains unsupported without a
  causal fence for the supported Windows/ConPTY baseline.

At the time of this diagnostic, Product Evidence Gate remained **NO-GO**.

Later work did **not** overturn this result. Instead, ordinary-command authority
moved to the Hosted PowerShell structured sidechannel, which can provide trusted
structured output independently of PTY-drain timing. Interactive programs remain
on the PTY/xterm path and continue to degrade conservatively when exact output
cannot be proven.
