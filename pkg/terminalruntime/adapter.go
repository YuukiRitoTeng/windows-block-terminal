package terminalruntime

// RuntimeAdapter is the product-facing boundary for this feasibility slice.
// It exposes no Wave controller, Block, RPC, file-store, or xterm types.
type RuntimeAdapter struct {
	sessionID string
	observer  *OutputObserver
}

func NewRuntimeAdapter(sessionID string, onOutput func(OutputChunk), onEvent func(IntegrationEvent)) *RuntimeAdapter {
	a := &RuntimeAdapter{sessionID: sessionID}
	a.observer = NewOutputObserver(sessionID, NewDecoder(), func(chunk OutputChunk, events []IntegrationEvent) {
		if onOutput != nil {
			onOutput(chunk)
		}
		if onEvent != nil {
			for _, event := range events {
				onEvent(event)
			}
		}
	})
	return a
}

func (a *RuntimeAdapter) SessionIdentity() string { return a.sessionID }

// ObserveOutput implements the narrow blockcontroller observer contract.
func (a *RuntimeAdapter) ObserveOutput(blockID string, raw []byte) {
	if a == nil || a.observer == nil {
		return
	}
	if a.sessionID != "" && blockID != "" && blockID != a.sessionID {
		return
	}
	a.observer.ObserveOutput(blockID, raw)
}

func (a *RuntimeAdapter) Close() {
	if a != nil && a.observer != nil {
		a.observer.Close()
	}
}
