# Task 1 report: Terminal-only first-launch baseline

## Implementation summary

- `GetStarterLayout` now returns the same single, focused terminal layout shape as the existing new-tab baseline: index `[0]`, `term` view, and `shell` controller.
- `EnsureInitialData` now creates the first-launch workspace as `Windows Block Terminal`, with `square-terminal` and `#58C142`.
- The first default workspace icon is now `square-terminal`. No existing persisted workspace is read, updated, or migrated by this change.

## Files changed

- `pkg/wcore/layout.go`
- `pkg/wcore/wcore.go`
- `pkg/wcore/workspace.go`
- `pkg/wcore/terminal_first_test.go`
- `.superpowers/sdd/2026-09-12-wbt-terminal-first-baseline/task-1-report.md`

## TDD evidence

### RED

Command:

```powershell
go test ./pkg/wcore -run 'TestGetStarterLayoutIsOneFocusedTerminal|TestEnsureInitialDataCreatesWBTStarterWorkspace' -count=1 -v
```

Output (before production edits):

```text
--- FAIL: TestGetStarterLayoutIsOneFocusedTerminal
    starter layout length = 4, want 1
--- FAIL: TestEnsureInitialDataCreatesWBTStarterWorkspace
    starter workspace name = "Starter workspace", want "Windows Block Terminal"
    starter workspace icon = "custom@wave-logo-solid", want "square-terminal"
    default workspace icon = "custom@wave-logo-solid", want "square-terminal"
FAIL
```

Reason: the frozen baseline still created four starter blocks and retained the Wave-branded starter/default workspace values.

### GREEN

Command:

```powershell
go test ./pkg/wcore -run 'TestGetStarterLayoutIsOneFocusedTerminal|TestEnsureInitialDataCreatesWBTStarterWorkspace' -count=1 -v
```

Output:

```text
=== RUN   TestGetStarterLayoutIsOneFocusedTerminal
--- PASS: TestGetStarterLayoutIsOneFocusedTerminal (0.00s)
=== RUN   TestEnsureInitialDataCreatesWBTStarterWorkspace
--- PASS: TestEnsureInitialDataCreatesWBTStarterWorkspace (0.00s)
PASS
ok      github.com/wavetermdev/waveterm/pkg/wcore
```

## Test results

Focused package command:

```powershell
go test ./pkg/wcore -count=1
```

Result:

```text
ok      github.com/wavetermdev/waveterm/pkg/wcore    0.057s
```

No `go build` or Windows packaging command was run, per the task boundary.

## Self-review

- Scope is limited to the three required product-default locations and one new deterministic Go test file.
- `GetNewTabLayout` was inspected and is unchanged.
- No frontend, onboarding, AI/Web, History/Card, CVA, Journal, Clear, PTY, hosted PowerShell, shell integration, migration, or persistence-semantics changes were made.
- The starter identity test statically verifies the direct `CreateWorkspace` arguments in `EnsureInitialData`; this avoids mutating a user data store during the package test. The runtime database path could not be exercised in this environment because the available Go runtime has `CGO_ENABLED=0`, while the project's SQLite driver requires CGO.
- `git diff --check` completed without whitespace errors. The pre-existing untracked `.review/` directory was not modified or included.

## Concerns

- Focused Go package coverage is green. A full first-launch SQLite integration acceptance remains not run here because no C compiler is available for the CGO-dependent SQLite driver; the static contract test and direct diff inspection cover the exact identity arguments instead.
