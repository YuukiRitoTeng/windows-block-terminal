package blockcontroller

import (
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func TestCommandJournalAttachmentPublishesOnlyWinnerRegistry(t *testing.T) {
	journal := commandjournal.New()
	sc := &ShellController{}
	registries := []*commandjournal.VisualAnchorRegistry{
		commandjournal.NewVisualAnchorRegistry("block-1"),
		commandjournal.NewVisualAnchorRegistry("block-1"),
	}

	var wg sync.WaitGroup
	for _, registry := range registries {
		registry := registry
		observer := commandjournal.NewRuntimeObserver("block-1", journal, registry)
		hosted := commandjournal.NewHostedRuntimeConsumer("block-1", journal, registry)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !sc.commitCommandJournalAttachment(journal, registry, observer, hosted, nil) {
				observer.Close()
				hosted.Close()
				registry.Invalidate()
			}
		}()
	}
	wg.Wait()

	winner := sc.visualAnchorRegistry
	if winner == nil {
		t.Fatal("attachment race did not select a winner")
	}
	var loser *commandjournal.VisualAnchorRegistry
	for _, registry := range registries {
		if registry != winner {
			loser = registry
			break
		}
	}
	if loser == nil {
		t.Fatal("attachment race did not retain a losing registry")
	}

	event := terminalruntime.IntegrationEvent{
		Kind:              terminalruntime.EventVisualAnchor,
		SessionEpoch:      "epoch-1",
		HookSequence:      1,
		AnchorNonce:       "winner-nonce",
		AnchorPhase:       "start",
		RuntimeHostID:     "host-1",
		RuntimeRunspaceID: "runspace-1",
	}
	winner.ObserveAnchor(event)
	winner.ObserveConfirmation(commandjournal.VisualAnchorConfirmation{
		BlockID:      "block-1",
		SessionEpoch: "epoch-1",
		HookSequence: 1,
		CommandID:    "command-1",
		AnchorNonce:  "winner-nonce",
		HostID:       "host-1",
		RunspaceID:   "runspace-1",
		Mode:         terminalruntime.ExecutionModeStructured,
	})
	if _, ok := winner.Lookup("winner-nonce"); !ok {
		t.Fatal("winner registry did not retain its binding")
	}

	loser.Invalidate()
	if _, ok := winner.Lookup("winner-nonce"); !ok {
		t.Fatal("loser invalidation affected winner registry")
	}

	if _, err := journal.ClearVisualHistory("block-1"); err != nil {
		t.Fatalf("clear failed: %v", err)
	}
	if _, ok := winner.Lookup("winner-nonce"); ok {
		t.Fatal("clear did not invalidate the journal's live registry")
	}
}
