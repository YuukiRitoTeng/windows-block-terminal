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
	CompletionNormal                  CompletionReason = "normal"
	CompletionMissingFinish           CompletionReason = "missing_finish"
	CompletionSuperseded              CompletionReason = "superseded"
	CompletionSessionEnded            CompletionReason = "session_ended"
	CompletionControllerStop          CompletionReason = "controller_stop"
	CompletionPTYError                CompletionReason = "pty_error"
	CompletionEpochChanged            CompletionReason = "epoch_changed"
	CompletionAppRestartRecovery      CompletionReason = "app_restart_recovery"
	CompletionInterrupted             CompletionReason = "interrupted"
	CompletionSidechannelDisconnected CompletionReason = "sidechannel_disconnected"
)

type CommandRecord struct {
	ID                     string
	WaveBlockID            string
	SessionEpoch           string
	Authority              terminalruntime.Authority
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
	gate := j.blockGate(blockID)
	gate.Lock()
	defer gate.Unlock()
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

type Journal struct {
	mu          sync.RWMutex
	completed   map[string][]CommandRecord
	active      map[string]*CommandRecord
	pending     map[string]string
	durable     DurableStore
	generation  map[string]uint64
	outputLimit int64
	// gates linearize lifecycle application, aborts, visibility transactions and deletes per
	// block. They are held outside j.mu, which only protects the in-memory structures.
	gates   map[string]*sync.Mutex
	gatesMu sync.Mutex

	nextTransition uint64
	reconcileHook  func()
	visualAnchors  *VisualAnchorRegistry
	// authority latches the command authority of the current block session.
	// One session has exactly one authority; a start event claiming the other
	// authority for the same session is refused.
	authority map[string]authorityLatch
}

// authorityLatch remembers which producer owns command lifecycle for a session.
type authorityLatch struct {
	sessionEpoch string
	authority    terminalruntime.Authority
}

func New() *Journal {
	return &Journal{completed: make(map[string][]CommandRecord), active: make(map[string]*CommandRecord), pending: make(map[string]string), generation: make(map[string]uint64), outputLimit: 10 * 1024 * 1024, gates: make(map[string]*sync.Mutex), authority: make(map[string]authorityLatch)}
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
	gate := j.blockGate(blockID)
	gate.Lock()
	defer gate.Unlock()
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
	// Lifecycle and output mutation linearize with visibility transactions for this block.
	gate := j.blockGate(blockID)
	gate.Lock()
	defer gate.Unlock()
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
			// The authority is an explicit claim, and one session has exactly one.
			// A start claiming the other authority for a session that already
			// latched one is refused rather than merged.
			if !event.Authority.Valid() || !j.acceptAuthorityLocked(blockID, event.SessionEpoch, event.Authority) {
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
			// The output source must be one the authority may own: an in-band
			// integration can never own sidechannel bytes. The producer's claim
			// wins when it makes one, otherwise the authority's default applies.
			source := event.OutputSource
			if source == "" || source == terminalruntime.OutputSourceUnknown {
				source = event.Authority.DefaultOutputSource()
			}
			if !event.Authority.AllowsOutputSource(source) {
				return false
			}

			j.active[blockID] = &CommandRecord{
				ID:                     event.CommandID,
				WaveBlockID:            blockID,
				SessionEpoch:           event.SessionEpoch,
				Authority:              event.Authority,
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
			// Only the authority that opened the record may close it.
			if !event.Authority.Valid() || event.Authority != active.Authority {
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
			if !event.Authority.Valid() {
				return false
			}
			if active := j.active[blockID]; active != nil && active.Authority != event.Authority {
				return false
			}
			return j.abortActiveLocked(blockID, CompletionReason(event.CompletionReason), observedAt, event.CommandID, event.SessionEpoch)
		case terminalruntime.EventPromptReady:
			// A prompt is proof the shell moved on. If a command is still active
			// from the same authority - an interrupted command whose D never
			// arrived, for instance - it closes here, once, without inventing a
			// result. For a finished execution P is only a liveness fence; it is
			// not proof that PTY output was drained.
			if !event.Authority.Valid() {
				return false
			}
			closedActive := false
			if active := j.active[blockID]; active != nil && active.Authority == event.Authority && active.SessionEpoch == event.SessionEpoch && (event.HookSequence == 0 || event.HookSequence > active.StartHookSequence) {
				closedActive = j.abortActiveLocked(blockID, CompletionMissingFinish, observedAt, active.ID, active.SessionEpoch)
			}
			return j.finalizePendingLocked(blockID) || closedActive
		}
	}
	return false
}

// acceptAuthorityLocked latches the command authority of a block session.
//
// A session (identified by its SessionEpoch) has exactly one authority: the
// first accepted start claims it, and a later start claiming the other
// authority for the same session is refused. A new SessionEpoch is a new shell
// session and may legitimately use a different authority, so the latch is
// replaced rather than kept forever.
func (j *Journal) acceptAuthorityLocked(blockID string, sessionEpoch string, authority terminalruntime.Authority) bool {
	if !authority.Valid() || sessionEpoch == "" {
		return false
	}
	latch, ok := j.authority[blockID]
	if ok && latch.sessionEpoch == sessionEpoch {
		return latch.authority == authority
	}
	j.authority[blockID] = authorityLatch{sessionEpoch: sessionEpoch, authority: authority}
	return true
}

// Authority reports the latched authority for a block, if a session has claimed one.
func (j *Journal) Authority(blockID string) terminalruntime.Authority {
	if j == nil {
		return terminalruntime.AuthorityUnknown
	}
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.authority[blockID].authority
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
	gate := j.blockGate(blockID)
	gate.Lock()
	defer gate.Unlock()
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
//
// The running snapshot and the generation advance share one critical section, so an
// event applied afterwards belongs to the new generation and can never be reported as
// idle by this answer. Callers that only need the generation read .Generation.
func (j *Journal) ClearVisualHistory(blockID string) (uint64, error) {
	if j == nil || blockID == "" {
		return 0, nil
	}
	// One gate per block: a command start/finish, an abort, another Clear or a delete for the
	// same block cannot interleave with this transaction. Other blocks are unaffected.
	gate := j.blockGate(blockID)
	gate.Lock()
	defer gate.Unlock()
	j.mu.RLock()
	durable := j.durable
	activeID := ""
	if active := j.active[blockID]; active != nil {
		activeID = active.ID
	}
	j.mu.RUnlock()
	if durable == nil {
		result := j.commitVisibility(blockID, 0, activeID)
		j.invalidateAnchors()
		return result, nil
	}
	generation, err := durable.AdvanceVisibilityGeneration(blockID)
	if err != nil {
		return 0, err
	}
	if j.reconcileHook != nil {
		j.reconcileHook()
	}
	// The durable transaction is the commit point: it advanced the generation and retagged the
	// block's running rows atomically, so the memory commit below adds no failing I/O and there
	// is no window in which the durable side is half-committed.
	result := j.commitVisibility(blockID, generation, activeID)
	j.invalidateAnchors()
	return result, nil
}

// commitVisibility advances the in-memory generation and moves the records that were live
// when the transaction started into it. Records completed before the transaction keep their
// old generation, which is what hides them.
func (j *Journal) commitVisibility(blockID string, durableGeneration uint64, activeID string) uint64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	generation := j.generation[blockID] + 1
	if durableGeneration > generation {
		generation = durableGeneration
	}
	j.generation[blockID] = generation
	if active := j.active[blockID]; active != nil {
		active.VisibilityGeneration = generation
	}
	for i := range j.completed[blockID] {
		record := &j.completed[blockID][i]
		if activeID != "" && record.ID == activeID {
			record.VisibilityGeneration = generation
		}
	}
	return generation
}

// invalidateAnchors drops the presentation-only anchors outside the journal lock.
func (j *Journal) invalidateAnchors() {
	j.mu.RLock()
	anchors := j.visualAnchors
	j.mu.RUnlock()
	if anchors != nil {
		anchors.Invalidate()
	}
}

// blockGate returns the per-block gate. Everything that changes a block's lifecycle or its
// visibility linearizes through it, and it is always taken outside j.mu.
func (j *Journal) blockGate(blockID string) *sync.Mutex {
	j.gatesMu.Lock()
	defer j.gatesMu.Unlock()
	if j.gates == nil {
		j.gates = make(map[string]*sync.Mutex)
	}
	gate := j.gates[blockID]
	if gate == nil {
		gate = &sync.Mutex{}
		j.gates[blockID] = gate
	}
	return gate
}

// DeleteHistory physically removes completed history while preserving an
// active record by moving it to the new generation.
func (j *Journal) DeleteHistory(blockID string) error {
	if j == nil || blockID == "" {
		return nil
	}
	gate := j.blockGate(blockID)
	gate.Lock()
	defer gate.Unlock()
	j.mu.RLock()
	durable := j.durable
	activeID := ""
	if active := j.active[blockID]; active != nil {
		activeID = active.ID
	}
	j.mu.RUnlock()
	if durable != nil {
		generation, err := durable.DeleteHistory(blockID)
		if err != nil {
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
	} else {
		j.completed[blockID] = nil
	}
	if active := j.active[blockID]; active != nil {
		active.VisibilityGeneration = j.generation[blockID]
	}
	j.mu.Unlock()
	j.invalidateAnchors()
	// The durable delete already retagged the running rows inside its own transaction, so there
	// is no second durable call here: a failure after the commit point cannot exist.
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
	case CompletionMissingFinish, CompletionSuperseded, CompletionSessionEnded, CompletionControllerStop, CompletionPTYError, CompletionEpochChanged, CompletionSidechannelDisconnected:
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
