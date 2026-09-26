package shellintegration

import (
	_ "embed"
	"strings"
	"testing"
)

//go:embed pwsh_wavepwsh.sh
var pwshWaveIntegration string

func TestPowerShellIntegrationContainsVersionedLifecycleHooks(t *testing.T) {
	for _, marker := range []string{"16162", "_waveterm_si_command_started", "_waveterm_si_command_finished", "_waveterm_si_prompt_ready", "WAVETERM_SI_OWNER_PID", "WAVETERM_SI_INSTALLED", "Set-PSReadLineKeyHandler", "cmd64", "cwd64", "_WAVETERM_SI_SESSION_EPOCH", "_WAVETERM_SI_HOOK_SEQUENCE", "LASTEXITCODE"} {
		if !strings.Contains(pwshWaveIntegration, marker) {
			t.Errorf("integration script missing %q", marker)
		}
	}
}

// The finish and prompt-ready frames are built in that order and returned with
// the prompt text, so the host renders them once the command's output is in the
// stream. Nothing in this path waits on a timer.
func TestPowerShellIntegrationOrdersFinishBeforePromptReady(t *testing.T) {
	body := pwshWaveIntegration[strings.Index(pwshWaveIntegration, "function Global:_waveterm_si_prompt {"):]
	finish := strings.Index(body, "_waveterm_si_command_finished $lastSuccess $nativeExitCode")
	prompt := strings.Index(body, "$frames += _waveterm_si_prompt_ready")
	if finish < 0 || prompt < 0 || finish > prompt {
		t.Fatalf("PromptReady must be built after the command finish: finish=%d prompt=%d", finish, prompt)
	}
	if !strings.Contains(body, "return $frames") {
		t.Fatal("the prompt frames must be returned so the host renders them with the prompt")
	}
	for _, forbidden := range []string{"Start-Sleep", "[Console]::Out.Flush", "[Console]::Error.Flush", "CursorPosition", "Out-Default"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("the prompt path must not use %q: ordering cannot depend on a wait", forbidden)
		}
	}
}

func TestPowerShellIntegrationBlocksCommandStartForMultiplexedTerminals(t *testing.T) {
	start := strings.Index(pwshWaveIntegration, "function Global:_waveterm_si_command_started")
	if start < 0 {
		t.Fatal("command start helper missing")
	}
	body := pwshWaveIntegration[start:]
	blocked := strings.Index(body, "if (_waveterm_si_blocked) { return $false }")
	sequence := strings.Index(body, "_waveterm_si_next_sequence")
	if blocked < 0 || sequence < 0 || blocked > sequence {
		t.Fatal("blocked terminal guard must precede lifecycle sequence allocation")
	}
}
