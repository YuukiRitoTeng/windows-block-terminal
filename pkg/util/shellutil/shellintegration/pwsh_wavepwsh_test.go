package shellintegration

import (
	_ "embed"
	"strings"
	"testing"
)

//go:embed pwsh_wavepwsh.sh
var pwshWaveIntegration string

func TestPowerShellIntegrationContainsVersionedLifecycleHooks(t *testing.T) {
	for _, marker := range []string{"16162", "_waveterm_si_command_started", "_waveterm_si_command_finished", "Set-PSReadLineKeyHandler", "cmd64", "cwd64", "_WAVETERM_SI_SESSION_EPOCH", "_WAVETERM_SI_HOOK_SEQUENCE", "LASTEXITCODE"} {
		if !strings.Contains(pwshWaveIntegration, marker) {
			t.Errorf("integration script missing %q", marker)
		}
	}
}
