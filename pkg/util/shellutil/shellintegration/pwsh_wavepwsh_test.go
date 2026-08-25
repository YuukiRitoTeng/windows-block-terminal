package shellintegration

import (
	_ "embed"
	"strings"
	"testing"
)

//go:embed pwsh_wavepwsh.sh
var pwshWaveIntegration string

func TestPowerShellIntegrationContainsVersionedLifecycleHooks(t *testing.T) {
	for _, marker := range []string{"16162", "_waveterm_si_command_started", "_waveterm_si_command_finished", "_waveterm_si_prompt_ready", "Set-PSReadLineKeyHandler", "cmd64", "cwd64", "_WAVETERM_SI_SESSION_EPOCH", "_WAVETERM_SI_HOOK_SEQUENCE", "LASTEXITCODE"} {
		if !strings.Contains(pwshWaveIntegration, marker) {
			t.Errorf("integration script missing %q", marker)
		}
	}
}

func TestPowerShellIntegrationEmitsPromptReadyAfterFinish(t *testing.T) {
	finish := strings.Index(pwshWaveIntegration, `_waveterm_si_emit "D"`)
	prompt := strings.Index(pwshWaveIntegration, `_waveterm_si_emit "P"`)
	if finish < 0 || prompt < 0 || finish > prompt {
		t.Fatalf("PromptReady must be emitted after command finish: finish=%d prompt=%d", finish, prompt)
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
