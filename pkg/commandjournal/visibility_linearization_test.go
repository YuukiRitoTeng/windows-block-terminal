// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package commandjournal

import (
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

// barrierDurable reports every call and can hold the visibility transaction open, so the
// ordering under test is fixed by channels rather than by timing.
type barrierDurable struct {
	mu         sync.Mutex
	generation uint64
	retagged   map[string]uint64
	calls      []string
	enter      chan struct{}
	release    chan struct{}
	blocking   bool
}

func newBarrierDurable() *barrierDurable {
	return &barrierDurable{retagged: map[string]uint64{}, enter: make(chan struct{}, 8), release: make(chan struct{}, 8)}
}

// newBlockingBarrierDurable holds the visibility transaction open until the test releases it,
// which is how the concurrency cases below fix their order without timing.
func newBlockingBarrierDurable() *barrierDurable {
	d := newBarrierDurable()
	d.blocking = true
	return d
}

func (d *barrierDurable) record(call string) {
	d.mu.Lock()
	d.calls = append(d.calls, call)
	d.mu.Unlock()
}

func (d *barrierDurable) Calls() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.calls...)
}

func (d *barrierDurable) Retagged(id string) uint64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.retagged[id]
}

func (d *barrierDurable) RecordStarted(CommandRecord) error         { d.record("started"); return nil }
func (d *barrierDurable) AppendOutput(string, []byte) error         { return nil }
func (d *barrierDurable) RecordFinished(CommandRecord) error        { d.record("finished"); return nil }
func (d *barrierDurable) RecordOutputFinalized(CommandRecord) error { return nil }
func (d *barrierDurable) RecordAborted(CommandRecord) error         { d.record("aborted"); return nil }
func (d *barrierDurable) CurrentVisibilityGeneration(string) (uint64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.generation, nil
}
func (d *barrierDurable) AdvanceVisibilityGeneration(string) (uint64, error) {
	d.record("advance-enter")
	if d.blocking {
		d.enter <- struct{}{}
		<-d.release
	}
	d.mu.Lock()
	d.generation++
	generation := d.generation
	d.mu.Unlock()
	d.record("advance-done")
	return generation, nil
}
func (d *barrierDurable) DeleteHistory(string) (uint64, error) {
	d.mu.Lock()
	d.generation++
	generation := d.generation
	d.mu.Unlock()
	return generation, nil
}
func (d *barrierDurable) RetagRecordGeneration(id string, generation uint64) error {
	d.mu.Lock()
	d.retagged[id] = generation
	d.mu.Unlock()
	d.record("retag:" + id)
	return nil
}

func startEvent(id string, sequence uint64) terminalruntime.StreamItem {
	return journalEvent(terminalruntime.EventCommandStarted, id, sequence)
}

func finishEvent(id string, sequence uint64) terminalruntime.StreamItem {
	return journalEvent(terminalruntime.EventCommandFinished, id, sequence)
}

// The gate is per block: a clear holds it across the durable ack, so the same block's
// lifecycle waits (linearized), while another block keeps running.
func TestClearGateIsPerBlockAndLinearizesLifecycle(t *testing.T) {
	j := New()
	d := newBlockingBarrierDurable()
	j.SetDurableStore(d)
	cleared := make(chan uint64, 1)
	go func() {
		generation, err := j.ClearVisualHistory("block-a")
		if err != nil {
			t.Errorf("clear: %v", err)
		}
		cleared <- generation
	}()
	<-d.enter

	// A lifecycle event for the same block has to wait for the transaction.
	sameBlockApplied := make(chan bool, 1)
	go func() { sameBlockApplied <- j.Apply("block-a", startEvent("late", 1), time.Now()) }()

	// A different block is not blocked by it.
	otherBlockApplied := make(chan bool, 1)
	go func() { otherBlockApplied <- j.Apply("block-b", startEvent("other", 1), time.Now()) }()
	select {
	case ok := <-otherBlockApplied:
		if !ok {
			t.Fatal("an event on another block was refused")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the gate blocked another block")
	}

	d.release <- struct{}{}
	generation := <-cleared
	if ok := <-sameBlockApplied; !ok {
		t.Fatal("the waiting lifecycle event was refused after the clear")
	}
	// The event was applied after the transaction committed: its record belongs to the new
	// generation, which is only possible if it waited for the gate.
	active, ok := j.Active("block-a")
	if !ok || active.ID != "late" || active.VisibilityGeneration != generation {
		t.Fatalf("the event did not land after the transaction: %#v ok=%v generation=%d", active, ok, generation)
	}
}

// C and D both complete before the clear: the record keeps the old generation and disappears.
func TestClearHidesRecordsCompletedBeforeIt(t *testing.T) {
	j := New()
	d := newBarrierDurable()
	j.SetDurableStore(d)
	j.Apply("b", startEvent("c1", 1), time.Now())
	j.Apply("b", finishEvent("c1", 2), time.Now())

	generation, err := j.ClearVisualHistory("b")
	if err != nil {
		t.Fatal(err)
	}

	if records := j.VisibleSnapshot("b"); len(records) != 0 {
		t.Fatalf("a record completed before the clear is still visible: %#v (generation %d)", records, generation)
	}
	if retagged := d.Calls(); len(retagged) > 0 {
		for _, call := range retagged {
			if len(call) > 6 && call[:6] == "retag:" {
				t.Fatalf("the clear issued a durable retag: %s", call)
			}
		}
	}
}

// C before the clear, D after it: the live command is carried into the new generation, so its
// completion stays visible instead of vanishing.
func TestCommandSpanningAClearStaysVisible(t *testing.T) {
	j := New()
	d := newBarrierDurable()
	j.SetDurableStore(d)
	j.Apply("b", startEvent("c2", 1), time.Now())

	if _, err := j.ClearVisualHistory("b"); err != nil {
		t.Fatal(err)
	}
	if d.Retagged("c2") != 0 {
		t.Fatalf("the clear issued a second durable retag: %d", d.Retagged("c2"))
	}
	if !j.Apply("b", finishEvent("c2", 2), time.Now()) {
		t.Fatal("the finish after the clear was refused")
	}

	records := j.VisibleSnapshot("b")
	if len(records) != 1 || records[0].ID != "c2" || records[0].State != StateFinished {
		t.Fatalf("the command that spanned the clear is not visible after it: %#v", records)
	}
}

// A command that starts while the transaction is still waiting for its durable ack belongs to
// the new generation and is visible as soon as it completes.
func TestCommandStartingDuringTheTransactionIsVisible(t *testing.T) {
	j := New()
	d := newBlockingBarrierDurable()
	j.SetDurableStore(d)
	cleared := make(chan uint64, 1)
	go func() {
		generation, _ := j.ClearVisualHistory("b")
		cleared <- generation
	}()
	<-d.enter

	applied := make(chan bool, 2)
	go func() {
		applied <- j.Apply("b", startEvent("c3", 1), time.Now())
		applied <- j.Apply("b", finishEvent("c3", 2), time.Now())
	}()
	d.release <- struct{}{}
	generation := <-cleared
	<-applied
	<-applied

	records := j.VisibleSnapshot("b")
	if len(records) != 1 || records[0].ID != "c3" || records[0].VisibilityGeneration != generation {
		t.Fatalf("the command that ran during the transaction is not visible in the new generation: %#v (generation %d)", records, generation)
	}
}

// Two clears in a row, with lifecycle events on both sides of them: each record stays visible
// exactly when it was live at the commit of the last clear, and none of them is ever lost.
func TestOverlappingClearsKeepOneLinearOrder(t *testing.T) {
	j := New()
	d := newBlockingBarrierDurable()
	j.SetDurableStore(d)

	// A record finished before any clear.
	j.Apply("b", startEvent("old", 1), time.Now())
	j.Apply("b", finishEvent("old", 2), time.Now())

	first := make(chan uint64, 1)
	go func() { generation, _ := j.ClearVisualHistory("b"); first <- generation }()
	<-d.enter
	d.release <- struct{}{}
	generationOne := <-first

	// A record that starts and finishes between the two clears.
	j.Apply("b", startEvent("middle", 3), time.Now())
	j.Apply("b", finishEvent("middle", 4), time.Now())
	if visible := j.VisibleSnapshot("b"); len(visible) != 1 || visible[0].ID != "middle" {
		t.Fatalf("the record from between the clears is not visible: %#v", visible)
	}

	// The second clear: a command that starts while it is in flight has to wait for it.
	second := make(chan uint64, 1)
	go func() { generation, _ := j.ClearVisualHistory("b"); second <- generation }()
	<-d.enter
	applied := make(chan struct{}, 1)
	go func() {
		j.Apply("b", startEvent("after", 5), time.Now())
		applied <- struct{}{}
	}()
	d.release <- struct{}{}
	generationTwo := <-second
	<-applied

	if generationTwo <= generationOne {
		t.Fatalf("generations did not advance in order: %d then %d", generationOne, generationTwo)
	}
	// Nothing was lost: both completed records are still in the block's history, and the command
	// from the second window is still the live one.
	completed := j.Snapshot("b")
	if len(completed) != 2 || completed[0].ID != "old" || completed[1].ID != "middle" {
		t.Fatalf("a completed record was lost across the clears: %#v", completed)
	}
	active, ok := j.Active("b")
	if !ok || active.ID != "after" {
		t.Fatalf("the command from the second window is not live: %#v ok=%v", active, ok)
	}
	// Both earlier records are hidden: the visible generation holds no completed record yet.
	if visible := j.VisibleSnapshot("b"); len(visible) != 0 {
		t.Fatalf("a record from before the last clear is still visible: %#v", visible)
	}
	if active.VisibilityGeneration != generationTwo {
		t.Fatalf("the live command is not in the newest generation: %d != %d", active.VisibilityGeneration, generationTwo)
	}
}
