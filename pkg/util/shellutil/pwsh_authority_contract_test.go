package shellutil

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

// The pwsh integration is the in-band authority. It must never claim hosted
// identity: the hosted hostId/runspaceId belong to the authenticated hosted
// sidechannel, and an in-band frame carrying them is refused by the decoder
// (pkg/terminalruntime/authority_test.go).
func TestPwshIntegrationCannotClaimHostedIdentity(t *testing.T) {
	script := PwshStartup_wavepwsh
	for _, forbidden := range []string{"hostid", "runspaceid", "hostId", "runspaceId"} {
		if strings.Contains(script, forbidden) {
			t.Fatalf("pwsh integration mentions %q; hosted identity must not appear in the in-band authority", forbidden)
		}
	}
	// It frames anchors as well as lifecycle events, but always in-band.
	for _, required := range []string{`"C"`, `"D"`, `"P"`, `"M"`} {
		if !strings.Contains(script, required) {
			t.Fatalf("pwsh integration no longer emits its %s frame", required)
		}
	}
}

// A nested pwsh must not install a second integration: the first shell in the
// process tree owns it, and the installed marker is inherited by children.
func TestPwshIntegrationNestedShellGuard(t *testing.T) {
	script := PwshStartup_wavepwsh
	ownerGuard := `if ($env:WAVETERM_SI_OWNER_PID -and $env:WAVETERM_SI_OWNER_PID -ne "$PID") {`
	installedGuard := `if ($env:WAVETERM_SI_INSTALLED -eq "1") {`
	ownerIdx := strings.Index(script, ownerGuard)
	installedIdx := strings.Index(script, installedGuard)
	if ownerIdx < 0 {
		t.Fatal("the foreign-owner guard is missing: a nested pwsh could take over the session")
	}
	if installedIdx < 0 {
		t.Fatal("the installed guard is missing: a nested pwsh could install a second integration")
	}
	// Both guards must run before the integration installs itself (PSReadLine
	// handler, prompt wrapper, OSC emission).
	installIdx := strings.Index(script, "Set-PSReadLineKeyHandler")
	if installIdx < 0 {
		t.Fatal("the PSReadLine command boundary is missing")
	}
	if ownerIdx > installIdx || installedIdx > installIdx {
		t.Fatal("the nested-shell guards must run before the integration installs itself")
	}
	if !strings.Contains(script, `$env:WAVETERM_SI_OWNER_PID = "$PID"`) {
		t.Fatal("the owning shell must mark itself so children stay ordinary PTY applications")
	}
	if !strings.Contains(script, `$env:WAVETERM_SI_INSTALLED = "1"`) {
		t.Fatal("the installed marker must be set once the integration owns the session")
	}
}

// The authority names the shell integration produces are the in-band ones; the
// constant is asserted here so a rename cannot silently desynchronise the Go
// and PowerShell sides.
func TestInBandAuthorityNameIsStable(t *testing.T) {
	if string(terminalruntime.AuthorityTerminalOSC) != "terminal-osc" {
		t.Fatalf("in-band authority renamed: %q", terminalruntime.AuthorityTerminalOSC)
	}
}
