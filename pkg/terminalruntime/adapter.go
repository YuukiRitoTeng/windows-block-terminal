package terminalruntime

// RuntimeAdapter is the product-facing boundary between Wave output and the
// command journal runtime.
// It exposes no Wave controller, Block, RPC, file-store, or xterm types.
type RuntimeAdapter struct {
	blockID  string
	observer *OutputObserver
}

func NewRuntimeAdapter(blockID string, onOutput func(OutputChunk), onEvent func(IntegrationEvent)) *RuntimeAdapter {
	return NewRuntimeAdapterWithStream(blockID, onOutput, onEvent, nil)
}

func NewRuntimeAdapterWithStream(blockID string, onOutput func(OutputChunk), onEvent func(IntegrationEvent), onStream func(OutputChunk, []StreamItem)) *RuntimeAdapter {
	a := &RuntimeAdapter{blockID: blockID}
	a.observer = NewOutputObserverWithStream(blockID, NewDecoder(), func(chunk OutputChunk, events []IntegrationEvent) {
		if onOutput != nil {
			onOutput(chunk)
		}
		if onEvent != nil {
			for _, event := range events {
				onEvent(event)
			}
		}
	}, onStream)
	return a
}

func (a *RuntimeAdapter) BlockID() string { return a.blockID }

// ObserveOutput implements the narrow blockcontroller observer contract.
func (a *RuntimeAdapter) ObserveOutput(blockID string, raw []byte) {
	if a == nil || a.observer == nil {
		return
	}
	if a.blockID != "" && blockID != "" && blockID != a.blockID {
		return
	}
	a.observer.ObserveOutput(blockID, raw)
}

func (a *RuntimeAdapter) Close() {
	if a != nil && a.observer != nil {
		a.observer.Close()
	}
}
