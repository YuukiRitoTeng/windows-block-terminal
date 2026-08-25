package persistence

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/commandjournal"
)

func testRecord() commandjournal.CommandRecord {
	return commandjournal.CommandRecord{ID: "c1", WaveBlockID: "b1", SessionEpoch: "e1", StartHookSequence: 1, Command: "echo hi", Cwd: "C:\\", State: commandjournal.StateRunning, StartedAt: time.UnixMilli(1000)}
}

func openTest(t *testing.T, opts Options) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "journal.sqlite")
	s, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	return s, path
}

func TestStoreOrderingAndRecovery(t *testing.T) {
	s, path := openTest(t, Options{Enabled: true, MaxChunkBytes: 4})
	r := testRecord()
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOutput(r.ID, []byte("abcdefgh")); err != nil {
		t.Fatal(err)
	}
	finished := r
	finished.State = commandjournal.StateFinished
	finished.CompletionReason = commandjournal.CompletionNormal
	ok := true
	code := 0
	now := time.UnixMilli(2000)
	finished.Success = &ok
	finished.ExitCode = &code
	finished.FinishedAt = &now
	finished.FinishHookSequence = 2
	finished.OutputTotalBytes = 8
	finished.OutputStoredBytes = 8
	if err := s.RecordFinished(finished); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	out, err := s.ReadOutput(r.ID)
	if err != nil || string(out) != "abcdefgh" {
		t.Fatalf("output=%q err=%v", out, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	recs, err := s.ReadVisibleRecords("b1")
	if err != nil || len(recs) != 1 {
		t.Fatalf("records=%d err=%v", len(recs), err)
	}
	if recs[0].Success == nil || !*recs[0].Success || recs[0].ExitCode == nil || *recs[0].ExitCode != 0 {
		t.Fatalf("bad completion: %+v", recs[0])
	}
}

func TestStaleRunningRecoveryAndOutputLimit(t *testing.T) {
	s, path := openTest(t, Options{Enabled: true, MaxOutputBytes: 5, MaxChunkBytes: 3})
	var err error
	r := testRecord()
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOutput(r.ID, []byte("123456789")); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	recs, err := s.ReadVisibleRecords("b1")
	if err != nil || len(recs) != 1 {
		t.Fatalf("records=%d err=%v", len(recs), err)
	}
	if recs[0].State != commandjournal.StateAborted || recs[0].CompletionReason != commandjournal.CompletionAppRestartRecovery {
		t.Fatalf("recovery=%+v", recs[0])
	}
	out, err := s.ReadOutput("c1")
	if err != nil || string(out) != "12345" {
		t.Fatalf("output=%q err=%v", out, err)
	}
	if recs[0].OutputTotalBytes != 9 || recs[0].OutputStoredBytes != 5 || !recs[0].OutputTruncated {
		t.Fatalf("metadata=%+v", recs[0])
	}
}

func TestClearDeleteAndDisabled(t *testing.T) {
	s, _ := openTest(t, Options{Enabled: true})
	r := testRecord()
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(2)
	ok := true
	code := 0
	r.State = commandjournal.StateFinished
	r.CompletionReason = commandjournal.CompletionNormal
	r.FinishedAt = &now
	r.Success = &ok
	r.ExitCode = &code
	if err := s.RecordFinished(r); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AdvanceVisibilityGeneration("b1"); err != nil {
		t.Fatal(err)
	}
	visible, err := s.ReadVisibleRecords("b1")
	if err != nil || len(visible) != 0 {
		t.Fatalf("visible=%d err=%v", len(visible), err)
	}
	if _, err := os.Stat(s.Path()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteHistory("b1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	disabled, err := Open(filepath.Join(t.TempDir(), "none.sqlite"), Options{Enabled: false})
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Enabled() {
		t.Fatal("disabled store enabled")
	}
	if err := disabled.Flush(); err != nil {
		t.Fatal(err)
	}
}

func TestGenerationReadErrorIsNotZeroSuccess(t *testing.T) {
	s, _ := openTest(t, Options{Enabled: true})
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if generation, err := s.CurrentVisibilityGeneration("b1"); err == nil || generation != 0 {
		t.Fatalf("query failure was not reported: generation=%d err=%v", generation, err)
	}
}

func TestCloseIsIdempotentAndDrains(t *testing.T) {
	s, _ := openTest(t, Options{Enabled: true})
	r := testRecord()
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOutput(r.ID, []byte("queued")); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestOutputQueueBudgetReportsIncompleteHistory(t *testing.T) {
	s, _ := openTest(t, Options{Enabled: true, MaxQueueBytes: 4})
	r := testRecord()
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOutput(r.ID, []byte("12345")); !errors.Is(err, ErrOutputQueueOverflow) {
		t.Fatalf("expected queue overflow, got %v", err)
	}
	health := s.Health()
	if health.Status != HealthDegraded || health.OutputComplete || health.DroppedOutputBytes != 5 {
		t.Fatalf("unexpected degraded health: %#v", health)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}
