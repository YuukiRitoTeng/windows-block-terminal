package commandjournal

import (
	"bytes"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

// oscFrame builds one in-band frame exactly as the shell integration emits it.
func oscFrame(kind string, body string) []byte {
	return []byte("\x1b]16162;" + kind + ";" + body + "\a")
}

// The in-band path binds its own anchor: the B frame carries the command's
// epoch/sequence/nonce, the C frame repeats the nonce, and the journal accepts
// the command as terminal-osc - so the marker and the record pair up without any
// hosted identity.
func TestInBandAnchorBindsToItsCommand(t *testing.T) {
	blockID := "block-native-anchor"
	journal := New()
	registry := NewVisualAnchorRegistry(blockID)
	observer := NewRuntimeObserver(blockID, journal, registry)

	raw := oscFrame("M", `{"v":1,"epoch":"epoch-native","seq":1,"shell":"pwsh"}`)
	raw = append(raw, oscFrame("P", `{"v":1,"epoch":"epoch-native","seq":2}`)...)
	raw = append(raw, oscFrame("B", `{"v":1,"epoch":"epoch-native","seq":3,"id":"epoch-native-3","nonce":"nonce-1","phase":"start"}`)...)
	raw = append(raw, oscFrame("C", `{"v":1,"epoch":"epoch-native","seq":3,"id":"epoch-native-3","nonce":"nonce-1","cmd64":"bHM="}`)...)
	raw = append(raw, []byte("command-output\r\n")...)
	raw = append(raw, oscFrame("D", `{"v":1,"epoch":"epoch-native","seq":4,"id":"epoch-native-3","success":true,"exitcode":0}`)...)
	raw = append(raw, oscFrame("P", `{"v":1,"epoch":"epoch-native","seq":5}`)...)
	observer.ObserveOutput(blockID, raw)
	observer.Close()

	binding, ok := registry.Lookup("nonce-1")
	if !ok {
		t.Fatal("the in-band anchor was not bound to its command")
	}
	if binding.Authority != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("binding authority=%q want %q", binding.Authority, terminalruntime.AuthorityTerminalOSC)
	}
	if binding.CommandID != "epoch-native-3" || binding.SessionEpoch != "epoch-native" || binding.HookSequence != 3 {
		t.Fatalf("binding identity=%#v", binding)
	}
	if binding.HostID != "" || binding.RunspaceID != "" {
		t.Fatalf("in-band binding claims hosted identity: %#v", binding)
	}

	// Exactly one record, owned by the in-band authority.
	records := journal.Snapshot(blockID)
	if len(records) != 1 {
		t.Fatalf("records=%#v", records)
	}
	if records[0].Authority != terminalruntime.AuthorityTerminalOSC || records[0].OutputSource != terminalruntime.OutputSourcePTY {
		t.Fatalf("record provenance=%#v", records[0])
	}
	if !bytes.Contains(records[0].Output, []byte("command-output")) {
		t.Fatalf("output between the in-band C and D was not attributed: %#v", records[0])
	}
	if got := journal.Authority(blockID); got != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("latched authority=%q", got)
	}

	// The rail pairs the binding with the record by command id.
	if records[0].ID != binding.CommandID {
		t.Fatalf("binding command %q does not match record %q", binding.CommandID, records[0].ID)
	}
}

// One command produces one anchor: a repeated nonce never binds twice.
func TestInBandAnchorBindsOnce(t *testing.T) {
	blockID := "block-native-anchor-once"
	journal := New()
	registry := NewVisualAnchorRegistry(blockID)
	observer := NewRuntimeObserver(blockID, journal, registry)

	var raw []byte
	raw = append(raw, oscFrame("B", `{"v":1,"epoch":"epoch-1","seq":1,"id":"cmd-1","nonce":"nonce-once","phase":"start"}`)...)
	raw = append(raw, oscFrame("C", `{"v":1,"epoch":"epoch-1","seq":1,"id":"cmd-1","nonce":"nonce-once"}`)...)
	raw = append(raw, oscFrame("D", `{"v":1,"epoch":"epoch-1","seq":2,"id":"cmd-1","success":true,"exitcode":0}`)...)
	observer.ObserveOutput(blockID, raw)
	observer.Close()

	binding, ok := registry.Lookup("nonce-once")
	if !ok {
		t.Fatal("anchor did not bind")
	}
	if binding.CommandID != "cmd-1" {
		t.Fatalf("binding=%#v", binding)
	}
	if len(journal.Snapshot(blockID)) != 1 {
		t.Fatalf("records=%#v", journal.Snapshot(blockID))
	}
}

// A command without an anchor nonce (an older shell, or a frame whose anchor was
// lost) still produces a record - it simply has no marker to bind.
func TestInBandCommandWithoutAnchorStillRecords(t *testing.T) {
	blockID := "block-native-no-anchor"
	journal := New()
	registry := NewVisualAnchorRegistry(blockID)
	observer := NewRuntimeObserver(blockID, journal, registry)

	var raw []byte
	raw = append(raw, oscFrame("C", `{"v":1,"epoch":"epoch-1","seq":1,"id":"cmd-1"}`)...)
	raw = append(raw, oscFrame("D", `{"v":1,"epoch":"epoch-1","seq":2,"id":"cmd-1","success":true,"exitcode":0}`)...)
	observer.ObserveOutput(blockID, raw)
	observer.Close()

	if records := journal.Snapshot(blockID); len(records) != 1 {
		t.Fatalf("records=%#v", records)
	}
	if _, ok := registry.Lookup(""); ok {
		t.Fatal("an anchor-free command must not bind anything")
	}
}

// Authorities never cross: an in-band confirmation cannot confirm a hosted
// anchor, and the mismatched nonce stays unbound (fail-closed) rather than being
// handed to the other authority. A hosted anchor still binds through its own
// hosted confirmation.
func TestAnchorAuthoritiesDoNotCross(t *testing.T) {
	const blockID = "block-cross"
	hostedAnchor := func(registry *VisualAnchorRegistry, nonce string) {
		registry.ObserveAnchor(terminalruntime.IntegrationEvent{
			Kind:              terminalruntime.EventVisualAnchor,
			SessionEpoch:      "runspace-1",
			HookSequence:      1,
			AnchorNonce:       nonce,
			AnchorPhase:       "start",
			RuntimeHostID:     "host-1",
			RuntimeRunspaceID: "runspace-1",
		})
	}
	hostedConfirmation := func(nonce string) VisualAnchorConfirmation {
		return VisualAnchorConfirmation{
			BlockID:      blockID,
			Authority:    terminalruntime.AuthorityHostedSidechannel,
			SessionEpoch: "runspace-1",
			HookSequence: 1,
			CommandID:    "cmd-1",
			AnchorNonce:  nonce,
			HostID:       "host-1",
			RunspaceID:   "runspace-1",
		}
	}

	// 1. An in-band confirmation for a hosted anchor is refused, and the nonce is
	//    poisoned rather than being bound to the wrong authority.
	crossed := NewVisualAnchorRegistry(blockID)
	hostedAnchor(crossed, "cross-nonce")
	crossed.ObserveConfirmation(VisualAnchorConfirmation{
		BlockID:      blockID,
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: "runspace-1",
		HookSequence: 1,
		CommandID:    "cmd-1",
		AnchorNonce:  "cross-nonce",
	})
	if _, ok := crossed.Lookup("cross-nonce"); ok {
		t.Fatal("an in-band confirmation bound a hosted anchor")
	}
	crossed.ObserveConfirmation(hostedConfirmation("cross-nonce"))
	if _, ok := crossed.Lookup("cross-nonce"); ok {
		t.Fatal("a poisoned nonce was bound by a later confirmation")
	}

	// 2. The hosted authority binds its own anchor normally.
	hosted := NewVisualAnchorRegistry(blockID)
	hostedAnchor(hosted, "hosted-nonce")
	hosted.ObserveConfirmation(hostedConfirmation("hosted-nonce"))
	binding, ok := hosted.Lookup("hosted-nonce")
	if !ok || binding.Authority != terminalruntime.AuthorityHostedSidechannel {
		t.Fatalf("hosted binding=%#v ok=%v", binding, ok)
	}

	// 3. And the in-band authority binds its own (identity-free) anchor normally.
	inBand := NewVisualAnchorRegistry(blockID)
	inBand.ObserveAnchor(terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventVisualAnchor,
		SessionEpoch: "epoch-native",
		HookSequence: 1,
		AnchorNonce:  "inband-nonce",
		AnchorPhase:  "start",
	})
	inBand.ObserveConfirmation(VisualAnchorConfirmation{
		BlockID:      blockID,
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: "epoch-native",
		HookSequence: 1,
		CommandID:    "cmd-native",
		AnchorNonce:  "inband-nonce",
	})
	inBandBinding, ok := inBand.Lookup("inband-nonce")
	if !ok || inBandBinding.Authority != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("in-band binding=%#v ok=%v", inBandBinding, ok)
	}
	if inBandBinding.HostID != "" || inBandBinding.RunspaceID != "" {
		t.Fatalf("in-band binding carries hosted identity: %#v", inBandBinding)
	}
	_ = time.Now()
}
