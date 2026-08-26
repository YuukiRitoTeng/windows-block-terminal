package persistence

import "sync"

var (
	defaultMu    sync.Mutex
	defaultStore *Store
	defaultErr   error
)

// Default returns the process-wide product journal store. Opening failures are
// returned to the caller so the terminal can continue with an in-memory journal.
func Default() (*Store, error) {
	defaultMu.Lock()
	defer defaultMu.Unlock()
	if defaultStore == nil && defaultErr == nil {
		defaultStore, defaultErr = OpenDefault(Options{Enabled: true})
	}
	return defaultStore, defaultErr
}

// CloseDefault drains and closes the process-wide store. It is safe to call
// more than once and is a no-op if Default was never opened.
func CloseDefault() error {
	defaultMu.Lock()
	defer defaultMu.Unlock()
	if defaultStore == nil {
		defaultErr = nil
		return nil
	}
	err := defaultStore.Close()
	defaultStore = nil
	defaultErr = nil
	return err
}
