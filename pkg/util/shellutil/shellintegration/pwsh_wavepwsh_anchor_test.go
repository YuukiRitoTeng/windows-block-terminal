package shellintegration

import (
	"strings"
	"testing"
)

// The in-band command lifecycle is C (start) + D (finish) + B (anchor), and the
// anchor belongs to the same command as the C it precedes: same epoch, same
// sequence, same command id, and it carries the nonce the C repeats.
func TestPowerShellIntegrationEmitsOneAnchorPerCommand(t *testing.T) {
	start := strings.Index(pwshWaveIntegration, "function Global:_waveterm_si_command_started")
	if start < 0 {
		t.Fatal("command start helper missing")
	}
	body := pwshWaveIntegration[start:]
	if end := strings.Index(body, "function Global:_waveterm_si_command_finished"); end > 0 {
		body = body[:end]
	}

	anchor := strings.Index(body, `_waveterm_si_emit "B"`)
	command := strings.Index(body, `_waveterm_si_emit "C"`)
	if anchor < 0 {
		t.Fatal("the in-band path must emit a visual anchor")
	}
	if command < 0 {
		t.Fatal("the in-band path must emit the command start")
	}
	if anchor > command {
		t.Fatal("the anchor must be emitted before the command start so the marker precedes the output")
	}
	if count := strings.Count(body, `_waveterm_si_emit "B"`); count != 1 {
		t.Fatalf("expected exactly one anchor per command, found %d", count)
	}

	anchorFrame := body[anchor:command]
	for _, required := range []string{"epoch = $Global:_WAVETERM_SI_SESSION_EPOCH", "seq = $sequence", "id = $id", "nonce = $nonce", `phase = "start"`} {
		if !strings.Contains(anchorFrame, required) {
			t.Errorf("anchor frame is missing %q", required)
		}
	}
	commandFrame := body[command:]
	for _, required := range []string{"nonce = $nonce", "seq = $sequence", "id = $id", "cmd64", "cwd64"} {
		if !strings.Contains(commandFrame, required) {
			t.Errorf("command frame is missing %q", required)
		}
	}
	// The anchor shares the command's sequence: the decoder accepts that for B
	// frames and still keeps the lifecycle sequence monotonic.
	if !strings.Contains(anchorFrame, "seq = $sequence") || !strings.Contains(commandFrame, "seq = $sequence") {
		t.Fatal("anchor and command must share the command's hook sequence")
	}
}

// The in-band authority never claims hosted identity.
func TestPowerShellIntegrationAnchorCarriesNoHostedIdentity(t *testing.T) {
	start := strings.Index(pwshWaveIntegration, "function Global:_waveterm_si_command_started")
	body := pwshWaveIntegration[start:]
	if end := strings.Index(body, "function Global:_waveterm_si_command_finished"); end > 0 {
		body = body[:end]
	}
	anchor := body[strings.Index(body, `_waveterm_si_emit "B"`):]
	for _, forbidden := range []string{"hostid", "hostId", "runspaceid", "runspaceId"} {
		if strings.Contains(anchor, forbidden) {
			t.Fatalf("anchor frame claims hosted identity %q", forbidden)
		}
	}
}

// The wrapper must keep showing the user's own prompt: it saves the existing
// prompt function and calls it, and only falls back to the built-in
// "PS <path>>" form when the session has no prompt function at all.
func TestPowerShellIntegrationPreservesUserPrompt(t *testing.T) {
	if !strings.Contains(pwshWaveIntegration, `$global:_waveterm_original_prompt = $function:prompt`) {
		t.Fatal("the integration must keep the user's prompt function")
	}
	wrapper := strings.Index(pwshWaveIntegration, "function Global:prompt {")
	if wrapper < 0 {
		t.Fatal("the integration must wrap the prompt function")
	}
	body := pwshWaveIntegration[wrapper:]
	if !strings.Contains(body, "& $global:_waveterm_original_prompt") {
		t.Fatal("the wrapper must call the user's prompt to render it")
	}
	if strings.Contains(body, `"PS $($executionContext`) == false {
		t.Fatal("a session without a prompt function needs the built-in fallback")
	}
	// The fallback must only be used when there is no prompt function to keep.
	fallback := strings.Index(pwshWaveIntegration, "if (Test-Path Function:\\prompt)")
	if fallback < 0 {
		t.Fatal("the prompt wrapper must be conditional on an existing prompt function")
	}
}

// The lifecycle stays a single set per command: one command start, one finish and
// one prompt-ready frame are built per cycle, and the anchor never substitutes
// for either.
func TestPowerShellIntegrationKeepsSingleLifecyclePerCommand(t *testing.T) {
	if count := strings.Count(pwshWaveIntegration, `_waveterm_si_emit "C"`); count != 1 {
		t.Fatalf("expected exactly one command-start emission, found %d", count)
	}
	if count := strings.Count(pwshWaveIntegration, `_waveterm_si_frame "D"`); count != 1 {
		t.Fatalf("expected exactly one command-finish frame, found %d", count)
	}
	if count := strings.Count(pwshWaveIntegration, `_waveterm_si_frame "P"`); count != 1 {
		t.Fatalf("expected exactly one prompt-ready frame, found %d", count)
	}
	if count := strings.Count(pwshWaveIntegration, "function Global:prompt {"); count != 2 {
		t.Fatalf("expected the prompt wrapper in both branches, found %d", count)
	}
	for _, forbidden := range []string{"Start-Sleep", "[Console]::Out.Flush", "[Console]::Error.Flush", "CursorPosition", "Out-Default"} {
		if strings.Contains(pwshWaveIntegration, forbidden) {
			t.Fatalf("the integration must not use %q: ordering cannot depend on a wait", forbidden)
		}
	}
}
