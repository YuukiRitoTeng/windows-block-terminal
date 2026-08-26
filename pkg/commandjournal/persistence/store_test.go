package persistence

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func testRecord() commandjournal.CommandRecord {
	return commandjournal.CommandRecord{ID: "c1", WaveBlockID: "b1", SessionEpoch: "e1", StartHookSequence: 1, Command: "echo hi", Cwd: "C:\\", State: commandjournal.StateRunning, StartedAt: time.UnixMilli(1000)}
}

func ptrTime(value time.Time) *time.Time { return &value }

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

func TestPendingOutputStateSurvivesRestart(t *testing.T) {
	s, path := openTest(t, Options{Enabled: true})
	r := testRecord()
	r.ExecutionMode = terminalruntime.ExecutionModeInteractive
	r.OutputSource = terminalruntime.OutputSourcePTY
	r.RuntimeHostID = "host-1"
	r.RuntimeRunspaceID = "runspace-1"
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOutput(r.ID, []byte("prefix")); err != nil {
		t.Fatal(err)
	}
	ok := true
	code := 0
	finishedAt := time.UnixMilli(2000)
	r.State = commandjournal.StateFinished
	r.CompletionReason = commandjournal.CompletionNormal
	r.Success = &ok
	r.ExitCode = &code
	r.FinishedAt = &finishedAt
	r.FinishHookSequence = 2
	r.OutputTotalBytes = 6
	r.OutputStoredBytes = 6
	r.OutputCompleteness = commandjournal.OutputCompletenessUnknown
	r.OutputAttribution = commandjournal.OutputAttributionUnknown
	r.OutputState = commandjournal.OutputStatePending
	if err := s.RecordFinished(r); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	record, err := s.ReadRecord(r.ID)
	if err != nil || record == nil {
		t.Fatalf("record=%#v err=%v", record, err)
	}
	if record.State != commandjournal.StateFinished || record.OutputState != commandjournal.OutputStateClosed || record.OutputCompleteness == commandjournal.OutputCompletenessComplete || record.OutputAttribution == commandjournal.OutputAttributionExclusive {
		t.Fatalf("restart overclaimed pending output: %#v", record)
	}
	if record.ExecutionMode != terminalruntime.ExecutionModeInteractive || record.OutputSource != terminalruntime.OutputSourcePTY || record.RuntimeHostID != "host-1" || record.RuntimeRunspaceID != "runspace-1" {
		t.Fatalf("restart lost interactive provenance: %#v", record)
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
	if err := s.Close(); !errors.Is(err, ErrOutputQueueOverflow) {
		t.Fatalf("close error=%v", err)
	}
}

func TestProvenanceRoundTrip(t *testing.T) {
	s, path := openTest(t, Options{Enabled: true})
	r := testRecord()
	r.ExecutionMode = terminalruntime.ExecutionModeStructured
	r.OutputSource = terminalruntime.OutputSourceHostStructured
	r.RuntimeHostID = "host-1"
	r.RuntimeRunspaceID = "runspace-1"
	r.CaptureContractVersion = 1
	r.ProtocolVersion = 1
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOutput(r.ID, []byte("structured\r\n")); err != nil {
		t.Fatal(err)
	}
	ok, code := true, 0
	finished := r
	finished.State = commandjournal.StateFinished
	finished.CompletionReason = commandjournal.CompletionNormal
	finished.Success = &ok
	finished.ExitCode = &code
	finished.FinishedAt = ptrTime(time.UnixMilli(2))
	finished.FinishHookSequence = 2
	finished.OutputTotalBytes = 12
	finished.OutputStoredBytes = 12
	finished.OutputCompleteness = commandjournal.OutputCompletenessComplete
	finished.OutputAttribution = commandjournal.OutputAttributionExclusive
	finished.OutputState = commandjournal.OutputStateClosed
	if err := s.RecordFinished(finished); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	record, err := s.ReadRecord(r.ID)
	if err != nil || record == nil {
		t.Fatalf("record=%#v err=%v", record, err)
	}
	if record.ExecutionMode != r.ExecutionMode || record.OutputSource != r.OutputSource || record.RuntimeHostID != r.RuntimeHostID || record.RuntimeRunspaceID != r.RuntimeRunspaceID || record.CaptureContractVersion != 1 || record.ProtocolVersion != 1 {
		t.Fatalf("provenance was not preserved: %#v", record)
	}
}

func TestMetadataChunkMismatchDowngradesGuarantee(t *testing.T) {
	s, _ := openTest(t, Options{Enabled: true})
	r := testRecord()
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOutput(r.ID, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DELETE FROM command_output_chunks WHERE command_id=?`, r.ID); err != nil {
		t.Fatal(err)
	}
	ok, code := true, 0
	r.State = commandjournal.StateFinished
	r.CompletionReason = commandjournal.CompletionNormal
	r.Success = &ok
	r.ExitCode = &code
	r.FinishedAt = ptrTime(time.UnixMilli(2))
	r.FinishHookSequence = 2
	r.OutputTotalBytes = 3
	r.OutputStoredBytes = 3
	r.OutputCompleteness = commandjournal.OutputCompletenessComplete
	r.OutputAttribution = commandjournal.OutputAttributionExclusive
	r.OutputState = commandjournal.OutputStateClosed
	if err := s.RecordFinished(r); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	record, err := s.ReadRecord(r.ID)
	if err != nil || record == nil || record.OutputCompleteness != commandjournal.OutputCompletenessIncomplete || record.OutputAttribution == commandjournal.OutputAttributionExclusive {
		t.Fatalf("mismatch retained trusted metadata: %#v err=%v", record, err)
	}
	_ = s.Close()
}

func TestLegacyMigrationDoesNotInferHostedAuthority(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "legacy.sqlite")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"000001_init.up.sql", "000002_output_contract.up.sql", "000003_output_state.up.sql"} {
		data, err := os.ReadFile(filepath.Join("migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(data)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`CREATE TABLE schema_migrations (version INTEGER NOT NULL PRIMARY KEY, dirty BOOLEAN NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO schema_migrations(version,dirty) VALUES(3,0)`); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO command_records (id,wave_block_id,session_epoch,protocol_version,start_hook_sequence,command,cwd,state,completion_reason,started_at_ms,visibility_generation,output_completeness,output_attribution,output_text_safety,output_state) VALUES ('legacy','block','epoch',1,1,'echo','C:\\','finished','normal',1,0,'complete','exclusive','unknown','closed')`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	record, err := s.ReadRecord("legacy")
	if err != nil || record == nil || record.ExecutionMode != terminalruntime.ExecutionModeUnknown || record.OutputSource != terminalruntime.OutputSourceUnknown || record.CaptureContractVersion != 0 || record.OutputCompleteness == commandjournal.OutputCompletenessComplete || record.OutputAttribution == commandjournal.OutputAttributionExclusive {
		t.Fatalf("legacy record was overclaimed: %#v err=%v", record, err)
	}
}

func TestRowsAffectedFailureIsReturned(t *testing.T) {
	s, _ := openTest(t, Options{Enabled: true})
	if err := s.RetagRecordGeneration("missing", 1); !errors.Is(err, ErrRecordNotFound) {
		t.Fatalf("missing row retag error=%v", err)
	}
	if err := s.Degraded(); !errors.Is(err, ErrRecordNotFound) {
		t.Fatalf("missing row retag did not fail closed: %v", err)
	}
	_ = s.Close()
}

func TestMissingCommandEventIsCommandScoped(t *testing.T) {
	s, _ := openTest(t, Options{Enabled: true})
	missing := testRecord()
	if err := s.RecordFinished(missing); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatalf("missing command poisoned store: %v", err)
	}
	if err := s.Degraded(); err != nil {
		t.Fatalf("missing command set global degraded state: %v", err)
	}
	r := testRecord()
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
}

func TestAsyncWriterFailureCannotRemainDurablyComplete(t *testing.T) {
	s, path := openTest(t, Options{Enabled: true})
	r := testRecord()
	if err := s.RecordStarted(r); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := s.db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendOutput(r.ID, []byte("lost")); err != nil {
		t.Fatal(err)
	}
	ok, code := true, 0
	r.State = commandjournal.StateFinished
	r.CompletionReason = commandjournal.CompletionNormal
	r.Success = &ok
	r.ExitCode = &code
	r.FinishedAt = ptrTime(time.UnixMilli(2))
	r.FinishHookSequence = 2
	r.OutputTotalBytes = 4
	r.OutputStoredBytes = 4
	r.OutputCompleteness = commandjournal.OutputCompletenessComplete
	r.OutputAttribution = commandjournal.OutputAttributionExclusive
	r.OutputState = commandjournal.OutputStateClosed
	if err := s.RecordFinished(r); err != nil {
		t.Fatal(err)
	}
	if err := s.Flush(); err == nil {
		t.Fatal("flush hid async writer failure")
	}
	if err := s.Close(); err == nil {
		t.Fatal("close hid async writer failure")
	}
	reopened, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	record, err := reopened.ReadRecord(r.ID)
	if err != nil || record == nil || record.OutputCompleteness == commandjournal.OutputCompletenessComplete || record.OutputAttribution == commandjournal.OutputAttributionExclusive {
		t.Fatalf("writer failure left trusted metadata: %#v err=%v", record, err)
	}
}
