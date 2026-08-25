package commandjournal

import (
	"bytes"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

type blockingDurable struct {
	entered    chan struct{}
	release    chan struct{}
	generation uint64
}

func (d *blockingDurable) RecordStarted(CommandRecord) error  { return nil }
func (d *blockingDurable) AppendOutput(string, []byte) error  { return nil }
func (d *blockingDurable) RecordFinished(CommandRecord) error { return nil }
func (d *blockingDurable) RecordAborted(CommandRecord) error  { return nil }
func (d *blockingDurable) CurrentVisibilityGeneration(string) (uint64, error) {
	return d.generation, nil
}
func (d *blockingDurable) AdvanceVisibilityGeneration(string) (uint64, error) {
	close(d.entered)
	<-d.release
	d.generation++
	return d.generation, nil
}
func (d *blockingDurable) DeleteHistory(string) (uint64, error) {
	close(d.entered)
	<-d.release
	d.generation++
	return d.generation, nil
}
func (d *blockingDurable) RetagRecordGeneration(string, uint64) error { return nil }

func journalEvent(kind terminalruntime.EventKind, id string, seq uint64) terminalruntime.StreamItem {
	success := true
	exitCode := 0
	return terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind: kind, SessionEpoch: "shell-epoch-456", HookSequence: seq, CommandID: id,
		Command: "Write-Output one", Cwd: "C:\\tmp", Success: &success, ExitCode: &exitCode,
	}}
}

func TestJournalRecordsOrderedOutputAndSeparatesIdentity(t *testing.T) {
	j := New()
	blockID := "block-123"
	startedAt := time.Unix(10, 0)
	finishedAt := time.Unix(20, 0)
	if j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("before")}, startedAt) {
		t.Fatal("output before C created a record")
	}
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, "cmd-1", 1), startedAt) {
		t.Fatal("start was not recorded")
	}
	if !j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("one")}, startedAt) {
		t.Fatal("output was not recorded")
	}
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandFinished, "cmd-1", 2), finishedAt) {
		t.Fatal("finish was not recorded")
	}
	if j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("outside")}, time.Time{}) {
		t.Fatal("unrelated output changed the journal")
	}
	records := j.Snapshot(blockID)
	if len(records) != 1 {
		t.Fatalf("expected one completed record, got %d", len(records))
	}
	record := records[0]
	if record.WaveBlockID != blockID || record.SessionEpoch != "shell-epoch-456" || record.State != StateFinished || record.CompletionReason != CompletionNormal || !bytes.Equal(record.Output, []byte("one")) {
		t.Fatalf("unexpected record identity/state/output: %#v", record)
	}
	if record.StartHookSequence != 1 || record.FinishHookSequence != 2 || record.StartedAt != startedAt || record.FinishedAt == nil || *record.FinishedAt != finishedAt {
		t.Fatalf("unexpected record lifecycle timestamps: %#v", record)
	}
	record.Output[0] = 'X'
	if !bytes.Equal(j.Snapshot(blockID)[0].Output, []byte("one")) {
		t.Fatal("snapshot exposed mutable output storage")
	}
}

func TestJournalBoundsInMemoryOutputAndRetainsPrefix(t *testing.T) {
	j := New()
	j.SetOutputLimit(10)
	blockID := "bounded"
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, "cmd", 1), time.Now()) {
		t.Fatal("start not recorded")
	}
	j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("123456")}, time.Now())
	j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("abcdefgh")}, time.Now())
	active, ok := j.Active(blockID)
	if !ok || string(active.Output) != "123456abcd" || active.OutputTotalBytes != 14 || active.OutputStoredBytes != 10 || !active.OutputTruncated {
		t.Fatalf("unexpected bounded active output: %#v", active)
	}
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandFinished, "cmd", 2), time.Now()) {
		t.Fatal("finish not recorded")
	}
	record := j.Snapshot(blockID)[0]
	if string(record.Output) != "123456abcd" || record.OutputTotalBytes != 14 || record.OutputStoredBytes != 10 || !record.OutputTruncated {
		t.Fatalf("unexpected bounded snapshot: %#v", record)
	}
}

func TestJournalRejectsMismatchedFinishAndKeepsActive(t *testing.T) {
	j := New()
	blockID := "block-123"
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, "cmd-1", 1), time.Now()) {
		t.Fatal("start was not recorded")
	}
	if j.Apply(blockID, journalEvent(terminalruntime.EventCommandFinished, "cmd-2", 2), time.Now()) {
		t.Fatal("mismatched finish was accepted")
	}
	active, ok := j.Active(blockID)
	if !ok || active.ID != "cmd-1" || active.State != StateRunning {
		t.Fatalf("active command was not preserved: %#v %v", active, ok)
	}
}

func TestJournalSeparatesMultipleBlocks(t *testing.T) {
	j := New()
	for _, blockID := range []string{"block-123", "block-456"} {
		if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, blockID+"-cmd", 1), time.Now()) {
			t.Fatal("start was not recorded")
		}
	}
	if j.Snapshot("block-123") != nil || j.Snapshot("block-456") != nil {
		t.Fatal("running records appeared in completed snapshots")
	}
}

func TestRuntimeObserverRegistersOrderedConsumer(t *testing.T) {
	journal := New()
	blockID := "block-123"
	observer := NewRuntimeObserver(blockID, journal)
	raw := []byte("before")
	raw = append(raw, []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"shell-epoch-456\",\"seq\":1,\"id\":\"cmd-1\"}\a")...)
	raw = append(raw, []byte("one")...)
	raw = append(raw, []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"shell-epoch-456\",\"seq\":2,\"id\":\"cmd-1\",\"success\":true,\"exitcode\":0}\a")...)
	observer.ObserveOutput(blockID, raw)
	observer.Close()
	records := journal.Snapshot(blockID)
	if len(records) != 1 || !bytes.Contains(records[0].Output, []byte("one")) || bytes.Contains(records[0].Output, []byte("before")) {
		t.Fatalf("runtime observer did not record ordered output: %#v", records)
	}
}

func TestRuntimeObserverSeparatesTwoCommandsInOneSubmission(t *testing.T) {
	journal := New()
	blockID := "block-123"
	observer := NewRuntimeObserver(blockID, journal)
	raw := []byte("background-before")
	raw = append(raw, []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"shell-epoch-456\",\"seq\":1,\"id\":\"cmd-1\"}\aone")...)
	raw = append(raw, []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"shell-epoch-456\",\"seq\":2,\"id\":\"cmd-1\",\"success\":true,\"exitcode\":0}\a")...)
	raw = append(raw, []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"shell-epoch-456\",\"seq\":3,\"id\":\"cmd-2\"}\atwo")...)
	raw = append(raw, []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"shell-epoch-456\",\"seq\":4,\"id\":\"cmd-2\",\"success\":true,\"exitcode\":0}\abackground-after")...)
	observer.ObserveOutput(blockID, raw)
	observer.Close()
	records := journal.Snapshot(blockID)
	if len(records) != 2 || !bytes.Equal(records[0].Output, []byte("one")) || !bytes.Equal(records[1].Output, []byte("two")) {
		t.Fatalf("commands or output crossed boundaries: %#v", records)
	}
}

func TestJournalAbortsWithoutFabricatingResult(t *testing.T) {
	j := New()
	blockID := "block-recovery"
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, "cmd-1", 1), time.Now()) {
		t.Fatal("start was not recorded")
	}
	if !j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("inside")}, time.Now()) {
		t.Fatal("output was not recorded")
	}
	if !j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind: terminalruntime.EventCommandAborted, CommandID: "cmd-1", SessionEpoch: "shell-epoch-456", CompletionReason: string(CompletionMissingFinish),
	}}, time.Now()) {
		t.Fatal("abort was not recorded")
	}
	records := j.Snapshot(blockID)
	if len(records) != 1 || records[0].State != StateAborted || records[0].CompletionReason != CompletionMissingFinish || records[0].Success != nil || records[0].ExitCode != nil || records[0].FinishHookSequence != 0 || !bytes.Equal(records[0].Output, []byte("inside")) {
		t.Fatalf("unexpected aborted record: %#v", records)
	}
	if j.AbortActive(blockID, CompletionSessionEnded, time.Now()) {
		t.Fatal("second abort changed completed record")
	}
}

func TestJournalRetainsOutputBeforeBackendAbort(t *testing.T) {
	j := New()
	blockID := "block-drain"
	started := journalEvent(terminalruntime.EventCommandStarted, "cmd-1", 1)
	if !j.Apply(blockID, started, time.Now()) {
		t.Fatal("start was not recorded")
	}
	if !j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("final-output")}, time.Now()) {
		t.Fatal("final output was not recorded")
	}
	if !j.AbortActive(blockID, CompletionControllerStop, time.Now()) {
		t.Fatal("controller stop did not abort active record")
	}
	records := j.Snapshot(blockID)
	if len(records) != 1 || !bytes.Equal(records[0].Output, []byte("final-output")) || records[0].CompletionReason != CompletionControllerStop {
		t.Fatalf("drain output was lost: %#v", records)
	}
}

func TestRuntimeObserverPromptRecoveryDoesNotAttributePromptBytes(t *testing.T) {
	j := New()
	blockID := "block-prompt-recovery"
	o := NewRuntimeObserver(blockID, j)
	raw := []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"epoch-1\",\"seq\":1,\"id\":\"cmd-1\"}\ainside")
	raw = append(raw, []byte("\x1b]16162;P;{\"v\":1,\"epoch\":\"epoch-1\",\"seq\":2}\aprompt-text")...)
	o.ObserveOutput(blockID, raw)
	o.Close()
	records := j.Snapshot(blockID)
	if len(records) != 1 || records[0].State != StateAborted || records[0].CompletionReason != CompletionMissingFinish || !bytes.Equal(records[0].Output, []byte("inside")) {
		t.Fatalf("prompt bytes contaminated aborted record: %#v", records)
	}
}

func TestJournalFinishedDWinsBeforeTerminationAbort(t *testing.T) {
	j := New()
	blockID := "block-d-wins"
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, "cmd-1", 1), time.Now()) {
		t.Fatal("start was not recorded")
	}
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandFinished, "cmd-1", 2), time.Now()) {
		t.Fatal("finish was not recorded")
	}
	if j.AbortActive(blockID, CompletionSessionEnded, time.Now()) {
		t.Fatal("termination abort changed a finished record")
	}
	records := j.Snapshot(blockID)
	if len(records) != 1 || records[0].State != StateFinished || records[0].CompletionReason != CompletionNormal {
		t.Fatalf("finished record was changed by EOF: %#v", records)
	}
}

func TestRuntimeObserverKeepsForeignNestedLifecycleInsideOuterRecord(t *testing.T) {
	j := New()
	blockID := "block-nested"
	o := NewRuntimeObserver(blockID, j)
	raw := []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"epoch-a\",\"seq\":1,\"id\":\"outer\"}\anormal ")
	raw = append(raw, []byte("\x1b]16162;M;{\"v\":1,\"epoch\":\"epoch-b\",\"seq\":1}\aremote")...)
	raw = append(raw, []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"epoch-b\",\"seq\":2,\"id\":\"inner\"}\ainner")...)
	raw = append(raw, []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"epoch-b\",\"seq\":3,\"id\":\"inner\",\"success\":true,\"exitcode\":0}\a")...)
	raw = append(raw, []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"epoch-a\",\"seq\":2,\"id\":\"outer\",\"success\":true,\"exitcode\":0}\a")...)
	o.ObserveOutput(blockID, raw)
	o.Close()
	records := j.Snapshot(blockID)
	if len(records) != 1 || records[0].ID != "outer" || records[0].State != StateFinished || records[0].CompletionReason != CompletionNormal || !bytes.Contains(records[0].Output, []byte("remoteinner")) {
		t.Fatalf("nested integration created or replaced a record: %#v", records)
	}
}

func TestClearDoesNotHoldJournalLockAcrossDurableAck(t *testing.T) {
	j := New()
	d := &blockingDurable{entered: make(chan struct{}), release: make(chan struct{})}
	j.SetDurableStore(d)
	done := make(chan struct{})
	go func() { _, _ = j.ClearVisualHistory("b"); close(done) }()
	<-d.entered
	if !j.Apply("b", journalEvent(terminalruntime.EventCommandStarted, "c", 1), time.Now()) {
		t.Fatal("journal lock was held during durable clear")
	}
	close(d.release)
	<-done
}

func TestDeleteDoesNotHoldJournalLockAcrossDurableAck(t *testing.T) {
	j := New()
	d := &blockingDurable{entered: make(chan struct{}), release: make(chan struct{})}
	j.SetDurableStore(d)
	done := make(chan struct{})
	go func() { _ = j.DeleteHistory("b"); close(done) }()
	<-d.entered
	if !j.Apply("b", journalEvent(terminalruntime.EventCommandStarted, "c", 1), time.Now()) {
		t.Fatal("journal lock was held during durable delete")
	}
	close(d.release)
	<-done
}

func TestClearFinishDuringReconciliationRetagsActiveCommand(t *testing.T) {
	j := New()
	d := &blockingDurable{entered: make(chan struct{}), release: make(chan struct{})}
	j.SetDurableStore(d)
	blockID := "clear-race"
	j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, "c1", 1), time.Now())
	hookEntered, allow := make(chan struct{}), make(chan struct{})
	j.reconcileHook = func() { close(hookEntered); <-allow }
	done := make(chan struct{})
	go func() { _, _ = j.ClearVisualHistory(blockID); close(done) }()
	<-d.entered
	close(d.release)
	<-hookEntered
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandFinished, "c1", 2), time.Now()) {
		t.Fatal("finish was not accepted during reconciliation")
	}
	close(allow)
	<-done
	records := j.VisibleSnapshot(blockID)
	if len(records) != 1 || records[0].ID != "c1" || records[0].State != StateFinished || records[0].VisibilityGeneration != 1 {
		t.Fatalf("clear race lost record or generation: %#v", records)
	}
}

func TestDeleteFinishDuringReconciliationPreservesActiveCommand(t *testing.T) {
	j := New()
	d := &blockingDurable{entered: make(chan struct{}), release: make(chan struct{})}
	j.SetDurableStore(d)
	blockID := "delete-race"
	j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, "old", 1), time.Now())
	j.Apply(blockID, journalEvent(terminalruntime.EventCommandFinished, "old", 2), time.Now())
	j.Apply(blockID, journalEvent(terminalruntime.EventCommandStarted, "c1", 3), time.Now())
	hookEntered, allow := make(chan struct{}), make(chan struct{})
	j.reconcileHook = func() { close(hookEntered); <-allow }
	done := make(chan struct{})
	go func() { _ = j.DeleteHistory(blockID); close(done) }()
	<-d.entered
	close(d.release)
	<-hookEntered
	if !j.Apply(blockID, journalEvent(terminalruntime.EventCommandFinished, "c1", 4), time.Now()) {
		t.Fatal("finish was not accepted during delete reconciliation")
	}
	close(allow)
	<-done
	records := j.VisibleSnapshot(blockID)
	if len(records) != 1 || records[0].ID != "c1" || records[0].State != StateFinished || records[0].VisibilityGeneration != 1 {
		t.Fatalf("delete race lost active completion: %#v", records)
	}
}
