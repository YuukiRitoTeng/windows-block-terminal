package commandjournal

import (
	"time"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

// RuntimeObserver is the production consumer at the blockcontroller output
// tap. Runtime parsing remains asynchronous and never runs on the PTY reader.
type RuntimeObserver struct {
	adapter *terminalruntime.RuntimeAdapter
	journal *Journal
}

func NewRuntimeObserver(blockID string, journal *Journal) *RuntimeObserver {
	if journal == nil {
		journal = New()
	}
	observer := &RuntimeObserver{journal: journal}
	observer.adapter = terminalruntime.NewRuntimeAdapterWithStream(blockID, nil, nil, func(_ terminalruntime.OutputChunk, items []terminalruntime.StreamItem) {
		for _, item := range items {
			observer.journal.Apply(blockID, item, time.Now())
		}
	})
	return observer
}

func (o *RuntimeObserver) ObserveOutput(blockID string, raw []byte) {
	if o == nil || o.adapter == nil {
		return
	}
	o.adapter.ObserveOutput(blockID, raw)
}

func (o *RuntimeObserver) Close() {
	if o != nil && o.adapter != nil {
		o.adapter.Close()
	}
}

func (o *RuntimeObserver) Journal() *Journal {
	if o == nil {
		return nil
	}
	return o.journal
}
