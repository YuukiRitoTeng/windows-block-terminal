// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package persistence

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func startItem(id string, sequence uint64) terminalruntime.StreamItem {
	return terminalruntime.StreamItem{
		Kind: terminalruntime.StreamIntegrationEvent,
		Event: terminalruntime.IntegrationEvent{
			Kind:         terminalruntime.EventCommandStarted,
			Authority:    terminalruntime.AuthorityTerminalOSC,
			SessionEpoch: "shell-epoch-456",
			HookSequence: sequence,
			CommandID:    id,
			Command:      "Write-Output one",
			Cwd:          "C:\\tmp",
		},
	}
}

func finishItem(id string, sequence uint64) terminalruntime.StreamItem {
	ok, code := true, 0
	return terminalruntime.StreamItem{
		Kind: terminalruntime.StreamIntegrationEvent,
		Event: terminalruntime.IntegrationEvent{
			Kind:          terminalruntime.EventCommandFinished,
			Authority:     terminalruntime.AuthorityTerminalOSC,
			SessionEpoch:  "shell-epoch-456",
			HookSequence:  sequence,
			CommandID:     id,
			Success:       &ok,
			ExitCode:      &code,
			ExecutionMode: terminalruntime.ExecutionModeUnknown,
		},
	}
}

func openStore(t *testing.T, path string) *Store {
	t.Helper()
	store, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// sameIDs compares the visible set without depending on the store's tie-break ordering.
func sameIDs(ids []string, want ...string) bool {
	if len(ids) != len(want) {
		return false
	}
	seen := map[string]int{}
	for _, id := range ids {
		seen[id]++
	}
	for _, id := range want {
		seen[id]--
	}
	for _, count := range seen {
		if count != 0 {
			return false
		}
	}
	return true
}

func visibleIDs(t *testing.T, store *Store, blockID string) []string {
	t.Helper()
	if err := store.Flush(); err != nil {
		t.Fatal(err)
	}
	records, err := store.ReadVisibleRecords(blockID)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(records))
	for _, record := range records {
		ids = append(ids, record.ID)
	}
	return ids
}

// The durable visibility transaction is the commit point. When it cannot run, nothing may
// change: neither the durable generation nor the records, and the journal's in-memory
// generation must not advance either. The production clear never retags in a second phase, so
// there is no window in which the durable side is half-committed.
func TestVisibilityTransactionFailureLeavesEverythingUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.sqlite")
	store := openStore(t, path)
	journal := commandjournal.New()
	journal.SetDurableStore(store)
	blockID := "block-visibility-failure"

	journal.Apply(blockID, startItem("old", 1), time.Now())
	journal.Apply(blockID, finishItem("old", 2), time.Now())
	journal.Apply(blockID, startItem("live", 3), time.Now())
	generation, err := journal.ClearVisualHistory(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if generation != 1 {
		t.Fatalf("first clear advanced the wrong generation: %d", generation)
	}
	// The live command crossed the clear, so it stays visible.
	if ids := visibleIDs(t, store, blockID); len(ids) != 1 || ids[0] != "live" {
		t.Fatalf("visible records after the first clear: %v", ids)
	}

	// Failure injection: the store is closed, so the next durable transaction cannot run.
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.ClearVisualHistory(blockID); err == nil {
		t.Fatal("a clear with an unavailable durable store reported success")
	}
	// The in-memory generation did not advance, and the active record still belongs to the
	// generation the successful transaction established.
	active, ok := journal.Active(blockID)
	if !ok || active.ID != "live" || active.VisibilityGeneration != generation {
		t.Fatalf("the failed clear changed the in-memory state: %#v ok=%v generation=%d", active, ok, generation)
	}
	if visible := journal.VisibleSnapshot(blockID); len(visible) != 0 {
		t.Fatalf("the failed clear changed what is visible in memory: %#v", visible)
	}

	// Reopening the same file shows the durable side also unchanged.
	reopened := openStore(t, path)
	defer func() { _ = reopened.Close() }()
	if ids := visibleIDs(t, reopened, blockID); len(ids) != 1 || ids[0] != "live" {
		t.Fatalf("the failed clear changed the durable visibility: %v", ids)
	}
	current, err := reopened.CurrentVisibilityGeneration(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if current != generation {
		t.Fatalf("the failed clear advanced the durable generation: %d != %d", current, generation)
	}
}

// The success path keeps the current behaviour: the generation advances in one transaction and
// the running record of that block moves into the new generation with it.
func TestVisibilityTransactionSuccessCommitsBothFacts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.sqlite")
	store := openStore(t, path)
	defer func() { _ = store.Close() }()
	journal := commandjournal.New()
	journal.SetDurableStore(store)
	blockID := "block-visibility-success"

	journal.Apply(blockID, startItem("old", 1), time.Now())
	journal.Apply(blockID, finishItem("old", 2), time.Now())
	journal.Apply(blockID, startItem("live", 3), time.Now())

	generation, err := journal.ClearVisualHistory(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if generation != 1 {
		t.Fatalf("generation=%d want 1", generation)
	}
	// One transaction moved the running row into the new generation, so the store reports the
	// generation the clear established and the live record is the visible one.
	current, err := store.CurrentVisibilityGeneration(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if current != generation {
		t.Fatalf("durable generation=%d want %d", current, generation)
	}
	if ids := visibleIDs(t, store, blockID); len(ids) != 1 || ids[0] != "live" {
		t.Fatalf("visible records after the clear: %v", ids)
	}

	// A record completed after the clear belongs to the new generation immediately.
	journal.Apply(blockID, finishItem("live", 4), time.Now())
	journal.Apply(blockID, startItem("next", 5), time.Now())
	journal.Apply(blockID, finishItem("next", 6), time.Now())
	if ids := visibleIDs(t, store, blockID); !sameIDs(ids, "live", "next") {
		t.Fatalf("visible records after the new command: %v", ids)
	}

	// Reopening keeps exactly that: the hidden record does not come back, the new ones stay.
	reopened := openStore(t, path)
	defer func() { _ = reopened.Close() }()
	if ids := visibleIDs(t, reopened, blockID); !sameIDs(ids, "live", "next") {
		t.Fatalf("visible records after reopening: %v", ids)
	}
}

// The durable transaction of a clear is a single SQL transaction: generation advance and the
// running-row update. Failing the *second* statement (with a real SQLite trigger) must roll the
// whole transaction back, so a mid-transaction failure cannot leave a half-advanced generation.
func TestClearTransactionRollsBackOnMidTransactionFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.sqlite")
	store := openStore(t, path)
	defer func() { _ = store.Close() }()
	journal := commandjournal.New()
	journal.SetDurableStore(store)
	blockID := "block-mid-failure"

	journal.Apply(blockID, startItem("live", 1), time.Now())
	if err := store.Flush(); err != nil {
		t.Fatal(err)
	}
	// The trigger fails the running-row UPDATE that the visibility transaction performs after it
	// has already written journal_state.
	if _, err := store.db.Exec(`CREATE TRIGGER fail_running_retag BEFORE UPDATE ON command_records
		WHEN NEW.state = 'running'
		BEGIN SELECT RAISE(FAIL, 'injected mid-transaction failure'); END`); err != nil {
		t.Fatal(err)
	}

	if _, err := journal.ClearVisualHistory(blockID); err == nil {
		t.Fatal("a mid-transaction failure was reported as a successful clear")
	}
	// Nothing advanced: not the durable generation, not the visible set, not the memory state.
	current, err := store.CurrentVisibilityGeneration(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if current != 0 {
		t.Fatalf("the rolled back transaction advanced the durable generation: %d", current)
	}
	active, ok := journal.Active(blockID)
	if !ok || active.ID != "live" || active.VisibilityGeneration != 0 {
		t.Fatalf("the failed clear changed the in-memory state: %#v ok=%v", active, ok)
	}

	// Once the injected failure is gone the clear works and commits both facts.
	if _, err := store.db.Exec(`DROP TRIGGER fail_running_retag`); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.ClearVisualHistory(blockID); err != nil {
		t.Fatal(err)
	}
	current, err = store.CurrentVisibilityGeneration(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if current != 1 {
		t.Fatalf("the retried clear did not commit: generation %d", current)
	}
	// Reopening shows the running row moved into the committed generation: the generation advance
	// and the running-row retag are the same durable fact. (The injected-failure store itself stays
	// degraded by design, so the post-commit state is read through a fresh handle on the same file.)
	reopened := openStore(t, path)
	defer func() { _ = reopened.Close() }()
	reopenedGeneration, err := reopened.CurrentVisibilityGeneration(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if reopenedGeneration != 1 {
		t.Fatalf("the reopened store lost the committed generation: %d", reopenedGeneration)
	}
	if ids := visibleIDs(t, reopened, blockID); !sameIDs(ids, "live") {
		t.Fatalf("the reopened store lost the running row's generation: %v", ids)
	}
}

// replaceRetagDurable fails every RetagRecordGeneration call, which is exactly the second-phase
// durable call the production clear and delete must not make any more.
type replaceRetagDurable struct {
	*Store
}

func (d *replaceRetagDurable) RetagRecordGeneration(string, uint64) error {
	return errRetagMustNotRun
}

var errRetagMustNotRun = errRetag{}

type errRetag struct{}

func (errRetag) Error() string {
	return "RetagRecordGeneration must not be called by a production clear or delete"
}

func TestProductionVisibilityPathsHaveNoSecondDurableCall(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.sqlite")
	store := openStore(t, path)
	defer func() { _ = store.Close() }()
	journal := commandjournal.New()
	journal.SetDurableStore(&replaceRetagDurable{Store: store})
	blockID := "block-no-second-call"

	journal.Apply(blockID, startItem("c1", 1), time.Now())
	journal.Apply(blockID, finishItem("c1", 2), time.Now())
	journal.Apply(blockID, startItem("c2", 3), time.Now())

	// Both paths must succeed although any second durable retag would fail loudly.
	if _, err := journal.ClearVisualHistory(blockID); err != nil {
		t.Fatalf("the clear made a second durable call: %v", err)
	}
	if err := journal.DeleteHistory(blockID); err != nil {
		t.Fatalf("the delete made a second durable call: %v", err)
	}
}

// A mid-transaction failure must leave the durable state exactly as it was, checked immediately
// after a close/reopen: the generation row and the running record keep their old generation.
func TestClearMidTransactionFailureLeavesDurableStateUntouched(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.sqlite")
	store := openStore(t, path)
	journal := commandjournal.New()
	journal.SetDurableStore(store)
	blockID := "block-mid-failure-reopen"

	journal.Apply(blockID, startItem("live", 1), time.Now())
	if err := store.Flush(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`CREATE TRIGGER fail_running_retag_reopen BEFORE UPDATE ON command_records
		WHEN NEW.state = 'running'
		BEGIN SELECT RAISE(FAIL, 'injected mid-transaction failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.ClearVisualHistory(blockID); err == nil {
		t.Fatal("a mid-transaction failure was reported as a successful clear")
	}
	// The store that saw the injected failure stays degraded by design: its Close reports the
	// remembered failure. That is not a test failure - the file state is what matters here.
	_ = store.Close()

	reopened := openStore(t, path)
	defer func() { _ = reopened.Close() }()
	var stateGeneration uint64
	// The rolled back transaction also rolled back its own generation row, so "no row" is the
	// expected shape of "the generation never advanced".
	err := reopened.db.QueryRow(`SELECT current_visibility_generation FROM journal_state WHERE wave_block_id=?`, blockID).Scan(&stateGeneration)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("reading the generation row: %v", err)
	}
	if stateGeneration != 0 {
		t.Fatalf("the rolled back transaction left a generation behind: %d", stateGeneration)
	}
	var recordGeneration uint64
	if err := reopened.db.QueryRow(`SELECT visibility_generation FROM command_records WHERE id=?`, "live").Scan(&recordGeneration); err != nil {
		t.Fatalf("reading the running record: %v", err)
	}
	if recordGeneration != 0 {
		t.Fatalf("the rolled back transaction retagged the running row: %d", recordGeneration)
	}
}
