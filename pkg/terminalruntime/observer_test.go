package terminalruntime

import (
	"testing"
	"time"
)

func TestOutputObserverPreservesRawOrderAndSequences(t *testing.T) {
	type result struct {
		chunk  OutputChunk
		events []IntegrationEvent
	}
	results := make(chan result, 2)
	o := NewOutputObserver("block-123", NewDecoder(), func(chunk OutputChunk, events []IntegrationEvent) { results <- result{chunk, events} })
	o.ObserveOutput("block", []byte("first"))
	o.ObserveOutput("block", []byte("second"))
	defer o.Close()
	for i, want := range []string{"first", "second"} {
		select {
		case got := <-results:
			if got.chunk.Sequence != uint64(i+1) || string(got.chunk.Raw) != want || got.chunk.BlockID != "block-123" {
				t.Fatalf("unexpected chunk: %#v", got.chunk)
			}
		case <-time.After(time.Second):
			t.Fatal("observer did not drain")
		}
	}
}
