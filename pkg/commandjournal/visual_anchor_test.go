package commandjournal

import (
	"fmt"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func testAnchorEvent(nonce string, sequence uint64) terminalruntime.IntegrationEvent {
	return terminalruntime.IntegrationEvent{
		Kind:              terminalruntime.EventVisualAnchor,
		SessionEpoch:      "epoch-1",
		HookSequence:      sequence,
		CommandID:         "command-1",
		AnchorNonce:       nonce,
		AnchorPhase:       "start",
		RuntimeHostID:     "host-1",
		RuntimeRunspaceID: "runspace-1",
	}
}

func testConfirmation(nonce string, sequence uint64) VisualAnchorConfirmation {
	return VisualAnchorConfirmation{
		BlockID:      "block-1",
		SessionEpoch: "epoch-1",
		HookSequence: sequence,
		CommandID:    "command-1",
		AnchorNonce:  nonce,
		HostID:       "host-1",
		RunspaceID:   "runspace-1",
		Mode:         terminalruntime.ExecutionModeStructured,
	}
}

func TestVisualAnchorRegistryPairsInEitherOrder(t *testing.T) {
	for _, tc := range []struct {
		name              string
		firstConfirmation bool
	}{
		{name: "anchor-first"},
		{name: "confirmation-first", firstConfirmation: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			registry := NewVisualAnchorRegistry("block-1")
			if tc.firstConfirmation {
				registry.ObserveConfirmation(testConfirmation("nonce-1", 1))
				registry.ObserveAnchor(testAnchorEvent("nonce-1", 1))
			} else {
				registry.ObserveAnchor(testAnchorEvent("nonce-1", 1))
				registry.ObserveConfirmation(testConfirmation("nonce-1", 1))
			}
			binding, ok := registry.Lookup("nonce-1")
			if !ok || binding.CommandID != "command-1" || binding.Mode != terminalruntime.ExecutionModeStructured {
				t.Fatalf("binding = %#v, ok=%v", binding, ok)
			}
		})
	}
}

func TestVisualAnchorRegistryRejectsMismatchesAndReplay(t *testing.T) {
	registry := NewVisualAnchorRegistry("block-1")
	registry.ObserveAnchor(testAnchorEvent("nonce-1", 1))
	bad := testConfirmation("nonce-1", 2)
	registry.ObserveConfirmation(bad)
	if _, ok := registry.Lookup("nonce-1"); ok {
		t.Fatal("mismatched sequence must not bind")
	}
	registry.ObserveConfirmation(testConfirmation("nonce-1", 1))
	if _, ok := registry.Lookup("nonce-1"); ok {
		t.Fatal("rejected nonce must not be replayable")
	}

	for name, mutate := range map[string]func(*VisualAnchorConfirmation){
		"block":    func(c *VisualAnchorConfirmation) { c.BlockID = "other-block" },
		"epoch":    func(c *VisualAnchorConfirmation) { c.SessionEpoch = "other-epoch" },
		"command":  func(c *VisualAnchorConfirmation) { c.CommandID = "other-command" },
		"host":     func(c *VisualAnchorConfirmation) { c.HostID = "other-host" },
		"runspace": func(c *VisualAnchorConfirmation) { c.RunspaceID = "other-runspace" },
	} {
		t.Run(name, func(t *testing.T) {
			registry := NewVisualAnchorRegistry("block-1")
			registry.ObserveAnchor(testAnchorEvent("nonce-mismatch", 1))
			confirmation := testConfirmation("nonce-mismatch", 1)
			mutate(&confirmation)
			registry.ObserveConfirmation(confirmation)
			if _, ok := registry.Lookup("nonce-mismatch"); ok {
				t.Fatal("mismatched context must not bind")
			}
		})
	}

	registry = NewVisualAnchorRegistry("block-1")
	registry.ObserveAnchor(testAnchorEvent("nonce-3", 1))
	registry.ObserveConfirmation(testConfirmation("different-nonce", 1))
	if _, ok := registry.Lookup("nonce-3"); ok {
		t.Fatal("different nonce must not bind")
	}
	if _, ok := registry.Lookup("different-nonce"); ok {
		t.Fatal("confirmation without matching anchor must remain unbound")
	}
	invalidPhase := testAnchorEvent("nonce-phase", 1)
	invalidPhase.AnchorPhase = "finish"
	registry.ObserveAnchor(invalidPhase)
	registry.ObserveConfirmation(testConfirmation("nonce-phase", 1))
	if _, ok := registry.Lookup("nonce-phase"); ok {
		t.Fatal("unsupported anchor phase must not bind")
	}

	registry = NewVisualAnchorRegistry("block-1")
	registry.ObserveAnchor(testAnchorEvent("nonce-2", 1))
	registry.ObserveConfirmation(testConfirmation("nonce-2", 1))
	registry.ObserveConfirmation(testConfirmation("nonce-2", 1))
	binding, ok := registry.Lookup("nonce-2")
	if !ok || binding.CommandID != "command-1" {
		t.Fatalf("duplicate confirmation changed binding: %#v, ok=%v", binding, ok)
	}
}

func TestVisualAnchorRegistryInvalidatesBindings(t *testing.T) {
	registry := NewVisualAnchorRegistry("block-1")
	registry.ObserveAnchor(testAnchorEvent("nonce-1", 1))
	registry.ObserveConfirmation(testConfirmation("nonce-1", 1))
	registry.Invalidate()
	if _, ok := registry.Lookup("nonce-1"); ok {
		t.Fatal("clear/session invalidation must remove binding")
	}
	registry.ObserveAnchor(testAnchorEvent("nonce-1", 1))
	registry.ObserveConfirmation(testConfirmation("nonce-1", 1))
	if _, ok := registry.Lookup("nonce-1"); ok {
		t.Fatal("old nonce must not be replayable after a new visual generation")
	}
	registry.ObserveAnchor(testAnchorEvent("nonce-new", 2))
	registry.ObserveConfirmation(testConfirmation("nonce-new", 2))
	if _, ok := registry.Lookup("nonce-new"); !ok {
		t.Fatal("new nonce should bind after a new visual generation")
	}
}

func TestClearVisualHistoryInvalidatesBindings(t *testing.T) {
	journal := New()
	registry := NewVisualAnchorRegistry("block-1")
	journal.SetVisualAnchorRegistry(registry)
	registry.ObserveAnchor(testAnchorEvent("nonce-clear", 1))
	registry.ObserveConfirmation(testConfirmation("nonce-clear", 1))
	if _, ok := registry.Lookup("nonce-clear"); !ok {
		t.Fatal("expected binding before clear")
	}
	if _, err := journal.ClearVisualHistory("block-1"); err != nil {
		t.Fatalf("clear failed: %v", err)
	}
	if _, ok := registry.Lookup("nonce-clear"); ok {
		t.Fatal("clear must invalidate old visual bindings")
	}
}

func TestHostedStartConfirmationProvidesAuthoritativeCommandID(t *testing.T) {
	registry := NewVisualAnchorRegistry("block-1")
	anchor := testAnchorEvent("nonce-authoritative", 1)
	anchor.CommandID = ""
	registry.ObserveAnchor(anchor)
	registry.ObserveHostedStart(shellexec.HostedRuntimeEvent{
		Kind:        "command_started",
		HostID:      "host-1",
		RunspaceID:  "runspace-1",
		CommandID:   "record-from-sidechannel",
		AnchorNonce: "nonce-authoritative",
		Mode:        string(terminalruntime.ExecutionModeStructured),
	}, "block-1", "epoch-1", 1)
	binding, ok := registry.Lookup("nonce-authoritative")
	if !ok || binding.CommandID != "record-from-sidechannel" {
		t.Fatalf("authoritative command id was not bound: %#v, ok=%v", binding, ok)
	}
}

func TestVisualAnchorRegistryBoundsPendingAndTombstones(t *testing.T) {
	registry := NewVisualAnchorRegistry("block-1")
	for i := 1; i <= visualAnchorPendingCapacity+32; i++ {
		nonce := fmt.Sprintf("pending-%d", i)
		registry.ObserveAnchor(testAnchorEvent(nonce, uint64(i)))
	}
	if len(registry.anchors) > visualAnchorPendingCapacity || len(registry.rejected) > visualAnchorTombstoneCapacity {
		t.Fatalf("registry exceeded pending/tombstone bounds: anchors=%d rejected=%d", len(registry.anchors), len(registry.rejected))
	}

	stale := testAnchorEvent("stale", uint64(visualAnchorPendingCapacity+100))
	registry.ObserveAnchor(stale)
	registry.mu.Lock()
	entry := registry.anchors[stale.AnchorNonce]
	entry.at = time.Now().Add(-visualAnchorPendingTTL - time.Second)
	registry.anchors[stale.AnchorNonce] = entry
	registry.mu.Unlock()
	registry.ObserveAnchor(testAnchorEvent("fresh", stale.HookSequence+1))
	if _, ok := registry.anchors[stale.AnchorNonce]; ok {
		t.Fatal("expired pending anchor was retained")
	}

	confirmations := NewVisualAnchorRegistry("block-1")
	for i := 1; i <= visualAnchorPendingCapacity+8; i++ {
		confirmation := testConfirmation(fmt.Sprintf("confirmation-%d", i), uint64(i))
		confirmations.ObserveConfirmation(confirmation)
	}
	if len(confirmations.confirmations) > visualAnchorPendingCapacity {
		t.Fatalf("confirmation pending bound exceeded: %d", len(confirmations.confirmations))
	}
	staleConfirmation := testConfirmation("stale-confirmation", uint64(visualAnchorPendingCapacity+20))
	confirmations.ObserveConfirmation(staleConfirmation)
	confirmations.mu.Lock()
	confirmationEntry := confirmations.confirmations[staleConfirmation.AnchorNonce]
	confirmationEntry.at = time.Now().Add(-visualAnchorPendingTTL - time.Second)
	confirmations.confirmations[staleConfirmation.AnchorNonce] = confirmationEntry
	confirmations.mu.Unlock()
	confirmations.ObserveConfirmation(testConfirmation("fresh-confirmation", staleConfirmation.HookSequence+1))
	if _, ok := confirmations.confirmations[staleConfirmation.AnchorNonce]; ok {
		t.Fatal("expired pending confirmation was retained")
	}

	for i := 0; i < visualAnchorTombstoneCapacity+64; i++ {
		registry.rejected[fmt.Sprintf("tombstone-%d", i)] = time.Now()
	}
	registry.pruneLocked(time.Now())
	if len(registry.rejected) > visualAnchorTombstoneCapacity {
		t.Fatalf("tombstones exceeded bound: %d", len(registry.rejected))
	}
	overflow := NewVisualAnchorRegistry("block-1")
	for i := 1; i <= visualAnchorPendingCapacity+visualAnchorTombstoneCapacity+64; i++ {
		overflow.ObserveAnchor(testAnchorEvent(fmt.Sprintf("overflow-%d", i), uint64(i)))
	}
	overflow.mu.Lock()
	overflowAnchors, overflowTombstones := len(overflow.anchors), len(overflow.rejected)
	overflow.mu.Unlock()
	if overflowAnchors > visualAnchorPendingCapacity || overflowTombstones > visualAnchorTombstoneCapacity {
		t.Fatalf("eviction exceeded bounds: anchors=%d rejected=%d", overflowAnchors, overflowTombstones)
	}
	overflow.ObserveConfirmation(testConfirmation("overflow-1", 1))
	if _, ok := overflow.Lookup("overflow-1"); ok {
		t.Fatal("evicted stale nonce was allowed to bind")
	}

	bindings := NewVisualAnchorRegistry("block-1")
	for i := 1; i <= visualAnchorBindingCapacity+1; i++ {
		nonce := fmt.Sprintf("binding-%d", i)
		bindings.ObserveAnchor(testAnchorEvent(nonce, uint64(i)))
		bindings.ObserveConfirmation(testConfirmation(nonce, uint64(i)))
	}
	bindings.mu.Lock()
	bindingCount := len(bindings.bindings)
	bindings.mu.Unlock()
	if bindingCount > visualAnchorBindingCapacity {
		t.Fatalf("bindings exceeded bound: %d", bindingCount)
	}
}
