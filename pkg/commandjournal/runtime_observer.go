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
	anchor  *VisualAnchorRegistry
}

func NewRuntimeObserver(blockID string, journal *Journal, anchor ...*VisualAnchorRegistry) *RuntimeObserver {
	if journal == nil {
		journal = New()
	}
	var anchorRegistry *VisualAnchorRegistry
	if len(anchor) > 0 {
		anchorRegistry = anchor[0]
	}
	observer := &RuntimeObserver{journal: journal, anchor: anchorRegistry}
	observer.adapter = terminalruntime.NewRuntimeAdapterWithStream(blockID, nil, nil, func(chunk terminalruntime.OutputChunk, items []terminalruntime.StreamItem) {
		if !chunk.Complete {
			observer.journal.MarkOutputIncomplete(blockID, chunk.DroppedBytes)
		}
		for _, item := range items {
			if item.Kind == terminalruntime.StreamIntegrationEvent && item.Event.Kind == terminalruntime.EventVisualAnchor {
				if observer.anchor != nil {
					observer.anchor.ObserveAnchor(item.Event)
				}
				continue
			}
			if item.Kind == terminalruntime.StreamOutputSegment && (item.Source == "" || item.Source == terminalruntime.OutputSourceUnknown) {
				item.Source = terminalruntime.OutputSourcePTY
			}
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
