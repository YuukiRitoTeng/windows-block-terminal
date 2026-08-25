package shellintegration

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func TestPowerShellLifecycleCLIContract(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skipf("pwsh is required for the CLI integration harness: %v", err)
	}

	tests := []struct {
		name        string
		command     string
		wantSuccess bool
		wantExit    int
	}{
		{"success", `Write-Output "phase1-success"`, true, 0},
		{"powershell-failure", `throw "phase1-failure"`, false, 1},
		{"pipeline", `1..5 | Where-Object { $_ -gt 2 }`, true, 0},
		{"multiline", `1..3 | ForEach-Object {
    $_ * 2
}`, true, 0},
		{"mixed-native-tail", `Write-Output x | cmd /c exit 7`, true, 0},
		{"mixed-native-head", `cmd /c exit 7 | Write-Output`, true, 0},
	}
	if runtime.GOOS == "windows" {
		tests = append(tests, struct {
			name        string
			command     string
			wantSuccess bool
			wantExit    int
		}{"native-failure", `cmd /c exit 7`, false, 7})
	}

	var script strings.Builder
	script.WriteString("function wsh { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Args); return \"\" }\n")
	integration := strings.ReplaceAll(pwshWaveIntegration, "{{.WSHBINDIR_PWSH}}", "\"\"")
	integration = strings.ReplaceAll(integration, "{{.PATHSEP}}", ";")
	script.WriteString(integration)
	script.WriteString(`
$Global:_WAVETERM_SI_SESSION_EPOCH = "cli-phase1-epoch"
$Global:_WAVETERM_SI_HOOK_SEQUENCE = 0
$Global:_WAVETERM_SI_LAST_COMMAND_ID = $null
$Global:_WAVETERM_SI_LAST_COMMAND_NATIVE = $false
function Invoke-WaveCliCommand([string]$Name, [scriptblock]$Command) {
    $sequence = _waveterm_si_next_sequence
    $id = "{0}-{1}" -f $Global:_WAVETERM_SI_SESSION_EPOCH, $sequence
    $Global:_WAVETERM_SI_LAST_COMMAND_ID = $id
    $commandText = $Command.ToString()
    $Global:_WAVETERM_SI_LAST_COMMAND_NATIVE = _waveterm_si_is_direct_native_invocation $commandText
    _waveterm_si_emit "C" @{ v = 1; epoch = $Global:_WAVETERM_SI_SESSION_EPOCH; seq = $sequence; id = $id; cmd64 = (_waveterm_si_b64 $commandText); cwd64 = (_waveterm_si_b64 $PWD.Path) }
	$success = $true
	try {
	    & $Command
	    $success = [bool]$?
	} catch {
	    $success = $false
	}
	$nativeExitCode = $LASTEXITCODE
    _waveterm_si_command_finished $success $nativeExitCode
}

`)
	for _, test := range tests {
		script.WriteString("Invoke-WaveCliCommand ")
		script.WriteString(("'" + strings.ReplaceAll(test.name, "'", "''") + "'"))
		script.WriteString(" { ")
		script.WriteString(test.command)
		script.WriteString(" }")
		script.WriteString("\n")
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "phase1-harness.ps1")
	if err := os.WriteFile(path, []byte(script.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	var raw bytes.Buffer
	cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", path)
	cmd.Stdout = &raw
	cmd.Stderr = &raw
	if err := cmd.Run(); err != nil {
		t.Fatalf("pwsh harness failed: %v\n%s", err, raw.String())
	}

	var chunks []terminalruntime.OutputChunk
	var events []terminalruntime.IntegrationEvent
	adapter := terminalruntime.NewRuntimeAdapter("block-cli-phase1", func(chunk terminalruntime.OutputChunk) {
		chunks = append(chunks, chunk)
	}, func(event terminalruntime.IntegrationEvent) {
		events = append(events, event)
	})
	data := raw.Bytes()
	for start := 0; start < len(data); start += 11 {
		end := start + 11
		if end > len(data) {
			end = len(data)
		}
		adapter.ObserveOutput("block-cli-phase1", data[start:end])
	}
	adapter.Close()

	if len(chunks) < 2 {
		t.Fatalf("expected multiple output chunks, got %d", len(chunks))
	}
	for i, chunk := range chunks {
		if chunk.Sequence != uint64(i+1) {
			t.Fatalf("output sequence regressed at index %d: %#v", i, chunk)
		}
	}
	if len(events) != len(tests)*2 {
		t.Fatalf("expected %d lifecycle events, got %d: %#v", len(tests)*2, len(events), events)
	}
	for i, test := range tests {
		start := events[i*2]
		finish := events[i*2+1]
		if start.Kind != terminalruntime.EventCommandStarted || finish.Kind != terminalruntime.EventCommandFinished {
			t.Fatalf("%s did not produce C/D: %#v %#v", test.name, start, finish)
		}
		if start.CommandID == "" || start.CommandID != finish.CommandID || start.SessionEpoch != finish.SessionEpoch {
			t.Fatalf("%s lifecycle pairing mismatch: %#v %#v", test.name, start, finish)
		}
		if finish.Success == nil || *finish.Success != test.wantSuccess || finish.ExitCode == nil || *finish.ExitCode != test.wantExit {
			gotSuccess := "nil"
			if finish.Success != nil {
				gotSuccess = fmt.Sprintf("%t", *finish.Success)
			}
			gotExit := "nil"
			if finish.ExitCode != nil {
				gotExit = fmt.Sprintf("%d", *finish.ExitCode)
			}
			t.Fatalf("%s result mismatch: success=%s exit=%s event=%#v", test.name, gotSuccess, gotExit, finish)
		}
		if i > 0 && start.HookSequence <= events[i*2-1].HookSequence {
			t.Fatalf("hook sequence is not monotonic at %s", test.name)
		}
	}
}

func TestPowerShellIntegrationIsIdempotentAndSuppressesNestedChild(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skipf("pwsh is required for integration guard test: %v", err)
	}
	dir := t.TempDir()
	integrationPath := filepath.Join(dir, "wavepwsh.ps1")
	integration := strings.ReplaceAll(pwshWaveIntegration, "{{.WSHBINDIR_PWSH}}", "\"\"")
	integration = strings.ReplaceAll(integration, "{{.PATHSEP}}", ";")
	if err := os.WriteFile(integrationPath, []byte(integration), 0o600); err != nil {
		t.Fatal(err)
	}
	childPath := filepath.Join(dir, "child.ps1")
	childScript := fmt.Sprintf("function wsh { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Args); return \"\" }\n$env:WAVETERM_SWAPTOKEN = 'cli-test-token'\n. '%s'\nWrite-Output 'child-ok'\n", strings.ReplaceAll(integrationPath, "'", "''"))
	if err := os.WriteFile(childPath, []byte(childScript), 0o600); err != nil {
		t.Fatal(err)
	}
	harnessPath := filepath.Join(dir, "parent.ps1")
	harness := fmt.Sprintf("function wsh { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Args); return \"\" }\n$env:WAVETERM_SWAPTOKEN = 'cli-test-token'\n. '%s'\n$epoch1 = $Global:_WAVETERM_SI_SESSION_EPOCH\n. '%s'\n$epoch2 = $Global:_WAVETERM_SI_SESSION_EPOCH\nWrite-Output ('same-epoch=' + [bool]($epoch1 -eq $epoch2))\n$child = & '%s' -NoLogo -NoProfile -NonInteractive -File '%s'\n$child | Write-Output\n", strings.ReplaceAll(integrationPath, "'", "''"), strings.ReplaceAll(integrationPath, "'", "''"), strings.ReplaceAll(pwsh, "'", "''"), strings.ReplaceAll(childPath, "'", "''"))
	if err := os.WriteFile(harnessPath, []byte(harness), 0o600); err != nil {
		t.Fatal(err)
	}
	var raw bytes.Buffer
	cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath)
	cmd.Stdout = &raw
	cmd.Stderr = &raw
	if err := cmd.Run(); err != nil {
		t.Fatalf("guard harness failed: %v\n%s", err, raw.String())
	}
	output := raw.String()
	if !strings.Contains(output, "same-epoch=True") || !strings.Contains(output, "child-ok") {
		t.Fatalf("integration guard evidence missing: %q", output)
	}
	if strings.Contains(output, "16162;") {
		t.Fatalf("same-process or nested source emitted lifecycle frames: %q", output)
	}
}
