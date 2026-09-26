package shellexec

import "testing"

// The hosted runtime is an explicit opt-in. This is the switch that decides
// which command authority a local PowerShell pane gets: with WBT_HOSTED_PWSH
// unset the pane runs the native pwsh with the in-band shell integration (the
// default), and only an explicit value selects the hosted sidechannel.
func TestHostedRuntimeIsOptInOnly(t *testing.T) {
	for _, value := range []string{"", "0", "false", "no", "off", "  "} {
		t.Setenv("WBT_HOSTED_PWSH", value)
		if hostedRuntimeEnabled() {
			t.Fatalf("WBT_HOSTED_PWSH=%q enabled the hosted runtime; the native path must stay the default", value)
		}
	}
	for _, value := range []string{"1", "true", "TRUE", "yes", " Yes "} {
		t.Setenv("WBT_HOSTED_PWSH", value)
		if !hostedRuntimeEnabled() {
			t.Fatalf("WBT_HOSTED_PWSH=%q did not enable the hosted runtime", value)
		}
	}
}

// An explicit opt-in names the executable through the environment; the app only
// supplies a default path, never the opt-in itself.
func TestHostedRuntimePathComesFromEnvironment(t *testing.T) {
	t.Setenv("WBT_HOSTED_PWSH_EXE", `C:\somewhere\WbtHostedPowerShell.exe`)
	if got := hostedRuntimePath(); got != `C:\somewhere\WbtHostedPowerShell.exe` {
		t.Fatalf("hostedRuntimePath()=%q", got)
	}
	t.Setenv("WBT_HOSTED_PWSH_EXE", "")
	if got := hostedRuntimePath(); got != "" {
		t.Fatalf("hostedRuntimePath()=%q want empty", got)
	}
}
