package commandjournal

import (
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

type CommandState string

const (
	StateRunning  CommandState = "running"
	StateFinished CommandState = "finished"
	StateAborted  CommandState = "aborted"
)

type CompletionReason string

const (
	CompletionNormal         CompletionReason = "normal"
	CompletionMissingFinish  CompletionReason = "missing_finish"
	CompletionSuperseded     CompletionReason = "superseded"
	CompletionSessionEnded   CompletionReason = "session_ended"
	CompletionControllerStop CompletionReason = "controller_stop"
	CompletionPTYError       CompletionReason = "pty_error"
	CompletionEpochChanged   CompletionReason = "epoch_changed"
)

type CommandRecord struct {
	ID                 string
	WaveBlockID        string
	SessionEpoch       string
	StartHookSequence  uint64
	FinishHookSequence uint64
	Command            string
	Cwd                string
	State              CommandState
	CompletionReason   CompletionReason
	StartedAt          time.Time
	FinishedAt         *time.Time
	Success            *bool
	ExitCode           *int
	Output             []byte
}

type Journal struct {
	mu        sync.RWMutex
	completed map[string][]CommandRecord
	active    map[string]*CommandRecord
}

func New() *Journal {
	return &Journal{completed: make(map[string][]CommandRecord), active: make(map[string]*CommandRecord)}
}

// Apply consumes one ordered runtime item. It returns true only when the item
// changes the journal state; output outside an active command is ignored.
func (j *Journal) Apply(blockID string, item terminalruntime.StreamItem, observedAt time.Time) bool {
	if j == nil || blockID == "" {
		return false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if observedAt.IsZero() {
		observedAt = time.Now()
	}
	switch item.Kind {
	case terminalruntime.StreamOutputSegment:
		active := j.active[blockID]
		if active == nil || len(item.Output) == 0 {
			return false
		}
		active.Output = append(active.Output, item.Output...)
		return true
	case terminalruntime.StreamIntegrationEvent:
		event := item.Event
		switch event.Kind {
		case terminalruntime.EventCommandStarted:
			if j.active[blockID] != nil || event.CommandID == "" || event.SessionEpoch == "" || event.HookSequence == 0 {
				return false
			}
			j.active[blockID] = &CommandRecord{
				ID:                event.CommandID,
				WaveBlockID:       blockID,
				SessionEpoch:      event.SessionEpoch,
				StartHookSequence: event.HookSequence,
				Command:           event.Command,
				Cwd:               event.Cwd,
				State:             StateRunning,
				StartedAt:         observedAt,
			}
			return true
		case terminalruntime.EventCommandFinished:
			active := j.active[blockID]
			if active == nil || event.CommandID != active.ID || event.SessionEpoch != active.SessionEpoch || event.HookSequence == 0 || event.Success == nil || event.ExitCode == nil {
				return false
			}
			finishedAt := observedAt
			active.FinishHookSequence = event.HookSequence
			active.FinishedAt = &finishedAt
			active.Success = cloneBool(event.Success)
			active.ExitCode = cloneInt(event.ExitCode)
			active.State = StateFinished
			active.CompletionReason = CompletionNormal
			completed := cloneRecord(*active)
			j.completed[blockID] = append(j.completed[blockID], completed)
			delete(j.active, blockID)
			return true
		case terminalruntime.EventCommandAborted:
			return j.abortActiveLocked(blockID, CompletionReason(event.CompletionReason), observedAt, event.CommandID, event.SessionEpoch)
		case terminalruntime.EventPromptReady:
			// Decoder emits the explicit missing_finish abort before P. Keep this
			// event itself side-effect free so a duplicate P cannot abort twice.
			return false
		}
	}
	return false
}

// AbortActive closes the current record without inventing a finish result.
// It is idempotent and only affects the active record for blockID.
func (j *Journal) AbortActive(blockID string, reason CompletionReason, observedAt time.Time) bool {
	if j == nil || blockID == "" || !validAbortReason(reason) {
		return false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.abortActiveLocked(blockID, reason, observedAt, "", "")
}

func (j *Journal) abortActiveLocked(blockID string, reason CompletionReason, observedAt time.Time, commandID, epoch string) bool {
	active := j.active[blockID]
	if active == nil || !validAbortReason(reason) || (commandID != "" && active.ID != commandID) || (epoch != "" && active.SessionEpoch != epoch) {
		return false
	}
	if observedAt.IsZero() {
		observedAt = time.Now()
	}
	active.State = StateAborted
	active.CompletionReason = reason
	active.Success = nil
	active.ExitCode = nil
	active.FinishHookSequence = 0
	finishedAt := observedAt
	active.FinishedAt = &finishedAt
	completed := cloneRecord(*active)
	j.completed[blockID] = append(j.completed[blockID], completed)
	delete(j.active, blockID)
	return true
}

func validAbortReason(reason CompletionReason) bool {
	switch reason {
	case CompletionMissingFinish, CompletionSuperseded, CompletionSessionEnded, CompletionControllerStop, CompletionPTYError, CompletionEpochChanged:
		return true
	default:
		return false
	}
}

func (j *Journal) Snapshot(blockID string) []CommandRecord {
	if j == nil {
		return nil
	}
	j.mu.RLock()
	defer j.mu.RUnlock()
	if len(j.completed[blockID]) == 0 {
		return nil
	}
	result := make([]CommandRecord, len(j.completed[blockID]))
	for i, record := range j.completed[blockID] {
		result[i] = cloneRecord(record)
	}
	return result
}

func (j *Journal) Active(blockID string) (CommandRecord, bool) {
	if j == nil {
		return CommandRecord{}, false
	}
	j.mu.RLock()
	defer j.mu.RUnlock()
	record, ok := j.active[blockID]
	if !ok {
		return CommandRecord{}, false
	}
	return cloneRecord(*record), true
}

func cloneRecord(record CommandRecord) CommandRecord {
	record.Output = append([]byte(nil), record.Output...)
	if record.Success != nil {
		record.Success = cloneBool(record.Success)
	}
	if record.ExitCode != nil {
		record.ExitCode = cloneInt(record.ExitCode)
	}
	if record.FinishedAt != nil {
		finishedAt := *record.FinishedAt
		record.FinishedAt = &finishedAt
	}
	return record
}

func cloneBool(value *bool) *bool {
	copy := *value
	return &copy
}

func cloneInt(value *int) *int {
	copy := *value
	return &copy
}
