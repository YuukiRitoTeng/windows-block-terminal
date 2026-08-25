package commandjournalservice

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/commandjournal/persistence"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func TestProductReadControlSeam(t *testing.T) {
	store, err := persistence.Open(filepath.Join(t.TempDir(), "journal.sqlite"), persistence.Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	r := commandjournal.CommandRecord{ID: "cmd-1", WaveBlockID: "block-1", SessionEpoch: "epoch", StartHookSequence: 1, Command: "Write-Output one", Cwd: "C:\\", State: commandjournal.StateRunning, StartedAt: time.UnixMilli(10), OutputCompleteness: commandjournal.OutputCompletenessComplete, OutputAttribution: commandjournal.OutputAttributionUnknown, OutputTextSafety: commandjournal.OutputTextSafetyUnknown}
	if err := store.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendOutput(r.ID, []byte("one\r\ntwo\r\n")); err != nil {
		t.Fatal(err)
	}
	ok, code := true, 0
	finished := r
	finished.State = commandjournal.StateFinished
	finished.CompletionReason = commandjournal.CompletionNormal
	finished.FinishedAt = ptrTime(time.UnixMilli(20))
	finished.Success = &ok
	finished.ExitCode = &code
	finished.FinishHookSequence = 2
	finished.OutputTotalBytes = 10
	finished.OutputStoredBytes = 10
	if err := store.RecordFinished(finished); err != nil {
		t.Fatal(err)
	}
	service := &CommandJournalService{Store: store}
	visible, err := service.ListVisibleRecords(context.Background(), "block-1")
	if err != nil || len(visible) != 1 || visible[0].ID != r.ID {
		t.Fatalf("visible records=%#v err=%v", visible, err)
	}
	out, err := service.GetOutput(context.Background(), r.ID)
	if err != nil || string(out.Data) != "one\r\ntwo\r\n" || out.TotalBytes != 10 || out.StoredBytes != 10 || out.Truncated || out.Completeness != commandjournal.OutputCompletenessComplete {
		t.Fatalf("output view=%#v err=%v", out, err)
	}
	if _, err := service.ClearVisualHistory(context.Background(), "block-1"); err != nil {
		t.Fatal(err)
	}
	visible, err = service.ListVisibleRecords(context.Background(), "block-1")
	if err != nil || len(visible) != 0 {
		t.Fatalf("clear did not hide old generation: %#v err=%v", visible, err)
	}
	if physical, err := store.ReadOutput(r.ID); err != nil || string(physical) != "one\r\ntwo\r\n" {
		t.Fatalf("clear removed physical output: %q err=%v", physical, err)
	}
	if err := service.DeleteHistory(context.Background(), "block-1"); err != nil {
		t.Fatal(err)
	}
	if physical, err := store.ReadOutput(r.ID); err != nil || len(physical) != 0 {
		t.Fatalf("delete did not remove physical output: %q err=%v", physical, err)
	}
}

func TestProductHealthSeam(t *testing.T) {
	store, err := persistence.Open(filepath.Join(t.TempDir(), "journal.sqlite"), persistence.Options{Enabled: true, MaxQueueBytes: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	service := &CommandJournalService{Store: store}
	r := commandjournal.CommandRecord{ID: "cmd-health", WaveBlockID: "block-health", SessionEpoch: "epoch", StartHookSequence: 1, Command: "echo", Cwd: "C:\\", State: commandjournal.StateRunning, StartedAt: time.Now()}
	if err := store.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendOutput(r.ID, []byte("overflow")); err == nil {
		t.Fatal("expected output queue failure")
	}
	health, err := service.GetHealth(context.Background())
	if err != nil || health.Status != string(persistence.HealthDegraded) || health.OutputComplete {
		t.Fatalf("health=%#v err=%v", health, err)
	}
}

func TestRecorderOverflowIsNotReportedAsComplete(t *testing.T) {
	store, err := persistence.Open(filepath.Join(t.TempDir(), "journal.sqlite"), persistence.Options{Enabled: true, MaxQueueBytes: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	j := commandjournal.New()
	j.SetDurableStore(store)
	start := commandjournal.CommandRecord{ID: "cmd-incomplete", WaveBlockID: "block-incomplete", SessionEpoch: "epoch", StartHookSequence: 1, Command: "echo", Cwd: "C:\\", State: commandjournal.StateRunning, StartedAt: time.Now()}
	if !j.Apply("block-incomplete", terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{Kind: terminalruntime.EventCommandStarted, SessionEpoch: start.SessionEpoch, HookSequence: 1, CommandID: start.ID, Command: start.Command, Cwd: start.Cwd}}, time.Now()) {
		t.Fatal("start not recorded")
	}
	j.Apply("block-incomplete", terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("overflow")}, time.Now())
	success, code := true, 0
	if !j.Apply("block-incomplete", terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{Kind: terminalruntime.EventCommandFinished, SessionEpoch: start.SessionEpoch, HookSequence: 2, CommandID: start.ID, Success: &success, ExitCode: &code}}, time.Now()) {
		t.Fatal("finish not recorded")
	}
	if err := store.Flush(); err != nil {
		t.Fatal(err)
	}
	view, err := (&CommandJournalService{Store: store}).GetRecord(context.Background(), start.ID)
	if err != nil || view == nil || view.OutputCompleteness != commandjournal.OutputCompletenessIncomplete {
		t.Fatalf("incomplete output was reported complete: %#v err=%v", view, err)
	}
}

func ptrTime(value time.Time) *time.Time { return &value }
