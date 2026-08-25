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

func TestOutputObserverBudgetDropsWithoutBlockingProducer(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	results := make(chan OutputChunk, 4)
	o := NewOutputObserverWithOptions("block", NewDecoder(), func(chunk OutputChunk, _ []IntegrationEvent) {
		results <- chunk
		if chunk.Sequence == 1 {
			close(entered)
			<-release
		}
	}, nil, OutputObserverOptions{MaxQueueBytes: 4})
	defer o.Close()
	o.ObserveOutput("block", []byte("1234"))
	<-entered
	o.ObserveOutput("block", []byte("abcd"))
	done := make(chan struct{})
	go func() {
		o.ObserveOutput("block", []byte("efgh"))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("overflowing producer was blocked")
	}
	close(release)
	var got []OutputChunk
	deadline := time.After(time.Second)
	for len(got) < 3 {
		select {
		case chunk := <-results:
			got = append(got, chunk)
		case <-deadline:
			t.Fatalf("observer did not report overflow: %#v", got)
		}
	}
	if got[0].Complete != true || string(got[0].Raw) != "1234" || got[1].Complete != true || string(got[1].Raw) != "abcd" {
		t.Fatalf("accepted chunks changed: %#v", got)
	}
	if got[2].Complete || got[2].DroppedBytes != 4 {
		t.Fatalf("overflow was not explicitly reported: %#v", got[2])
	}
}
