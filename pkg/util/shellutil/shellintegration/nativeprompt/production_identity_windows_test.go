//go:build windows && !race

package nativeprompt

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

// waitForVisibleRecord polls until a record of the command is visible in the current
// visibility generation - what the rail and Copy All are allowed to list.
func (h *nativePromptHarness) waitForVisibleRecord(what string, commandID string) commandjournal.CommandRecord {
	h.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		for _, record := range h.journal.VisibleSnapshot(h.blockID) {
			if record.ID == commandID {
				return record
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.t.Fatalf("timed out waiting for the visible record of %s", what)
	return commandjournal.CommandRecord{}
}

// The production identity chain, end to end on a real pwsh session: the integration's
// mark and command start reach the runtime observer the app installs, the journal owns
// the record, and the anchor registry confirms the mark against that record.
//
// This is the chain a Global Clear must not break: the clear drops the visual markers
// (and both registries invalidate them) while the identity - the record - stays, and a
// command run after the clear has to bind a fresh anchor the same way.
func assertProductionIdentityChainSurvivesClear(t *testing.T, h *nativePromptHarness) {
	assertIdentity := func(command string) (commandjournal.CommandRecord, commandjournal.VisualAnchorBinding) {
		t.Helper()
		started, finished := h.runCommand(command)
		if finished.Success == nil || !*finished.Success {
			t.Fatalf("command %q failed: %#v", command, finished)
		}
		record := h.waitForRecord("the record of "+command, started.CommandID, func(record commandjournal.CommandRecord) bool {
			return record.State == commandjournal.StateFinished
		})
		if record.Authority != terminalruntime.AuthorityTerminalOSC {
			t.Fatalf("record %q authority=%q want %q", command, record.Authority, terminalruntime.AuthorityTerminalOSC)
		}
		if record.SessionEpoch != h.epoch {
			t.Fatalf("record %q epoch=%q want %q", command, record.SessionEpoch, h.epoch)
		}
		anchorEvent := h.waitFor("the anchor of "+command, func(event terminalruntime.IntegrationEvent) bool {
			return event.Kind == terminalruntime.EventVisualAnchor && event.CommandID == record.ID
		})
		binding, ok := h.waitForBinding(anchorEvent.AnchorNonce)
		if !ok {
			t.Fatalf("command %q produced no confirmed anchor", command)
		}
		if binding.CommandID != record.ID {
			t.Fatalf("binding command %q != record %q", binding.CommandID, record.ID)
		}
		if binding.Authority != terminalruntime.AuthorityTerminalOSC {
			t.Fatalf("binding authority=%q want %q", binding.Authority, terminalruntime.AuthorityTerminalOSC)
		}
		return record, binding
	}

	before, beforeBinding := assertIdentity("Write-Output identity-before-clear")
	if _, visible := h.waitForVisibleRecordAndReport(before.ID); !visible {
		t.Fatalf("the record of the pre-clear command is not visible")
	}

	// Global Clear, exactly as the product performs it: the journal advances the
	// visibility generation and invalidates the visual anchors of the old generation.
	if _, err := h.journal.ClearVisualHistory(h.blockID); err != nil {
		t.Fatalf("ClearVisualHistory: %v", err)
	}
	if _, ok := h.registry.Lookup(beforeBinding.AnchorNonce); ok {
		t.Fatalf("a pre-clear anchor is still bound after the clear")
	}
	for _, record := range h.journal.VisibleSnapshot(h.blockID) {
		if record.ID == before.ID {
			t.Fatalf("the pre-clear record is still visible after the clear")
		}
	}

	// The identity chain works again immediately after the clear.
	after, afterBinding := assertIdentity("Write-Output identity-after-clear")
	if after.ID == before.ID {
		t.Fatalf("the post-clear command reused the pre-clear identity")
	}
	if after.VisibilityGeneration <= before.VisibilityGeneration {
		t.Fatalf("post-clear generation=%d, pre-clear=%d", after.VisibilityGeneration, before.VisibilityGeneration)
	}
	h.waitForVisibleRecord("the post-clear command", after.ID)
	if afterBinding.AnchorNonce == beforeBinding.AnchorNonce {
		t.Fatalf("the post-clear command reused the pre-clear anchor")
	}
}

// waitForVisibleRecordAndReport reports whether a record is currently visible without
// failing the test, so the caller can assert the pre-clear state.
func (h *nativePromptHarness) waitForVisibleRecordAndReport(commandID string) (commandjournal.CommandRecord, bool) {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, record := range h.journal.VisibleSnapshot(h.blockID) {
			if record.ID == commandID {
				return record, true
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return commandjournal.CommandRecord{}, false
}
