// SPDX-License-Identifier: Apache-2.0

package commandjournalservice

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/commandjournal/persistence"
	"github.com/wavetermdev/waveterm/pkg/tsgen/tsgenmeta"
)

type RecordView struct {
	ID                     string `json:"id"`
	WaveBlockID            string `json:"wave_block_id"`
	SessionEpoch           string `json:"session_epoch"`
	StartHookSequence      uint64 `json:"start_hook_sequence"`
	FinishHookSequence     uint64 `json:"finish_hook_sequence"`
	Command                string `json:"command"`
	Cwd                    string `json:"cwd"`
	ExecutionMode          string `json:"execution_mode"`
	OutputSource           string `json:"output_source"`
	RuntimeHostID          string `json:"runtime_host_id"`
	RuntimeRunspaceID      string `json:"runtime_runspace_id"`
	CaptureContractVersion int    `json:"capture_contract_version"`
	ProtocolVersion        int    `json:"protocol_version"`
	State                  string `json:"state"`
	CompletionReason       string `json:"completion_reason"`
	VisibilityGeneration   uint64 `json:"visibility_generation"`
	OutputTotalBytes       int64  `json:"output_total_bytes"`
	OutputStoredBytes      int64  `json:"output_stored_bytes"`
	OutputTruncated        bool   `json:"output_truncated"`
	OutputCompleteness     string `json:"output_completeness"`
	OutputAttribution      string `json:"output_attribution"`
	OutputTextSafety       string `json:"output_text_safety"`
	OutputState            string `json:"output_state"`
	StartedAtUnixMs        int64  `json:"started_at_unix_ms"`
	FinishedAtUnixMs       *int64 `json:"finished_at_unix_ms,omitempty"`
	Success                *bool  `json:"success,omitempty"`
	ExitCode               *int   `json:"exit_code,omitempty"`
}

type OutputView struct {
	Data         []byte `json:"data"`
	TotalBytes   int64  `json:"total_bytes"`
	StoredBytes  int64  `json:"stored_bytes"`
	Truncated    bool   `json:"truncated"`
	Completeness string `json:"completeness"`
	Attribution  string `json:"attribution"`
	TextSafety   string `json:"text_safety"`
	State        string `json:"output_state"`
}

type HealthView struct {
	Status             string `json:"status"`
	OutputComplete     bool   `json:"output_complete"`
	DroppedOutputBytes int64  `json:"dropped_output_bytes"`
	Error              string `json:"error,omitempty"`
}

type GenerationView struct {
	Generation uint64 `json:"generation"`
}

type CommandJournalService struct {
	Store *persistence.Store
}

var CommandJournalServiceInstance = &CommandJournalService{}

func (s *CommandJournalService) store() (*persistence.Store, error) {
	if s != nil && s.Store != nil {
		return s.Store, nil
	}
	return persistence.Default()
}

func (*CommandJournalService) ListVisibleRecords_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{Desc: "read visible command records for a terminal block", ArgNames: []string{"ctx", "blockId"}}
}

func (s *CommandJournalService) ListVisibleRecords(ctx context.Context, blockId string) ([]RecordView, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	if store == nil || !store.Enabled() {
		return []RecordView{}, nil
	}
	if err := store.Flush(); err != nil {
		return nil, err
	}
	records, err := store.ReadVisibleRecords(blockId)
	if err != nil {
		return nil, err
	}
	result := make([]RecordView, 0, len(records))
	for _, record := range records {
		result = append(result, recordView(record))
	}
	return result, nil
}

func (*CommandJournalService) GetRecord_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{Desc: "read one command record by id", ArgNames: []string{"ctx", "commandId"}}
}

func (s *CommandJournalService) GetRecord(ctx context.Context, commandId string) (*RecordView, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	if store == nil || !store.Enabled() {
		return nil, nil
	}
	if err := store.Flush(); err != nil {
		return nil, err
	}
	record, err := store.ReadRecord(commandId)
	if err != nil || record == nil {
		return nil, err
	}
	view := recordView(*record)
	return &view, nil
}

func (*CommandJournalService) GetOutput_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{Desc: "read raw captured output and completeness metadata", ArgNames: []string{"ctx", "commandId"}}
}

func (s *CommandJournalService) GetOutput(ctx context.Context, commandId string) (*OutputView, error) {
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	if store == nil || !store.Enabled() {
		return nil, nil
	}
	if err := store.Flush(); err != nil {
		return nil, err
	}
	output, err := store.ReadOutputWithMetadata(commandId)
	if err != nil || output == nil {
		return nil, err
	}
	return &OutputView{Data: output.Data, TotalBytes: output.TotalBytes, StoredBytes: output.StoredBytes, Truncated: output.Truncated, Completeness: output.Completeness, Attribution: output.Attribution, TextSafety: output.TextSafety, State: output.State}, nil
}

func (*CommandJournalService) GetHealth_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{Desc: "read command journal persistence health", ArgNames: []string{"ctx"}}
}

func (s *CommandJournalService) GetHealth(ctx context.Context) (*HealthView, error) {
	store, err := s.store()
	if err != nil {
		return &HealthView{Status: string(persistence.HealthUnavailable), OutputComplete: false, Error: err.Error()}, nil
	}
	if store == nil {
		return &HealthView{Status: string(persistence.HealthUnavailable), OutputComplete: false}, nil
	}
	health := store.Health()
	return &HealthView{Status: string(health.Status), OutputComplete: health.OutputComplete, DroppedOutputBytes: health.DroppedOutputBytes, Error: health.Error}, nil
}

func (*CommandJournalService) ClearVisualHistory_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{Desc: "advance visible command history without restarting the terminal session", ArgNames: []string{"ctx", "blockId"}}
}

func (s *CommandJournalService) ClearVisualHistory(ctx context.Context, blockId string) (*GenerationView, error) {
	if blockId == "" {
		return nil, fmt.Errorf("block id is required")
	}
	if journal := blockcontroller.GetCommandJournal(blockId); journal != nil {
		generation, err := journal.ClearVisualHistory(blockId)
		return &GenerationView{Generation: generation}, err
	}
	store, err := s.store()
	if err != nil {
		return nil, err
	}
	generation, err := store.AdvanceVisibilityGeneration(blockId)
	return &GenerationView{Generation: generation}, err
}

func (*CommandJournalService) DeleteHistory_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{Desc: "delete completed command history without restarting the terminal session", ArgNames: []string{"ctx", "blockId"}}
}

func (s *CommandJournalService) DeleteHistory(ctx context.Context, blockId string) error {
	if blockId == "" {
		return fmt.Errorf("block id is required")
	}
	if journal := blockcontroller.GetCommandJournal(blockId); journal != nil {
		return journal.DeleteHistory(blockId)
	}
	store, err := s.store()
	if err != nil {
		return err
	}
	_, err = store.DeleteHistory(blockId)
	return err
}

func recordView(record commandjournal.CommandRecord) RecordView {
	view := RecordView{ID: record.ID, WaveBlockID: record.WaveBlockID, SessionEpoch: record.SessionEpoch, StartHookSequence: record.StartHookSequence, FinishHookSequence: record.FinishHookSequence, Command: record.Command, Cwd: record.Cwd, ExecutionMode: string(record.ExecutionMode), OutputSource: string(record.OutputSource), RuntimeHostID: record.RuntimeHostID, RuntimeRunspaceID: record.RuntimeRunspaceID, CaptureContractVersion: record.CaptureContractVersion, ProtocolVersion: record.ProtocolVersion, State: string(record.State), CompletionReason: string(record.CompletionReason), VisibilityGeneration: record.VisibilityGeneration, OutputTotalBytes: record.OutputTotalBytes, OutputStoredBytes: record.OutputStoredBytes, OutputTruncated: record.OutputTruncated, OutputCompleteness: record.OutputCompleteness, OutputAttribution: record.OutputAttribution, OutputTextSafety: record.OutputTextSafety, OutputState: string(record.OutputState), StartedAtUnixMs: record.StartedAt.UnixMilli(), Success: record.Success, ExitCode: record.ExitCode}
	if record.FinishedAt != nil {
		finished := record.FinishedAt.UnixMilli()
		view.FinishedAtUnixMs = &finished
	}
	return view
}
