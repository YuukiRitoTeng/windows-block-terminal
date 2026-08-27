# Upstream Maintainability Rehearsal Decision

Status: **PASS WITH CONDITIONS**  
Decision date: **2026-08-27**

This document records the approved result of the first candidate-based Fork Isolation / Upstream Maintainability Rehearsal. It is an evidence record for fork/upstream maintenance decisions. It does not replace `CONDITIONAL-ARCHITECTURE-FREEZE.md`; the frozen architecture invariants remain authoritative.

## Final decision

- Rehearsal verdict: **PASS WITH CONDITIONS**
- Architecture Review: **NOT TRIGGERED**
- Conditional Architecture Freeze: **KEEP**
- Evidence level: **candidate-level only**
- `.NET publish` evidence gap: **CLOSED**
- Release-level upstream maintainability: **not yet proven**

## Fixed inputs

The rehearsal used fixed, reproducible inputs and must be interpreted against these exact SHAs:

- downstream baseline: `1671c83a73645c71f06a1f71060c7ef3fb71fead`
- Wave upstream baseline: `a4447c1563b2df285ab89e76c82f91e1a1a49c1e`
- candidate: `wavetermdev/waveterm` PR #3484
- candidate head: `8a3115cff4ff18fb65f651bbe63ea43e704f081a`

The candidate was intentionally used because upstream `main` still matched the locked Wave baseline, so rehearsing a direct merge of upstream `main` would have been an empty test.

## Rehearsal definition

The approved rehearsal was a fixed-candidate three-way merge plus dependency-boundary audit. The purpose was not merely to prove that Git could merge the trees. The decision depended on all of the following:

- conflict locality;
- dependency direction;
- product-owned module isolation;
- preservation of frozen architecture invariants;
- regression evidence.

`TerminalRuntimeAdapter` isolation and narrow seam concentration were treated as hypotheses to validate, not as assumptions.

## Static overlap result

Relative to the common Wave baseline:

- downstream changed paths: **91**
- candidate changed paths: **16**
- overlap paths: **3**
- unexpected overlap: **none**

The overlap was exactly:

- `frontend/app/view/term/term.tsx`
- `frontend/types/gotypes.d.ts`
- `pkg/blockcontroller/blockcontroller.go`

These were the predeclared seam/shared-file allowlist for this candidate.

## Merge result

- `git merge-tree --write-tree`: **clean**
- disposable `git merge --no-commit --no-ff`: **clean**
- merge conflicts: **0**
- conflict hunks: **0**
- manual adaptations: **0**
- product-owned conflicts: **none**
- Wave-core conflicts: **none**
- architecture-boundary pressure: **none observed**

A temporary rehearsal merge commit was created only inside the disposable environment for testing and was not pushed or retained in the formal repository.

## Dependency-boundary result

No new Wave-core to product-domain dependency was introduced by the candidate merge.

The rehearsal did not show expansion of Wave-owned controller knowledge into additional Command Journal, `terminalruntime`, hosted-runtime, persistence, or Command History product semantics. Existing downstream integration edges remained intact.

A clean merge by itself is not sufficient evidence of isolation; the positive result here depends on the clean merge **and** the dependency-boundary audit.

## Frozen invariant result

The rehearsal found no evidence that the candidate invalidated the current freeze. The following responsibility/truth boundaries remained intact:

- Wave / ConPTY / xterm.js remains the sole live terminal authority;
- `CommandRecord` remains separate from Wave Block;
- one authoritative PowerShell session / persistent Runspace remains the model;
- ordinary structured output remains authoritative through the hosted structured sidechannel;
- PTY is not promoted back to ordinary structured-output authority;
- interactive output remains conservative and is not promoted to exact post-hoc attribution;
- Execution Completion, Output Attribution, and Output Completion remain distinct;
- trusted-output provenance/guarantee metadata remains enforced;
- Clear Visual History does not restart the shell, PTY, Runspace, or session;
- durable product history remains independent of xterm scrollback and Wave term-file storage.

Therefore **Architecture Review was not triggered** and the current Conditional Architecture Freeze remains **KEEP**.

## Test evidence

The merged rehearsal tree passed:

- targeted Go tests;
- corrected Command Journal service tests;
- race tests;
- `go vet`;
- Command History Vitest;
- candidate tmux/session Vitest;
- touched frontend ESLint;
- `npm run build:dev`;
- `git diff --check`.

Baseline ESLint had previously been invoked with an invalid command; no false baseline PASS is claimed. The merged-tree touched-file ESLint result is the valid evidence recorded here.

## .NET publish evidence closure

The previously blocked `.NET publish` check was rerun against a reconstructed copy of the same fixed candidate merge tree and passed without modifying the formal repository.

Closure evidence:

- SDK source: official Microsoft `dotnet-install.ps1`
- SDK version: `.NET SDK 8.0.424`
- SDK installation: isolated / temporary; no system modification
- merge reconstruction: **clean**
- manual adaptations: **none**
- `dotnet restore`: **PASS**, exit code `0`
- `dotnet build --configuration Release --framework net8.0`: **PASS**, exit code `0`
- `dotnet publish --configuration Release --framework net8.0 --runtime win-x64`: **PASS**, exit code `0`
- published artifact: `WbtHostedPowerShell.exe`
- artifact size: `152064` bytes
- artifact SHA-256: `E2A18611D991627AA59467E9A5FA98869E12934F5C3C5EE77BE902E6BBAD8450`
- formal repository branch before/after: `feat/product-evidence-gate`
- formal repository HEAD before/after: `c86bb63bc9b827e59a887ca81400f8df9aed1d92`
- formal repository working tree before/after: **clean**

The retained closure evidence directory is:

`C:\Users\ROG\AppData\Local\Temp\wbt-upstream-rehearsal-20260827-131703-974\dotnet-publish-closure`

This closes the `.NET publish` evidence gap only. It does not strengthen the rehearsal beyond candidate-level while upstream PR #3484 remains unmerged.

## Remaining evidence limitation

One limitation remains and must not be silently upgraded away:

1. upstream PR #3484 was still unmerged when this rehearsal was performed. The result therefore does **not** prove release-level upstream maintainability.

The retained local evidence directory from the rehearsal was:

`C:\Users\ROG\AppData\Local\Temp\wbt-upstream-rehearsal-20260827-131703-974`

That path is an execution-time evidence location, not a repository-owned durable artifact.

## Interpretation for future agents

Do not reinterpret this decision as either of the following:

- "fork isolation is permanently proven";
- "any future clean merge automatically passes maintainability review".

The supported conclusion is narrower:

> Against the fixed upstream PR #3484 candidate head, the current downstream architecture demonstrated clean three-way integration, expected seam-only overlap, no new Wave→product dependency, no manual adaptation, preserved frozen invariants, and passing regression evidence including the hosted PowerShell `.NET 8` restore/build/publish closure.

Future upstream rehearsals must continue to assess conflict locality **and** dependency direction. A clean merge with new Wave→product coupling is not a PASS.

## Approved next action

Do not open a new architecture redesign from this result.

The approved follow-up is:

1. preserve this candidate-level decision and its evidence;
2. if PR #3484 is merged upstream, rerun the same rehearsal policy against the final upstream merge SHA;
3. continue to describe the current result as candidate-level until final upstream evidence justifies a stronger statement.

Any future evidence that triggers the Architecture Review conditions in `CONDITIONAL-ARCHITECTURE-FREEZE.md` takes precedence over this candidate-level positive result.
