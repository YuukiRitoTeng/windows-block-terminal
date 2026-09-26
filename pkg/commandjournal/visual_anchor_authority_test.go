// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package commandjournal

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

// terminalMark is an in-band anchor mark: the terminal integration's own record of
// where a command started. It carries no hosted identity.
func terminalMark(nonce string, sequence uint64) terminalruntime.IntegrationEvent {
	return terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventVisualAnchor,
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: "epoch-1",
		HookSequence: sequence,
		CommandID:    "command-1",
		AnchorNonce:  nonce,
		AnchorPhase:  "start",
	}
}

// hostedMark is the hosted runtime's own mark: it names the process and runspace it
// belongs to. The claim is untrusted and only has to agree with the authenticated
// confirmation that binds it.
func hostedMark(nonce string, sequence uint64, hostID string, runspaceID string) terminalruntime.IntegrationEvent {
	mark := terminalMark(nonce, sequence)
	mark.AnchorHostID = hostID
	mark.AnchorRunspaceID = runspaceID
	return mark
}

func terminalConfirmation(nonce string, sequence uint64) VisualAnchorConfirmation {
	return VisualAnchorConfirmation{
		BlockID:      "block-1",
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: "epoch-1",
		HookSequence: sequence,
		CommandID:    "command-1",
		AnchorNonce:  nonce,
		Mode:         terminalruntime.ExecutionModeUnknown,
	}
}

func hostedConfirmation(nonce string, sequence uint64, hostID string, runspaceID string) VisualAnchorConfirmation {
	return VisualAnchorConfirmation{
		BlockID:      "block-1",
		Authority:    terminalruntime.AuthorityHostedSidechannel,
		SessionEpoch: "epoch-1",
		HookSequence: sequence,
		CommandID:    "command-1",
		AnchorNonce:  nonce,
		HostID:       hostID,
		RunspaceID:   runspaceID,
		Mode:         terminalruntime.ExecutionModeStructured,
	}
}

func bindingAuthority(t *testing.T, registry *VisualAnchorRegistry, nonce string) string {
	t.Helper()
	binding, ok := registry.Lookup(nonce)
	if !ok {
		return ""
	}
	return string(binding.Authority)
}

// A hosted confirmation never binds the terminal integration's mark, in either
// order: the mark and the confirmation must belong to the same authority.
func TestHostedConfirmationCannotBindTerminalMark(t *testing.T) {
	// Confirmation first, then the mark.
	confirmationFirst := NewVisualAnchorRegistry("block-1")
	confirmationFirst.ObserveConfirmation(hostedConfirmation("nonce-1", 3, "host-1", "runspace-1"))
	confirmationFirst.ObserveAnchor(terminalMark("nonce-1", 3))
	if got := bindingAuthority(t, confirmationFirst, "nonce-1"); got != "" {
		t.Fatalf("a hosted confirmation bound the terminal mark: authority=%q", got)
	}

	// Mark first, then the confirmation.
	markFirst := NewVisualAnchorRegistry("block-1")
	markFirst.ObserveAnchor(terminalMark("nonce-2", 3))
	markFirst.ObserveConfirmation(hostedConfirmation("nonce-2", 3, "host-1", "runspace-1"))
	if got := bindingAuthority(t, markFirst, "nonce-2"); got != "" {
		t.Fatalf("a hosted confirmation bound the pending terminal mark: authority=%q", got)
	}
}

// The reverse direction holds too: an in-band confirmation never binds the hosted
// runtime's mark.
func TestTerminalConfirmationCannotBindHostedMark(t *testing.T) {
	confirmationFirst := NewVisualAnchorRegistry("block-1")
	confirmationFirst.ObserveConfirmation(terminalConfirmation("nonce-3", 3))
	confirmationFirst.ObserveAnchor(hostedMark("nonce-3", 3, "host-1", "runspace-1"))
	if got := bindingAuthority(t, confirmationFirst, "nonce-3"); got != "" {
		t.Fatalf("a terminal confirmation bound the hosted mark: authority=%q", got)
	}

	markFirst := NewVisualAnchorRegistry("block-1")
	markFirst.ObserveAnchor(hostedMark("nonce-4", 3, "host-1", "runspace-1"))
	markFirst.ObserveConfirmation(terminalConfirmation("nonce-4", 3))
	if got := bindingAuthority(t, markFirst, "nonce-4"); got != "" {
		t.Fatalf("a terminal confirmation bound the pending hosted mark: authority=%q", got)
	}
}

// Each authority still binds its own mark, and the binding carries that authority.
func TestEachAuthorityBindsItsOwnMark(t *testing.T) {
	terminal := NewVisualAnchorRegistry("block-1")
	terminal.ObserveAnchor(terminalMark("nonce-5", 3))
	terminal.ObserveConfirmation(terminalConfirmation("nonce-5", 3))
	binding, ok := terminal.Lookup("nonce-5")
	if !ok || binding.Authority != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("terminal binding=%#v ok=%v", binding, ok)
	}
	if binding.HostID != "" || binding.RunspaceID != "" {
		t.Fatalf("terminal binding carries hosted identity: %#v", binding)
	}

	hosted := NewVisualAnchorRegistry("block-1")
	hosted.ObserveAnchor(hostedMark("nonce-6", 3, "host-1", "runspace-1"))
	hosted.ObserveConfirmation(hostedConfirmation("nonce-6", 3, "host-1", "runspace-1"))
	hostedBinding, ok := hosted.Lookup("nonce-6")
	if !ok || hostedBinding.Authority != terminalruntime.AuthorityHostedSidechannel {
		t.Fatalf("hosted binding=%#v ok=%v", hostedBinding, ok)
	}
	if hostedBinding.HostID != "host-1" || hostedBinding.RunspaceID != "runspace-1" {
		t.Fatalf("hosted binding identity=%#v", hostedBinding)
	}
}

// A hosted mark cannot borrow another process's identity, and a terminal
// confirmation cannot smuggle hosted identity into a terminal binding.
func TestAnchorIdentityMustAgreeWithItsConfirmation(t *testing.T) {
	otherHost := NewVisualAnchorRegistry("block-1")
	otherHost.ObserveAnchor(hostedMark("nonce-7", 3, "host-1", "runspace-1"))
	otherHost.ObserveConfirmation(hostedConfirmation("nonce-7", 3, "host-2", "runspace-1"))
	if got := bindingAuthority(t, otherHost, "nonce-7"); got != "" {
		t.Fatalf("a hosted confirmation bound a mark of another identity: authority=%q", got)
	}

	otherRunspace := NewVisualAnchorRegistry("block-1")
	otherRunspace.ObserveAnchor(hostedMark("nonce-8", 3, "host-1", "runspace-1"))
	otherRunspace.ObserveConfirmation(hostedConfirmation("nonce-8", 3, "host-1", "runspace-2"))
	if got := bindingAuthority(t, otherRunspace, "nonce-8"); got != "" {
		t.Fatalf("a hosted confirmation bound a mark of another runspace: authority=%q", got)
	}

	smuggled := NewVisualAnchorRegistry("block-1")
	smuggled.ObserveAnchor(terminalMark("nonce-9", 3))
	confirmation := terminalConfirmation("nonce-9", 3)
	confirmation.HostID = "host-1"
	confirmation.RunspaceID = "runspace-1"
	smuggled.ObserveConfirmation(confirmation)
	if got := bindingAuthority(t, smuggled, "nonce-9"); got != "" {
		t.Fatalf("a terminal binding carried hosted identity: authority=%q", got)
	}
}

// A mark's provenance comes from the identity it claims, because both producers
// write marks into the same PTY stream: the integration's marks claim nothing,
// the hosted runtime's marks name their process and runspace. A partial claim is
// not a hosted mark, and no confirmation of the other authority can bind one.
func TestMarkProvenanceIsDecidedByItsIdentityClaim(t *testing.T) {
	// A partial claim is not a hosted mark, so the hosted authority cannot bind it.
	crossed := NewVisualAnchorRegistry("block-1")
	partialClaim := terminalMark("nonce-10", 3)
	partialClaim.AnchorHostID = "host-1" // runspace claim missing
	crossed.ObserveAnchor(partialClaim)
	crossed.ObserveConfirmation(hostedConfirmation("nonce-10", 3, "host-1", "runspace-1"))
	if got := bindingAuthority(t, crossed, "nonce-10"); got != "" {
		t.Fatalf("a partial identity claim was bound as hosted: authority=%q", got)
	}

	// On its own authority the same mark is an ordinary terminal anchor and binds.
	terminal := NewVisualAnchorRegistry("block-1")
	terminal.ObserveAnchor(partialClaim)
	terminal.ObserveConfirmation(terminalConfirmation("nonce-10", 3))
	if got := bindingAuthority(t, terminal, "nonce-10"); got != string(terminalruntime.AuthorityTerminalOSC) {
		t.Fatalf("a partial claim did not stay on the terminal authority: authority=%q", got)
	}
}

// A mismatched pairing poisons the nonce for both authorities: the marker stays
// unbound rather than being handed to the other producer.
func TestCrossAuthorityMismatchPoisonsTheNonce(t *testing.T) {
	registry := NewVisualAnchorRegistry("block-1")
	registry.ObserveAnchor(terminalMark("nonce-11", 3))
	registry.ObserveConfirmation(hostedConfirmation("nonce-11", 3, "host-1", "runspace-1"))
	// The correct authority for this mark arrives afterwards and must not revive it.
	registry.ObserveConfirmation(terminalConfirmation("nonce-11", 3))
	if got := bindingAuthority(t, registry, "nonce-11"); got != "" {
		t.Fatalf("a poisoned nonce was bound later: authority=%q", got)
	}
}
