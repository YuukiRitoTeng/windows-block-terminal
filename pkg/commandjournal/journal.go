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
	CompletionNormal             CompletionReason = "normal"
	CompletionMissingFinish      CompletionReason = "missing_finish"
	CompletionSuperseded         CompletionReason = "superseded"
	CompletionSessionEnded       CompletionReason = "session_ended"
	CompletionControllerStop     CompletionReason = "controller_stop"
	CompletionPTYError           CompletionReason = "pty_error"
	CompletionEpochChanged       CompletionReason = "epoch_changed"
	CompletionAppRestartRecovery CompletionReason = "app_restart_recovery"
)

type CommandRecord struct {
	ID                   string
	WaveBlockID          string
	SessionEpoch         string
	StartHookSequence    uint64
	FinishHookSequence   uint64
	Command              string
	Cwd                  string
	State                CommandState
	CompletionReason     CompletionReason
	VisibilityGeneration uint64
	OutputTotalBytes     int64
	OutputStoredBytes    int64
	OutputTruncated      bool
	StartedAt            time.Time
	FinishedAt           *time.Time
	Success              *bool
	ExitCode             *int
	Output               []byte
}

// DurableStore is the narrow persistence seam used by the in-memory journal.
// Implementations must enqueue quickly; the Journal never performs database
// work while consuming PTY output.
type DurableStore interface {
	RecordStarted(CommandRecord) error
	AppendOutput(commandID string, data []byte) error
	RecordFinished(CommandRecord) error
	RecordAborted(CommandRecord) error
	CurrentVisibilityGeneration(blockID string) (uint64, error)
	AdvanceVisibilityGeneration(blockID string) (uint64, error)
	DeleteHistory(blockID string) (uint64, error)
}

type Journal struct {
	mu         sync.RWMutex
	completed  map[string][]CommandRecord
	active     map[string]*CommandRecord
	durable    DurableStore
	generation map[string]uint64
}

func New() *Journal {
	return &Journal{completed: make(map[string][]CommandRecord), active: make(map[string]*CommandRecord), generation: make(map[string]uint64)}
}

func (j *Journal) SetDurableStore(store DurableStore) {
	if j == nil {
		return
	}
	j.mu.Lock()
	j.durable = store
	j.mu.Unlock()
}

func (j *Journal) SetVisibilityGeneration(blockID string, generation uint64) {
	if j == nil || blockID == "" {
		return
	}
	j.mu.Lock()
	j.generation[blockID] = generation
	j.mu.Unlock()
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
		active.OutputTotalBytes += int64(len(item.Output))
		stored := int64(len(item.Output))
		if limited, ok := j.durable.(interface{ MaxOutputBytes() int64 }); ok {
			remaining := limited.MaxOutputBytes() - active.OutputStoredBytes
			if remaining < stored {
				stored = remaining
			}
			if stored < 0 {
				stored = 0
			}
		}
		active.OutputStoredBytes += stored
		active.OutputTruncated = active.OutputStoredBytes < active.OutputTotalBytes
		if j.durable != nil {
			_ = j.durable.AppendOutput(active.ID, item.Output)
		}
		return true
	case terminalruntime.StreamIntegrationEvent:
		event := item.Event
		switch event.Kind {
		case terminalruntime.EventCommandStarted:
			if j.active[blockID] != nil || event.CommandID == "" || event.SessionEpoch == "" || event.HookSequence == 0 {
				return false
			}
			generation := j.generation[blockID]
			j.active[blockID] = &CommandRecord{
				ID:                   event.CommandID,
				WaveBlockID:          blockID,
				SessionEpoch:         event.SessionEpoch,
				StartHookSequence:    event.HookSequence,
				Command:              event.Command,
				Cwd:                  event.Cwd,
				State:                StateRunning,
				VisibilityGeneration: generation,
				StartedAt:            observedAt,
			}
			if j.durable != nil {
				_ = j.durable.RecordStarted(*j.active[blockID])
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
			if j.durable != nil {
				_ = j.durable.RecordFinished(completed)
			}
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
	if j.durable != nil {
		_ = j.durable.RecordAborted(completed)
	}
	return true
}

// ClearVisualHistory advances the durable visibility generation without
// changing the shell, PTY, decoder, or command identity.
func (j *Journal) ClearVisualHistory(blockID string) (uint64, error) {
	if j == nil || blockID == "" {
		return 0, nil
	}
	j.mu.RLock()
	durable := j.durable
	j.mu.RUnlock()
	if durable == nil {
		j.mu.Lock()
		generation := j.generation[blockID] + 1
		j.generation[blockID] = generation
		if active := j.active[blockID]; active != nil {
			active.VisibilityGeneration = generation
		}
		j.mu.Unlock()
		return generation, nil
	}
	generation, err := durable.AdvanceVisibilityGeneration(blockID)
	if err != nil {
		return 0, err
	}
	j.mu.Lock()
	if generation > j.generation[blockID] {
		j.generation[blockID] = generation
	}
	if active := j.active[blockID]; active != nil {
		active.VisibilityGeneration = j.generation[blockID]
	}
	result := j.generation[blockID]
	j.mu.Unlock()
	return result, nil
}

// DeleteHistory physically removes completed history while preserving an
// active record by moving it to the new generation.
func (j *Journal) DeleteHistory(blockID string) error {
	if j == nil || blockID == "" {
		return nil
	}
	j.mu.RLock()
	durable := j.durable
	j.mu.RUnlock()
	if durable != nil {
		generation, err := durable.DeleteHistory(blockID)
		if err != nil {
			return err
		}
		j.mu.Lock()
		if generation > j.generation[blockID] {
			j.generation[blockID] = generation
		}
	} else {
		j.mu.Lock()
		j.generation[blockID]++
	}
	j.completed[blockID] = nil
	if active := j.active[blockID]; active != nil {
		active.VisibilityGeneration = j.generation[blockID]
	}
	j.mu.Unlock()
	return nil
}

func (j *Journal) VisibleSnapshot(blockID string) []CommandRecord {
	if j == nil {
		return nil
	}
	j.mu.RLock()
	defer j.mu.RUnlock()
	generation := j.generation[blockID]
	result := make([]CommandRecord, 0, len(j.completed[blockID]))
	for _, record := range j.completed[blockID] {
		if record.VisibilityGeneration == generation {
			result = append(result, cloneRecord(record))
		}
	}
	return result
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
