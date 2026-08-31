package commandjournal

import (
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

type CommandState string

const (
	StateRunning  CommandState = "running"
	StateFinished CommandState = "finished"
	StateAborted  CommandState = "aborted"
)

const (
	OutputCompletenessComplete   = "complete"
	OutputCompletenessTruncated  = "truncated"
	OutputCompletenessIncomplete = "incomplete"
	OutputCompletenessUnknown    = "unknown"
	OutputAttributionUnknown     = "unknown"
	OutputAttributionExclusive   = "exclusive"
	OutputAttributionMixed       = "mixed"
	OutputTextSafetyUnknown      = "unknown"
	OutputTextSafetyPlain        = "plain_text"
	OutputTextSafetyUnsafe       = "unsafe"
)

// OutputState describes capture finalization independently from command
// execution. A finished command may still have pending or unknown output.
type OutputState string

const (
	OutputStateOpen    OutputState = "open"
	OutputStatePending OutputState = "pending"
	OutputStateClosed  OutputState = "closed"
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
	CompletionInterrupted        CompletionReason = "interrupted"
)

type CommandRecord struct {
	ID                     string
	WaveBlockID            string
	SessionEpoch           string
	StartHookSequence      uint64
	FinishHookSequence     uint64
	Command                string
	Cwd                    string
	ExecutionMode          terminalruntime.ExecutionMode
	OutputSource           terminalruntime.OutputSource
	RuntimeHostID          string
	RuntimeRunspaceID      string
	CaptureContractVersion int
	ProtocolVersion        int
	State                  CommandState
	CompletionReason       CompletionReason
	VisibilityGeneration   uint64
	OutputTotalBytes       int64
	OutputStoredBytes      int64
	OutputTruncated        bool
	OutputCompleteness     string
	OutputAttribution      string
	OutputTextSafety       string
	OutputState            OutputState
	StartedAt              time.Time
	FinishedAt             *time.Time
	Success                *bool
	ExitCode               *int
	Output                 []byte
}

// DurableStore is the narrow persistence seam used by the in-memory journal.
// Implementations must enqueue quickly; the Journal never performs database
// work while consuming PTY output.
type DurableStore interface {
	RecordStarted(CommandRecord) error
	AppendOutput(commandID string, data []byte) error
	RecordFinished(CommandRecord) error
	RecordOutputFinalized(CommandRecord) error
	RecordAborted(CommandRecord) error
	CurrentVisibilityGeneration(blockID string) (uint64, error)
	AdvanceVisibilityGeneration(blockID string) (uint64, error)
	DeleteHistory(blockID string) (uint64, error)
	RetagRecordGeneration(commandID string, generation uint64) error
}

// MarkOutputIncomplete records a recorder gap without inventing output bytes.
// Implementations must not block the terminal path.
func (j *Journal) MarkOutputIncomplete(blockID string, droppedBytes int64) {
	if j == nil || blockID == "" {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	active := j.active[blockID]
	if active == nil {
		if id := j.pending[blockID]; id != "" {
			if record := j.completedRecordLocked(blockID, id); record != nil {
				record.OutputCompleteness = OutputCompletenessIncomplete
				record.OutputAttribution = OutputAttributionUnknown
				record.OutputTextSafety = OutputTextSafetyUnknown
				if j.durable != nil {
					_ = j.durable.RecordOutputFinalized(cloneRecord(*record))
				}
			}
		}
		return
	}
	active.OutputCompleteness = OutputCompletenessIncomplete
	active.OutputAttribution = OutputAttributionUnknown
	active.OutputTextSafety = OutputTextSafetyUnknown
}

type generationTransition struct {
	token    uint64
	activeID string
}

type Journal struct {
	mu             sync.RWMutex
	completed      map[string][]CommandRecord
	active         map[string]*CommandRecord
	pending        map[string]string
	durable        DurableStore
	generation     map[string]uint64
	outputLimit    int64
	transitions    map[string]generationTransition
	nextTransition uint64
	reconcileHook  func()
	visualAnchors  *VisualAnchorRegistry
}

func New() *Journal {
	return &Journal{completed: make(map[string][]CommandRecord), active: make(map[string]*CommandRecord), pending: make(map[string]string), generation: make(map[string]uint64), outputLimit: 10 * 1024 * 1024, transitions: make(map[string]generationTransition)}
}

func (j *Journal) SetOutputLimit(limit int64) {
	if j != nil && limit > 0 {
		j.mu.Lock()
		j.outputLimit = limit
		j.mu.Unlock()
	}
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

// SetVisualAnchorRegistry attaches the presentation-only anchor lifetime to
// this journal's clear/session boundaries.
func (j *Journal) SetVisualAnchorRegistry(registry *VisualAnchorRegistry) {
	if j == nil {
		return
	}
	j.mu.Lock()
	j.visualAnchors = registry
	j.mu.Unlock()
}

// Apply consumes one ordered runtime item. It returns true only when the item
// changes the journal state; pending interactive records may still accept
// PTY bytes until their liveness fence closes them.
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
			if active == nil && j.pending[blockID] != "" {
				if record := j.completedRecordLocked(blockID, j.pending[blockID]); record != nil {
					source := item.Source
					if source == "" || source == terminalruntime.OutputSourceUnknown {
						source = terminalruntime.OutputSourcePTY
					}
					// Interactive hosted commands remain PTY-backed after D. Their
					// delayed bytes are accepted until the normal liveness fence.
					if len(item.Output) > 0 && record.ExecutionMode == terminalruntime.ExecutionModeInteractive && record.OutputSource == terminalruntime.OutputSourcePTY && source == terminalruntime.OutputSourcePTY {
						j.appendOutputLocked(record, item.Output)
						return true
					}
					if record.OutputCompleteness == OutputCompletenessComplete {
						record.OutputCompleteness = OutputCompletenessUnknown
						record.OutputAttribution = OutputAttributionUnknown
						if j.durable != nil {
							_ = j.durable.RecordOutputFinalized(cloneRecord(*record))
						}
					}
				}
			}
			return false
		}
		source := item.Source
		if source == "" || source == terminalruntime.OutputSourceUnknown {
			source = terminalruntime.OutputSourcePTY
		}
		if active.OutputSource == terminalruntime.OutputSourceHostStructured && source != terminalruntime.OutputSourceHostStructured {
			return false
		}
		if active.OutputSource != terminalruntime.OutputSourceHostStructured && source == terminalruntime.OutputSourceHostStructured {
			return false
		}
		if active.OutputSource == "" || active.OutputSource == terminalruntime.OutputSourceUnknown {
			active.OutputSource = source
		}
		j.appendOutputLocked(active, item.Output)
		return true
	case terminalruntime.StreamIntegrationEvent:
		event := item.Event
		switch event.Kind {
		case terminalruntime.EventCommandStarted:
			if j.active[blockID] != nil || event.CommandID == "" || event.SessionEpoch == "" || event.HookSequence == 0 {
				return false
			}
			// A valid new command is a liveness fence for a previous execution
			// whose output attribution was never proven. Malformed events must
			// not change that pending state.
			j.finalizePendingLocked(blockID)
			generation := j.generation[blockID]
			mode := event.ExecutionMode
			if mode == "" {
				mode = terminalruntime.ExecutionModeUnknown
			}
			source := event.OutputSource
			if source == "" {
				source = terminalruntime.OutputSourceUnknown
			}
			j.active[blockID] = &CommandRecord{
				ID:                     event.CommandID,
				WaveBlockID:            blockID,
				SessionEpoch:           event.SessionEpoch,
				StartHookSequence:      event.HookSequence,
				Command:                event.Command,
				Cwd:                    event.Cwd,
				ExecutionMode:          mode,
				OutputSource:           source,
				RuntimeHostID:          event.RuntimeHostID,
				RuntimeRunspaceID:      event.RuntimeRunspaceID,
				CaptureContractVersion: event.CaptureContractVersion,
				ProtocolVersion:        event.ProtocolVersion,
				State:                  StateRunning,
				VisibilityGeneration:   generation,
				StartedAt:              observedAt,
				OutputCompleteness:     OutputCompletenessUnknown,
				OutputAttribution:      OutputAttributionUnknown,
				OutputTextSafety:       OutputTextSafetyUnknown,
				OutputState:            OutputStateOpen,
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
			if active.ExecutionMode == terminalruntime.ExecutionModeStructured && active.OutputSource == terminalruntime.OutputSourceHostStructured && active.OutputTotalBytes == 0 {
				active.OutputTextSafety = OutputTextSafetyPlain
			}
			active.State = StateFinished
			if event.Interrupted {
				active.CompletionReason = CompletionInterrupted
			} else {
				active.CompletionReason = CompletionNormal
			}
			if active.ExecutionMode == terminalruntime.ExecutionModeStructured && active.OutputSource == terminalruntime.OutputSourceHostStructured {
				active.OutputState = OutputStateClosed
				if event.Interrupted {
					active.OutputCompleteness = OutputCompletenessUnknown
					active.OutputAttribution = OutputAttributionUnknown
					active.OutputTextSafety = OutputTextSafetyUnknown
				} else if active.OutputCompleteness != OutputCompletenessIncomplete && !active.OutputTruncated {
					active.OutputCompleteness = OutputCompletenessComplete
					active.OutputAttribution = OutputAttributionExclusive
				}
			} else if active.ExecutionMode == terminalruntime.ExecutionModeInteractive {
				// D completes execution only. Interactive output remains PTY-backed
				// and can arrive until the existing liveness fence closes pending.
				active.OutputState = OutputStatePending
				if active.OutputCompleteness == "" {
					active.OutputCompleteness = OutputCompletenessUnknown
				}
				active.OutputAttribution = OutputAttributionUnknown
			} else {
				active.OutputState = OutputStatePending
			}
			completed := cloneRecord(*active)
			j.completed[blockID] = append(j.completed[blockID], completed)
			if completed.OutputState == OutputStatePending {
				j.pending[blockID] = active.ID
			} else {
				delete(j.pending, blockID)
			}
			delete(j.active, blockID)
			if j.durable != nil {
				_ = j.durable.RecordFinished(completed)
				if completed.OutputState == OutputStateClosed {
					_ = j.durable.RecordOutputFinalized(completed)
				}
			}
			return true
		case terminalruntime.EventCommandAborted:
			return j.abortActiveLocked(blockID, CompletionReason(event.CompletionReason), observedAt, event.CommandID, event.SessionEpoch)
		case terminalruntime.EventPromptReady:
			// For a finished execution P is only a liveness fence; it is not
			// proof that PTY output was drained.
			return j.finalizePendingLocked(blockID)
		}
	}
	return false
}

func (j *Journal) appendOutputLocked(record *CommandRecord, output []byte) {
	if record == nil || len(output) == 0 {
		return
	}
	record.OutputTotalBytes += int64(len(output))
	stored := int64(len(output))
	limit := j.outputLimit
	if limited, ok := j.durable.(interface{ MaxOutputBytes() int64 }); ok {
		limit = limited.MaxOutputBytes()
	}
	remaining := limit - record.OutputStoredBytes
	if remaining < stored {
		stored = remaining
	}
	if stored < 0 {
		stored = 0
	}
	if stored > 0 {
		record.Output = append(record.Output, output[:stored]...)
	}
	if record.OutputSource == terminalruntime.OutputSourceHostStructured {
		if record.OutputTextSafety != OutputTextSafetyUnsafe && plainTextOutput(output) {
			record.OutputTextSafety = OutputTextSafetyPlain
		} else if !plainTextOutput(output) {
			record.OutputTextSafety = OutputTextSafetyUnsafe
		}
	}
	record.OutputStoredBytes += stored
	record.OutputTruncated = record.OutputStoredBytes < record.OutputTotalBytes
	if record.OutputCompleteness != OutputCompletenessIncomplete && record.OutputTruncated {
		record.OutputCompleteness = OutputCompletenessTruncated
	}
	if j.durable != nil {
		if err := j.durable.AppendOutput(record.ID, output); err != nil {
			record.OutputCompleteness = OutputCompletenessIncomplete
			record.OutputAttribution = OutputAttributionUnknown
			record.OutputTextSafety = OutputTextSafetyUnknown
		}
	}
}

func plainTextOutput(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	for _, r := range string(data) {
		if (r < 0x20 && r != '\r' && r != '\n' && r != '\t') || (r >= 0x80 && r <= 0x9f) || r == 0x7f || r == 0x1b {
			return false
		}
	}
	return true
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
	j.finalizePendingLocked(blockID)
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
	active.OutputState = OutputStateClosed
	if active.OutputCompleteness == OutputCompletenessComplete {
		active.OutputCompleteness = OutputCompletenessUnknown
	}
	active.OutputAttribution = OutputAttributionUnknown
	completed := cloneRecord(*active)
	j.completed[blockID] = append(j.completed[blockID], completed)
	delete(j.active, blockID)
	if j.durable != nil {
		_ = j.durable.RecordAborted(completed)
	}
	return true
}

// finalizePendingLocked closes an execution-finished record without claiming
// that its bytes were physically drained or exclusively attributable.
func (j *Journal) finalizePendingLocked(blockID string) bool {
	id := j.pending[blockID]
	if id == "" {
		return false
	}
	record := j.completedRecordLocked(blockID, id)
	delete(j.pending, blockID)
	if record == nil {
		return false
	}
	record.OutputState = OutputStateClosed
	if record.OutputCompleteness == "" || record.OutputCompleteness == OutputCompletenessComplete {
		record.OutputCompleteness = OutputCompletenessUnknown
	}
	record.OutputAttribution = OutputAttributionUnknown
	if j.durable != nil {
		_ = j.durable.RecordOutputFinalized(cloneRecord(*record))
	}
	return true
}

func (j *Journal) completedRecordLocked(blockID, id string) *CommandRecord {
	records := j.completed[blockID]
	for i := len(records) - 1; i >= 0; i-- {
		if records[i].ID == id {
			return &records[i]
		}
	}
	return nil
}

// ClearVisualHistory advances the durable visibility generation without
// changing the shell, PTY, decoder, or command identity.
func (j *Journal) ClearVisualHistory(blockID string) (uint64, error) {
	if j == nil || blockID == "" {
		return 0, nil
	}
	j.mu.RLock()
	durable := j.durable
	activeID := ""
	if active := j.active[blockID]; active != nil {
		activeID = active.ID
	}
	j.mu.RUnlock()
	if durable == nil {
		j.mu.Lock()
		generation := j.generation[blockID] + 1
		j.generation[blockID] = generation
		if active := j.active[blockID]; active != nil {
			active.VisibilityGeneration = generation
		}
		anchors := j.visualAnchors
		j.mu.Unlock()
		if anchors != nil {
			anchors.Invalidate()
		}
		return generation, nil
	}
	j.mu.Lock()
	j.nextTransition++
	transition := generationTransition{token: j.nextTransition, activeID: activeID}
	j.transitions[blockID] = transition
	j.mu.Unlock()
	generation, err := durable.AdvanceVisibilityGeneration(blockID)
	if err != nil {
		j.mu.Lock()
		if j.transitions[blockID].token == transition.token {
			delete(j.transitions, blockID)
		}
		j.mu.Unlock()
		return 0, err
	}
	if j.reconcileHook != nil {
		j.reconcileHook()
	}
	j.mu.Lock()
	if generation > j.generation[blockID] {
		j.generation[blockID] = generation
	}
	if active := j.active[blockID]; active != nil {
		active.VisibilityGeneration = j.generation[blockID]
	}
	for i := range j.completed[blockID] {
		if j.completed[blockID][i].ID == transition.activeID {
			j.completed[blockID][i].VisibilityGeneration = j.generation[blockID]
		}
	}
	if j.transitions[blockID].token == transition.token {
		delete(j.transitions, blockID)
	}
	result := j.generation[blockID]
	anchors := j.visualAnchors
	j.mu.Unlock()
	if anchors != nil {
		anchors.Invalidate()
	}
	if transition.activeID != "" {
		if err := durable.RetagRecordGeneration(transition.activeID, result); err != nil {
			return 0, err
		}
	}
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
	activeID := ""
	if active := j.active[blockID]; active != nil {
		activeID = active.ID
	}
	j.mu.RUnlock()
	var transition generationTransition
	if durable != nil {
		j.mu.Lock()
		j.nextTransition++
		transition = generationTransition{token: j.nextTransition, activeID: activeID}
		j.transitions[blockID] = transition
		j.mu.Unlock()
		generation, err := durable.DeleteHistory(blockID)
		if err != nil {
			j.mu.Lock()
			if j.transitions[blockID].token == transition.token {
				delete(j.transitions, blockID)
			}
			j.mu.Unlock()
			return err
		}
		if j.reconcileHook != nil {
			j.reconcileHook()
		}
		j.mu.Lock()
		if generation > j.generation[blockID] {
			j.generation[blockID] = generation
		}
	} else {
		j.mu.Lock()
		j.generation[blockID]++
	}
	if durable != nil {
		preserved := j.completed[blockID][:0]
		for _, record := range j.completed[blockID] {
			if record.ID == activeID {
				record.VisibilityGeneration = j.generation[blockID]
				preserved = append(preserved, record)
			}
		}
		j.completed[blockID] = preserved
		if j.transitions[blockID].token == transition.token {
			delete(j.transitions, blockID)
		}
	} else {
		j.completed[blockID] = nil
	}
	if active := j.active[blockID]; active != nil {
		active.VisibilityGeneration = j.generation[blockID]
	}
	resultGeneration := j.generation[blockID]
	anchors := j.visualAnchors
	j.mu.Unlock()
	if anchors != nil {
		anchors.Invalidate()
	}
	if durable != nil && activeID != "" {
		if err := durable.RetagRecordGeneration(activeID, resultGeneration); err != nil {
			return err
		}
	}
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
