# Release Candidate Readiness Gate

Status date: 2026-08-28<br>
Baseline: `origin/main` at `d445e828d19a124467cb5d7c63923cc8b2ee93c6`

This document defines the evidence gate for entering a Windows Block Terminal
Release Candidate. It is a readiness contract, not a new architecture design.
The responsibility and truth boundaries in
`docs/CONDITIONAL-ARCHITECTURE-FREEZE.md` remain authoritative.

## Status model

Every acceptance item uses exactly one of these statuses:

- `PASS`
- `FAIL`
- `EXPLICITLY UNSUPPORTED`
- `NOT YET TESTED`
- `EVIDENCE EXISTS — REVALIDATION NEEDED`

An item is not a `PASS` without repository or recorded manual evidence for the
current release target. No formal RC artifact or supported RC configuration has
yet been declared. The existing Product Evidence, Packaging and Release
Hardening records are pre-RC / baseline evidence: they establish capabilities,
but cannot be treated as RC `PASS` until revalidated against the declared RC
artifact and supported configuration. `NOT YET TESTED` is not silently accepted
as a release decision. An item may become `EXPLICITLY UNSUPPORTED` only through
a documented scope decision before the RC gate closes.

## 1. Current baseline

The current `main` line is an installable Windows MVP foundation / preview. The
repository and merged evidence establish:

- Wave / ConPTY / xterm.js remains the live terminal authority;
- hosted PowerShell uses one host process and one persistent Runspace;
- ordinary PowerShell commands have structured lifecycle and output data;
- Command Journal and SQLite persistence own durable command history;
- trusted output is gated by provenance, completeness, text safety and
  truncation metadata;
- Clear Visual History removes visible history without restarting the shell,
  PTY or Runspace;
- Windows x64 packaging, installation, uninstall, restart and A → B upgrade
  preservation have evidence;
- the first Windows Block Terminal visual identity pass is merged and has
  manual GUI acceptance.

This baseline is not a signed or supportable production release. The current
stage is the Release Candidate Readiness Gate. A formal RC artifact and
supported RC configuration are not yet declared; all evidence listed above is
therefore pre-RC / baseline evidence pending RC-target revalidation.

## Status inventory

Across the interactive, recovery, release and performance acceptance tables in
this document:

| Status                                  | Count |
| --------------------------------------- | ----: |
| `PASS`                                  |     0 |
| `FAIL`                                  |     3 |
| `EXPLICITLY UNSUPPORTED`                |     0 |
| `NOT YET TESTED`                        |    12 |
| `EVIDENCE EXISTS — REVALIDATION NEEDED` |    20 |

## 2. Interactive compatibility matrix

The product advertises a live PTY/xterm terminal. A scenario is release
blocking unless it is explicitly excluded from the supported configuration.

| Scenario                                            | Current Status                          | Existing Evidence                                                                                                                  | Acceptance Criteria                                                                                                                                       | RC Blocking If Failed?           |
| --------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `vim`                                               | `NOT YET TESTED`                        | Phase 4 defines the outer-command model, but no current RC run of `vim` is recorded.                                               | Full-screen editing, input, exit, return to outer prompt, no false ordinary-command Card, no loss of terminal modes.                                      | YES — unless explicitly excluded |
| `fzf`                                               | `NOT YET TESTED`                        | No current repository evidence for an `fzf` workload.                                                                              | Interactive input and selection work, terminal modes restore, exit returns to the outer prompt.                                                           | YES — unless explicitly excluded |
| `ssh`                                               | `NOT YET TESTED`                        | The architecture keeps SSH on the PTY path; no current RC SSH run is recorded.                                                     | Local outer command remains one interactive record; remote input/output is not reclassified as local structured commands; exit restores the outer prompt. | YES — unless explicitly excluded |
| Python REPL                                         | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Hosted-runtime evidence records realtime Python input/output and normal exit; the evidence predates this RC gate.                  | Realtime input/output, normal exit, return to the same outer session, no exact post-hoc output claim without a separate guarantee.                        | YES — unless explicitly excluded |
| Nested PowerShell                                   | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Phase 4 records nested PowerShell as an outer interactive workload; current project status still lists the release matrix as open. | Nested shell remains one outer interactive workload, exits cleanly, and does not create a second authoritative hosted session.                            | YES — unless explicitly excluded |
| Alternate-screen                                    | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Phase 4 has deterministic ConPTY coverage for alternate-screen bytes, but not a current packaged RC workload.                      | Alternate-screen enter/leave does not create ordinary Cards or corrupt the live xterm surface.                                                            | YES — unless explicitly excluded |
| Terminal resize / reflow                            | `NOT YET TESTED`                        | Current project status identifies resize/reflow stress as unproven.                                                                | Resize during an active workload preserves input, output, cursor state and return to the outer prompt.                                                    | YES — unless explicitly excluded |
| Ctrl+C                                              | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Hosted-runtime and Phase 1 evidence records native foreground Ctrl+C, child termination and prompt recovery.                       | Ctrl+C stops the foreground workload, returns to a usable prompt, keeps the host/session alive and does not create a false successful record.             | YES — unless explicitly excluded |
| Interactive program exit → ordinary command resumes | `EVIDENCE EXISTS — REVALIDATION NEEDED` | The hosted single-Runspace evidence records normal interactive exit followed by ordinary commands and preserved state.             | The next ordinary command executes in the same supported session with preserved cwd/session state and no second shell/runspace.                           | YES — unless explicitly excluded |

Interactive output remains conservative: exact post-hoc Copy/Show Output is not
promised without independent causal evidence.

## 3. Recovery matrix

Recovery criteria require deterministic state, no false success and no
permanently running record. Existing code-level recovery semantics are not
equivalent to a current packaged-RC run.

| Scenario                           | Current Status                          | Existing Evidence                                                                                                                               | Acceptance Criteria                                                                                                                                                    | RC Blocking If Failed?           |
| ---------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Hosted PowerShell process failure  | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Phase 3 defines `session_ended`, `controller_stop`, `pty_error` and related abort reasons; no current packaged process-failure run is recorded. | Active work is closed conservatively, no false success is written, the failure is observable, and a supported recovery path is available.                              | YES — unless explicitly excluded |
| Sidechannel disconnect             | `NOT YET TESTED`                        | Authenticated sidechannel and stale-identity rejection are covered; a live disconnect scenario is not recorded.                                 | Terminal remains safe, trusted structured output is not fabricated, active records become an explicit degraded/aborted state, and reconnection behavior is documented. | YES — unless explicitly excluded |
| Shell / Runspace failure           | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Journal and controller termination fences provide deterministic abort reasons; no current RC fault-injection run is recorded.                   | Runspace loss is visible, active records do not remain permanently running, and no second session is silently introduced.                                              | YES — unless explicitly excluded |
| Frontend reconnect                 | `NOT YET TESTED`                        | Wave has reconnect infrastructure, but product Command History reconnect behavior is not evidenced for this RC.                                 | Reconnect does not resurrect stale records, lose durable records, or change the live terminal authority.                                                               | YES — unless explicitly excluded |
| App restart                        | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Persistence evidence covers restart restore and conservative recovery of stale running rows.                                                    | Finished durable records and safe output metadata restore; unfinished work is recovered conservatively; no data loss occurs.                                           | YES                              |
| Packaged app restart               | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Windows packaging evidence records installed-app restart and durable record restoration.                                                        | The declared RC artifact starts, wavesrv is ready, hosted resources resolve, and durable history remains available.                                                    | YES                              |
| Clear Visual History               | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Product Evidence Stage 5 and packaging evidence record card/scrollback clearing with PID, cwd, environment and session preservation.            | Visible Cards and rendered scrollback clear; shell, PTY, host, Runspace, cwd and session state remain unchanged for the declared RC configuration.                     | YES                              |
| Upgrade → durable history recovery | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Installer A → B evidence retains all six original record IDs and metadata with no migration error.                                              | In-place upgrade of the declared RC artifact keeps existing records/output metadata, starts normally and reports no migration or recovery failure.                     | YES                              |

## 4. Release readiness

| Item                                       | Current Status                          | Existing Evidence                                                                                                       | Acceptance Criteria                                                                                                     | RC Blocking If Failed? |
| ------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Windows x64 artifact                       | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Windows Packaging MVP evidence records an NSIS artifact and installed resource tree.                                    | The declared Windows x64 RC artifact installs and launches in the supported configuration.                              | YES                    |
| Reproducible hosted-runtime publish        | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Isolated .NET 8.0.424 restore/build/publish evidence and executable hash comparison are recorded.                       | The hosted runtime is rebuilt for the declared RC artifact from the declared source/SDK inputs with matching evidence.  | YES                    |
| Code signing                               | `FAIL`                                  | The current artifact is explicitly recorded as unsigned.                                                                | The RC artifact is signed with the downstream release identity and signature verification is recorded.                  | YES                    |
| Install                                    | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Installed-product manual acceptance and wavesrv-ready evidence are recorded.                                            | Clean installation of the declared RC artifact launches the app and creates the correct downstream data identity.       | YES                    |
| Upgrade                                    | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Installer A → B silent overlay upgrade exited successfully and retained durable history.                                | Supported in-place upgrade of the declared RC artifact preserves application behavior and durable user data.            | YES                    |
| Uninstall / data separation                | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Uninstall evidence shows application removal while the downstream data marker remains.                                  | Uninstall behavior for the declared RC artifact is documented and does not silently delete durable user history.        | YES                    |
| Update channel                             | `FAIL`                                  | No downstream update feed manifest is configured; packaged builds skip auto-update.                                     | A supported update channel is implemented and tested, or the absence is explicitly documented as an RC scope exclusion. | YES                    |
| Rollback policy                            | `NOT YET TESTED`                        | No current repository evidence records a rollback policy or run.                                                        | A failed update has a documented, testable rollback path that preserves user data.                                      | YES                    |
| Support policy                             | `NOT YET TESTED`                        | No current repository evidence records supported versions, diagnostics or recovery expectations.                        | Supported versions, diagnostics collection and user-facing recovery/support responsibilities are documented.            | YES                    |
| Privacy / retention / diagnostics          | `NOT YET TESTED`                        | Implementation limits and token-safety evidence exist; a complete user-facing policy is not recorded.                   | Local history retention, diagnostic contents, deletion behavior and optional telemetry boundaries are documented.       | YES                    |
| ACL / local data protection                | `NOT YET TESTED`                        | The current hardening record identifies Windows ACL/secure-storage policy as open.                                      | The supported local data protection expectation and verification are documented.                                        | YES                    |
| LICENSE / NOTICE / third-party attribution | `EVIDENCE EXISTS — REVALIDATION NEEDED` | `LICENSE`, `NOTICE`, `ACKNOWLEDGEMENTS.md` and upstream attribution are present.                                        | A final release review confirms Apache-2.0, NOTICE, third-party and downstream attribution obligations.                 | YES                    |
| Remaining product branding cleanup         | `FAIL`                                  | The first identity pass is merged, but visible Wave-derived title, menu, updater, onboarding and asset surfaces remain. | User-facing product identity is coherent while required legal attribution is preserved.                                 | YES                    |

## 5. Performance / history policy

| Item                              | Current Status                          | Existing Evidence                                                                                             | Acceptance Criteria                                                                                                            | RC Blocking If Failed? |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| 100-record visible-history policy | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Release hardening bounds visible reads to the newest 100 records and restores chronological order.            | The limit is documented as a product policy, remains bounded and does not violate durable-history ownership for the RC target. | YES                    |
| Large-history evidence            | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Stress evidence inserts 150 records and verifies the newest 100 are returned without loading output payloads. | History refresh remains bounded and lazy for the declared RC artifact and workload.                                            | YES                    |
| Long-output bounds                | `EVIDENCE EXISTS — REVALIDATION NEEDED` | Durable output is bounded at 10 MiB and presentation output at 64 KiB with metadata reconciliation.           | Long output remains safe, lazy and honest about truncation/completeness for the RC target.                                     | YES                    |
| Pagination / virtualization       | `NOT YET TESTED`                        | No current pagination path or Card virtualization evidence is recorded.                                       | The RC scope explicitly chooses and verifies pagination/virtualization behavior for the supported history scale.               | YES                    |
| Explicit performance budgets      | `NOT YET TESTED`                        | Current status identifies startup, memory, scrolling and long-output budgets as open.                         | Startup, memory, scrolling and output budgets are written, measured and accepted for the RC target.                            | YES                    |

The 100-record limit and current frontend/persistence implementation are product
decisions, not architecture invariants. They may evolve without changing the
frozen ownership and truth boundaries.

## 6. TestDriver RC acceptance gate

TestDriver is a release-candidate GUI acceptance gate, not routine PR or
`main`-push CI. The policy established by PR #76 is:

- `.github/workflows/testdriver-build.yml` is manual-only through
  `workflow_dispatch` unless a future documented RC automation explicitly
  changes this policy;
- `.github/workflows/testdriver.yml` may run acceptance only after a successful
  manual TestDriver build; failed or non-manual upstream runs are not acceptance
  evidence;
- `Build for TestDriver.ai` and `TestDriver.ai Run` are not required status
  checks for ordinary PRs or routine `main` updates, and branch protection must
  not require the manual TestDriver build while this policy is in force;
- a TestDriver `PASS` requires the real TestDriver job to execute through
  authentication, exact `windows-exe` artifact retrieval, installation,
  Windows Block Terminal launch, and the onboarding scenario with a successful
  exit;
- `skipped`, authentication failure, artifact failure, installation failure,
  immediate application exit, or onboarding failure must never be interpreted
  as a TestDriver `PASS`;
- OIDC is the primary authentication path and requires the repository/account to
  be authorized in the TestDriver console; `TD_API_KEY` is an optional fallback.
  Missing authorization or credentials is `BLOCKED BY AUTH`, not a product test
  result;
- until a formal RC artifact/tag convention is declared, TestDriver is started
  manually against the chosen RC-target commit and the workflow run URL plus
  commit SHA should be recorded as RC evidence.

A future automatic RC-tag integration is a separate workflow-policy change. It
must not silently restore TestDriver execution on ordinary PRs, routine
`main` pushes, or scheduled dependency churn.

## 7. RC exit criteria

The Release Candidate Readiness Gate passes only when every RC-blocking item is
either:

1. `PASS`, with evidence tied to the declared RC artifact and supported
   configuration; or
2. `EXPLICITLY UNSUPPORTED`, with a written scope decision, user-visible
   behavior and no contradictory product claim.

The following conditions are mandatory:

- no `FAIL` remains;
- no `NOT YET TESTED` item is silently treated as complete;
- every `EVIDENCE EXISTS — REVALIDATION NEEDED` item is revalidated against the
  RC target or explicitly scoped out;
- ordinary lifecycle, output-safety, persistence, Clear and frontend
  regressions remain green;
- the Conditional Architecture Freeze remains intact;
- the upstream condition is handled according to the established rehearsal
  policy, without treating an unmerged candidate as a dependency.

## 8. First execution batch

Do not execute this batch as part of creating the gate. It is the first planned
RC evidence batch, limited to high-value terminal compatibility and recovery
checks:

1. Packaged Windows app: Python REPL realtime input/output, normal exit, then
   one ordinary PowerShell command.
2. Packaged Windows app: nested PowerShell entry/exit, followed by outer-session
   state continuity.
3. Packaged Windows app: `vim` alternate-screen entry/exit with a resize while
   active.
4. Packaged Windows app: `fzf` interactive selection and exit, if the declared
   supported test image includes `fzf`; otherwise record an explicit scope
   decision rather than silently skipping it.
5. Packaged Windows app: native foreground workload, manual Ctrl+C, prompt
   recovery and one ordinary command afterward.

SSH, sidechannel disconnect, shell/Runspace failure and frontend reconnect are
high-value follow-up scenarios after this first batch because they require
additional environment or fault-injection setup. They remain RC-blocking until
they are `PASS` or explicitly excluded.

This document records the plan only; none of these scenarios is executed by
the document-creation task.

## Architecture boundary

The RC gate does not change the current architecture:

- Wave / ConPTY / xterm.js remains the live terminal authority;
- `CommandRecord` remains independent of Wave Block;
- hosted PowerShell remains one host process and one persistent Runspace;
- ordinary structured output remains sourced from the authenticated hosted
  sidechannel, not PTY heuristics;
- interactive output remains conservative;
- Clear does not restart shell, PTY or Runspace;
- durable history remains independent of xterm scrollback and Wave terminal
  files.

No item in this gate is an Architecture Review trigger by itself. A trigger
occurs only if closing an item requires changing one of the frozen boundaries,
introducing a second authoritative session, bypassing provenance, or broadly
rewriting Wave terminal core.
