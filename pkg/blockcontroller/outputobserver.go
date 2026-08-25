package blockcontroller

import "sync"

// OutputObserver is a read-only tap at the raw PTY-to-Wave file boundary.
// Implementations must return quickly; the terminal path remains authoritative.
type OutputObserver interface {
	ObserveOutput(blockID string, data []byte)
}

var outputObservers = struct {
	sync.RWMutex
	byBlock map[string]*registeredOutputObserver
}{byBlock: make(map[string]*registeredOutputObserver)}

type registeredOutputObserver struct {
	observer OutputObserver
}

// RegisterOutputObserver installs one observer for a Wave terminal session.
// The returned function unregisters that observer and is safe to call repeatedly.
func RegisterOutputObserver(blockID string, observer OutputObserver) func() {
	if blockID == "" || observer == nil {
		return func() {}
	}
	registration := &registeredOutputObserver{observer: observer}
	outputObservers.Lock()
	outputObservers.byBlock[blockID] = registration
	outputObservers.Unlock()
	return func() {
		outputObservers.Lock()
		if current, ok := outputObservers.byBlock[blockID]; ok && current == registration {
			delete(outputObservers.byBlock, blockID)
		}
		outputObservers.Unlock()
	}
}

func notifyOutputObservers(blockID string, data []byte) {
	outputObservers.RLock()
	registration := outputObservers.byBlock[blockID]
	outputObservers.RUnlock()
	if registration == nil || registration.observer == nil {
		return
	}
	defer func() { _ = recover() }()
	registration.observer.ObserveOutput(blockID, data)
}
