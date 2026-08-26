package persistence

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/mattn/go-sqlite3"
	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
	"github.com/wavetermdev/waveterm/pkg/util/migrateutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	DefaultFileName       = "command-journal.sqlite"
	DefaultMaxOutputBytes = 10 * 1024 * 1024
	DefaultMaxChunkBytes  = 256 * 1024
	DefaultMaxQueueBytes  = 32 * 1024 * 1024
)

var ErrOutputQueueOverflow = errors.New("command journal output queue budget exceeded")
var ErrRecordNotFound = errors.New("command journal record not found")

type HealthStatus string

const (
	HealthUnavailable HealthStatus = "unavailable"
	HealthAvailable   HealthStatus = "available"
	HealthDegraded    HealthStatus = "degraded"
)

type Health struct {
	Status             HealthStatus
	OutputComplete     bool
	DroppedOutputBytes int64
	Error              string
}

type Options struct {
	Enabled        bool
	MaxOutputBytes int64
	MaxChunkBytes  int
	ErrorHandler   func(error)
	MaxQueueBytes  int64
}

type eventKind int

const (
	eventStarted eventKind = iota
	eventOutput
	eventFinished
	eventOutputFinalized
	eventAborted
	eventAdvance
	eventDelete
	eventRetag
	eventFlush
)

type event struct {
	kind       eventKind
	record     commandjournal.CommandRecord
	commandID  string
	data       []byte
	blockID    string
	generation uint64
	ack        chan error
	result     chan eventResult
}

type eventResult struct {
	generation uint64
	err        error
}

// Store is a product-owned SQLite persistence service with one FIFO writer.
// Public record methods only append to the in-memory queue and never execute
// SQLite work on the PTY observer goroutine.
type Store struct {
	db                 *sqlx.DB
	path               string
	maxOutputBytes     int64
	maxChunkBytes      int
	errorHandler       func(error)
	mu                 sync.Mutex
	cond               *sync.Cond
	queue              []event
	queueBytes         int64
	maxQueueBytes      int64
	closed             bool
	closeOnce          sync.Once
	closeErr           error
	done               chan struct{}
	degraded           error
	droppedOutputBytes int64
	failedCommands     map[string]error
}

func DefaultPath() string {
	return filepath.Join(wavebase.GetWaveDataDir(), DefaultFileName)
}

func OpenDefault(opts Options) (*Store, error) {
	return Open(DefaultPath(), opts)
}

func Open(path string, opts Options) (*Store, error) {
	if !opts.Enabled {
		return &Store{maxOutputBytes: effectiveLimit(opts.MaxOutputBytes, DefaultMaxOutputBytes), maxChunkBytes: effectiveChunk(opts.MaxChunkBytes, DefaultMaxChunkBytes), maxQueueBytes: effectiveLimit(opts.MaxQueueBytes, DefaultMaxQueueBytes)}, nil
	}
	if path == "" {
		return nil, errors.New("command journal persistence path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("creating command journal directory: %w", err)
	}
	db, err := sqlx.Open("sqlite3", fmt.Sprintf("file:%s?mode=rwc&_journal_mode=WAL&_busy_timeout=5000", path))
	if err != nil {
		return nil, fmt.Errorf("opening command journal database: %w", err)
	}
	db.DB.SetMaxOpenConns(1)
	cleanup := func(err error) (*Store, error) {
		_ = db.Close()
		return nil, err
	}
	if _, err = db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		return cleanup(fmt.Errorf("enabling command journal foreign keys: %w", err))
	}
	if err = migrateutil.Migrate("command-journal", db.DB, MigrationFS, "migrations"); err != nil {
		return cleanup(err)
	}
	store := &Store{
		db:             db,
		path:           path,
		maxOutputBytes: effectiveLimit(opts.MaxOutputBytes, DefaultMaxOutputBytes),
		maxChunkBytes:  effectiveChunk(opts.MaxChunkBytes, DefaultMaxChunkBytes),
		maxQueueBytes:  effectiveLimit(opts.MaxQueueBytes, DefaultMaxQueueBytes),
		errorHandler:   opts.ErrorHandler,
		done:           make(chan struct{}),
	}
	store.cond = sync.NewCond(&store.mu)
	store.failedCommands = make(map[string]error)
	if err := store.reconcileOutputMetadata(); err != nil {
		return cleanup(fmt.Errorf("reconciling command journal output metadata: %w", err))
	}
	if err := store.recoverStaleRunning(time.Now()); err != nil {
		return cleanup(fmt.Errorf("recovering stale command journal records: %w", err))
	}
	go store.run()
	return store, nil
}

func effectiveLimit(value, fallback int64) int64 {
	if value <= 0 {
		return fallback
	}
	return value
}

func effectiveChunk(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}

func (s *Store) Enabled() bool { return s != nil && s.db != nil }
func (s *Store) MaxOutputBytes() int64 {
	if s == nil {
		return 0
	}
	return s.maxOutputBytes
}
func (s *Store) Path() string {
	if s == nil {
		return ""
	}
	return s.path
}
func (s *Store) Degraded() error {
	if s == nil {
		return errors.New("nil command journal store")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.degraded
}

func (s *Store) Health() Health {
	if s == nil || s.db == nil {
		return Health{Status: HealthUnavailable, OutputComplete: false}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Health{Status: HealthUnavailable, OutputComplete: false, DroppedOutputBytes: s.droppedOutputBytes}
	}
	health := Health{Status: HealthAvailable, OutputComplete: s.degraded == nil, DroppedOutputBytes: s.droppedOutputBytes}
	if s.degraded != nil {
		health.Status = HealthDegraded
		health.Error = s.degraded.Error()
	}
	return health
}

func (s *Store) enqueue(e event) error {
	if s == nil || s.db == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("command journal persistence is closed")
	}
	s.queue = append(s.queue, e)
	s.cond.Signal()
	return nil
}

func (s *Store) RecordStarted(record commandjournal.CommandRecord) error {
	return s.enqueue(event{kind: eventStarted, record: record})
}
func (s *Store) AppendOutput(commandID string, data []byte) error {
	if s == nil || s.db == nil || len(data) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("command journal persistence is closed")
	}
	if s.degraded != nil {
		s.droppedOutputBytes += int64(len(data))
		return s.degraded
	}
	if s.queueBytes+int64(len(data)) > s.maxQueueBytes {
		s.degraded = ErrOutputQueueOverflow
		s.failedCommands[commandID] = ErrOutputQueueOverflow
		s.droppedOutputBytes += int64(len(data))
		if s.errorHandler != nil {
			go s.errorHandler(ErrOutputQueueOverflow)
		}
		return ErrOutputQueueOverflow
	}
	s.queue = append(s.queue, event{kind: eventOutput, commandID: commandID, data: append([]byte(nil), data...)})
	s.queueBytes += int64(len(data))
	s.cond.Signal()
	return nil
}
func (s *Store) RecordFinished(record commandjournal.CommandRecord) error {
	return s.enqueue(event{kind: eventFinished, record: record})
}
func (s *Store) RecordOutputFinalized(record commandjournal.CommandRecord) error {
	return s.enqueue(event{kind: eventOutputFinalized, record: record})
}
func (s *Store) RecordAborted(record commandjournal.CommandRecord) error {
	return s.enqueue(event{kind: eventAborted, record: record})
}
func (s *Store) RetagRecordGeneration(commandID string, generation uint64) error {
	if s == nil || s.db == nil {
		return nil
	}
	ack := make(chan error, 1)
	if err := s.enqueue(event{kind: eventRetag, commandID: commandID, generation: generation, ack: ack}); err != nil {
		return err
	}
	return <-ack
}

func (s *Store) Flush() error {
	if s == nil || s.db == nil {
		return nil
	}
	ack := make(chan error, 1)
	if err := s.enqueue(event{kind: eventFlush, ack: ack}); err != nil {
		return err
	}
	if err := <-ack; err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.degraded
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.cond.Broadcast()
		s.mu.Unlock()
		<-s.done
		s.mu.Lock()
		writerErr := s.degraded
		s.mu.Unlock()
		s.closeErr = errors.Join(writerErr, s.db.Close())
	})
	return s.closeErr
}

func (s *Store) run() {
	defer close(s.done)
	for {
		s.mu.Lock()
		for len(s.queue) == 0 && !s.closed {
			s.cond.Wait()
		}
		if len(s.queue) == 0 && s.closed {
			s.mu.Unlock()
			return
		}
		e := s.queue[0]
		s.queue = s.queue[1:]
		if e.kind == eventOutput {
			s.queueBytes -= int64(len(e.data))
		}
		s.mu.Unlock()
		result := s.process(e)
		err := result.err
		if err != nil {
			s.mu.Lock()
			if commandID, scoped := commandScopedMissing(e, err); scoped {
				s.failedCommands[commandID] = err
			} else {
				s.degraded = err
			}
			s.mu.Unlock()
			if s.errorHandler != nil {
				s.errorHandler(err)
			} else {
				log.Printf("[command-journal] persistence degraded: %v", err)
			}
		}
		if e.ack != nil {
			e.ack <- err
		}
		if e.result != nil {
			e.result <- result
		}
	}
}

func commandScopedMissing(e event, err error) (string, bool) {
	if !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, ErrRecordNotFound) {
		return "", false
	}
	if e.kind == eventRetag || e.kind == eventStarted {
		return "", false
	}
	commandID := e.commandID
	if commandID == "" {
		commandID = e.record.ID
	}
	if commandID == "" {
		return "", false
	}
	return commandID, true
}

func (s *Store) process(e event) eventResult {
	switch e.kind {
	case eventStarted:
		return eventResult{err: s.insertStarted(e.record)}
	case eventOutput:
		return eventResult{err: s.appendOutput(e.commandID, e.data)}
	case eventFinished:
		return eventResult{err: s.updateFinished(e.record)}
	case eventOutputFinalized:
		return eventResult{err: s.updateOutputFinalized(e.record)}
	case eventAborted:
		return eventResult{err: s.updateAborted(e.record)}
	case eventAdvance:
		generation, err := s.advanceGeneration(e.blockID)
		return eventResult{generation: generation, err: err}
	case eventDelete:
		generation, err := s.deleteHistory(e.blockID)
		return eventResult{generation: generation, err: err}
	case eventRetag:
		return eventResult{err: s.retagRecordGeneration(e.commandID, e.generation)}
	case eventFlush:
		return eventResult{}
	default:
		return eventResult{err: fmt.Errorf("unknown command journal persistence event %d", e.kind)}
	}
}

func (s *Store) retagRecordGeneration(commandID string, generation uint64) error {
	result, err := s.db.Exec(`UPDATE command_records SET visibility_generation=? WHERE id=?`, generation, commandID)
	if err != nil {
		return err
	}
	return requireRows(result)
}

func (s *Store) withTx(fn func(*sql.Tx) error) error {
	tx, err := s.db.Beginx()
	if err != nil {
		return err
	}
	if err := fn(tx.Tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func ms(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UnixMilli()
}
func boolInt(v *bool) any {
	if v == nil {
		return nil
	}
	if *v {
		return 1
	}
	return 0
}

func (s *Store) insertStarted(r commandjournal.CommandRecord) error {
	return s.withTx(func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO command_records
			(id,wave_block_id,session_epoch,protocol_version,start_hook_sequence,finish_hook_sequence,command,cwd,state,completion_reason,started_at_ms,visibility_generation,output_completeness,output_attribution,output_text_safety,output_state,execution_mode,output_source,runtime_host_id,runtime_runspace_id,capture_contract_version)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, r.ID, r.WaveBlockID, r.SessionEpoch, protocolVersion(r), r.StartHookSequence, 0, r.Command, r.Cwd, string(r.State), string(r.CompletionReason), r.StartedAt.UnixMilli(), r.VisibilityGeneration, outputCompleteness(r), outputAttribution(r), outputTextSafety(r), outputState(r), executionMode(r), outputSource(r), r.RuntimeHostID, r.RuntimeRunspaceID, captureContractVersion(r))
		return err
	})
}

func protocolVersion(r commandjournal.CommandRecord) int {
	if r.ProtocolVersion > 0 {
		return r.ProtocolVersion
	}
	return 1
}

func captureContractVersion(r commandjournal.CommandRecord) int {
	if r.CaptureContractVersion > 0 {
		return r.CaptureContractVersion
	}
	return 0
}

func (s *Store) reconcileOutputMetadata() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT r.id,r.output_total_bytes,r.output_stored_bytes,r.output_truncated,r.output_completeness,r.output_attribution,COALESCE(SUM(c.byte_count),0) FROM command_records r LEFT JOIN command_output_chunks c ON c.command_id=r.id GROUP BY r.id`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	type repair struct {
		id                        string
		total, stored, chunkBytes int64
		truncated                 int
		completeness, attribution string
	}
	var repairs []repair
	for rows.Next() {
		var r repair
		if err := rows.Scan(&r.id, &r.total, &r.stored, &r.truncated, &r.completeness, &r.attribution, &r.chunkBytes); err != nil {
			_ = rows.Close()
			_ = tx.Rollback()
			return err
		}
		if r.chunkBytes != r.stored || r.stored > r.total {
			if r.chunkBytes > r.total {
				r.total = r.chunkBytes
			}
			r.stored = r.chunkBytes
			r.truncated = boolIntValue(r.stored < r.total)
			r.completeness = commandjournal.OutputCompletenessIncomplete
			r.attribution = commandjournal.OutputAttributionUnknown
			repairs = append(repairs, r)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		_ = tx.Rollback()
		return err
	}
	_ = rows.Close()
	for _, r := range repairs {
		if _, err := tx.Exec(`UPDATE command_records SET output_total_bytes=?,output_stored_bytes=?,output_truncated=?,output_completeness=?,output_attribution=? WHERE id=?`, r.total, r.stored, r.truncated, r.completeness, r.attribution, r.id); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func executionMode(r commandjournal.CommandRecord) string {
	if r.ExecutionMode != "" {
		return string(r.ExecutionMode)
	}
	return "unknown"
}

func outputSource(r commandjournal.CommandRecord) string {
	if r.OutputSource != "" {
		return string(r.OutputSource)
	}
	return "unknown"
}

func (s *Store) appendOutput(id string, data []byte) error {
	return s.withTx(func(tx *sql.Tx) error {
		inputLen := int64(len(data))
		var total, stored int64
		if err := tx.QueryRow(`SELECT output_total_bytes, output_stored_bytes FROM command_records WHERE id=?`, id).Scan(&total, &stored); err != nil {
			return err
		}
		var next int
		if err := tx.QueryRow(`SELECT COALESCE(MAX(chunk_index)+1,0) FROM command_output_chunks WHERE command_id=?`, id).Scan(&next); err != nil {
			return err
		}
		remaining := s.maxOutputBytes - stored
		storedNow := int64(0)
		for len(data) > 0 && remaining > 0 {
			n := len(data)
			if n > s.maxChunkBytes {
				n = s.maxChunkBytes
			}
			if int64(n) > remaining {
				n = int(remaining)
			}
			chunk := append([]byte(nil), data[:n]...)
			if _, err := tx.Exec(`INSERT INTO command_output_chunks(command_id,chunk_index,raw_bytes,byte_count) VALUES(?,?,?,?)`, id, next, chunk, n); err != nil {
				return err
			}
			next++
			storedNow += int64(n)
			remaining -= int64(n)
			data = data[n:]
		}
		total += inputLen
		stored += storedNow
		_, err := tx.Exec(`UPDATE command_records SET output_total_bytes=?,output_stored_bytes=?,output_truncated=? WHERE id=?`, total, stored, boolIntValue(stored < total), id)
		return err
	})
}

func boolIntValue(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (s *Store) updateFinished(r commandjournal.CommandRecord) error {
	return s.withTx(func(tx *sql.Tx) error {
		facts, err := s.readOutputFacts(tx, r.ID)
		if err != nil {
			return err
		}
		completion, attribution := s.durableOutputMetadata(r, facts)
		total := r.OutputTotalBytes
		if facts.total > total {
			total = facts.total
		}
		truncated := r.OutputTruncated || facts.truncated || facts.stored < total
		result, err := tx.Exec(`UPDATE command_records SET finish_hook_sequence=?,state=?,completion_reason=?,finished_at_ms=?,success=?,exit_code=?,visibility_generation=?,output_total_bytes=?,output_stored_bytes=?,output_truncated=?,output_completeness=?,output_attribution=?,output_text_safety=?,output_state=? WHERE id=?`, r.FinishHookSequence, string(r.State), string(r.CompletionReason), ms(r.FinishedAt), boolInt(r.Success), nullableInt(r.ExitCode), r.VisibilityGeneration, total, facts.stored, boolIntValue(truncated), completion, attribution, outputTextSafety(r), outputState(r), r.ID)
		if err != nil {
			return err
		}
		return requireRows(result)
	})
}

func (s *Store) updateOutputFinalized(r commandjournal.CommandRecord) error {
	return s.withTx(func(tx *sql.Tx) error {
		facts, err := s.readOutputFacts(tx, r.ID)
		if err != nil {
			return err
		}
		completion, attribution := s.durableOutputMetadata(r, facts)
		result, err := tx.Exec(`UPDATE command_records SET output_stored_bytes=?,output_truncated=?,output_completeness=?,output_attribution=?,output_text_safety=?,output_state=? WHERE id=?`, facts.stored, boolIntValue(facts.truncated || facts.stored < facts.total), completion, attribution, outputTextSafety(r), outputState(r), r.ID)
		if err != nil {
			return err
		}
		return requireRows(result)
	})
}

func nullableInt(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func (s *Store) updateAborted(r commandjournal.CommandRecord) error {
	return s.withTx(func(tx *sql.Tx) error {
		result, err := tx.Exec(`UPDATE command_records SET finish_hook_sequence=0,state=?,completion_reason=?,finished_at_ms=?,success=NULL,exit_code=NULL,visibility_generation=?,output_completeness=?,output_attribution=?,output_text_safety=?,output_state=? WHERE id=?`, string(r.State), string(r.CompletionReason), ms(r.FinishedAt), r.VisibilityGeneration, outputCompleteness(r), outputAttribution(r), outputTextSafety(r), outputState(r), r.ID)
		if err != nil {
			return err
		}
		return requireRows(result)
	})
}

type durableOutputFacts struct {
	total      int64
	stored     int64
	truncated  bool
	chunkBytes int64
}

func (s *Store) readOutputFacts(tx *sql.Tx, commandID string) (durableOutputFacts, error) {
	var facts durableOutputFacts
	var truncated int
	err := tx.QueryRow(`SELECT output_total_bytes,output_stored_bytes,output_truncated,COALESCE((SELECT SUM(byte_count) FROM command_output_chunks WHERE command_id=?),0) FROM command_records WHERE id=?`, commandID, commandID).Scan(&facts.total, &facts.stored, &truncated, &facts.chunkBytes)
	if err != nil {
		return facts, err
	}
	facts.truncated = truncated != 0
	return facts, nil
}

func (s *Store) durableOutputMetadata(r commandjournal.CommandRecord, facts durableOutputFacts) (string, string) {
	completion := outputCompleteness(r)
	attribution := outputAttribution(r)
	failed := s.commandFailure(r.ID) != nil
	mismatch := facts.chunkBytes != facts.stored || facts.stored > facts.total || r.OutputStoredBytes != facts.stored || (r.OutputTotalBytes > 0 && r.OutputTotalBytes != facts.total)
	if failed || mismatch {
		if completion == commandjournal.OutputCompletenessComplete || failed {
			completion = commandjournal.OutputCompletenessIncomplete
		}
		attribution = commandjournal.OutputAttributionUnknown
	}
	if completion == commandjournal.OutputCompletenessComplete && attribution == commandjournal.OutputAttributionExclusive {
		if facts.truncated || facts.stored != facts.total || facts.chunkBytes != facts.stored || failed {
			completion = commandjournal.OutputCompletenessIncomplete
			attribution = commandjournal.OutputAttributionUnknown
		}
	}
	return completion, attribution
}

func (s *Store) commandFailure(commandID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failedCommands[commandID]
}

func requireRows(result sql.Result) error {
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrRecordNotFound
	}
	return nil
}

func outputCompleteness(r commandjournal.CommandRecord) string {
	if r.OutputCompleteness != "" {
		return r.OutputCompleteness
	}
	if r.OutputTruncated {
		return commandjournal.OutputCompletenessTruncated
	}
	return commandjournal.OutputCompletenessUnknown
}

func outputAttribution(r commandjournal.CommandRecord) string {
	if r.OutputAttribution != "" {
		return r.OutputAttribution
	}
	return commandjournal.OutputAttributionUnknown
}

func outputTextSafety(r commandjournal.CommandRecord) string {
	if r.OutputTextSafety != "" {
		return r.OutputTextSafety
	}
	return commandjournal.OutputTextSafetyUnknown
}

func outputState(r commandjournal.CommandRecord) string {
	if r.OutputState != "" {
		return string(r.OutputState)
	}
	if r.State == commandjournal.StateRunning {
		return string(commandjournal.OutputStateOpen)
	}
	return string(commandjournal.OutputStateClosed)
}

func (s *Store) CurrentVisibilityGeneration(blockID string) (uint64, error) {
	if s == nil || s.db == nil {
		return 0, nil
	}
	var generation uint64
	if err := s.db.QueryRow(`SELECT current_visibility_generation FROM journal_state WHERE wave_block_id=?`, blockID).Scan(&generation); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return generation, nil
}

func (s *Store) AdvanceVisibilityGeneration(blockID string) (uint64, error) {
	if s == nil || s.db == nil {
		return 1, nil
	}
	result := make(chan eventResult, 1)
	if err := s.enqueue(event{kind: eventAdvance, blockID: blockID, result: result}); err != nil {
		return 0, err
	}
	completed := <-result
	return completed.generation, completed.err
}

func (s *Store) advanceGeneration(blockID string) (uint64, error) {
	var generation uint64
	err := s.withTx(func(tx *sql.Tx) error {
		if err := tx.QueryRow(`SELECT current_visibility_generation FROM journal_state WHERE wave_block_id=?`, blockID).Scan(&generation); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		generation++
		if _, err := tx.Exec(`INSERT INTO journal_state(wave_block_id,current_visibility_generation) VALUES(?,?) ON CONFLICT(wave_block_id) DO UPDATE SET current_visibility_generation=excluded.current_visibility_generation`, blockID, generation); err != nil {
			return err
		}
		_, err := tx.Exec(`UPDATE command_records SET visibility_generation=? WHERE wave_block_id=? AND state=?`, generation, blockID, string(commandjournal.StateRunning))
		return err
	})
	return generation, err
}

func (s *Store) DeleteHistory(blockID string) (uint64, error) {
	if s == nil || s.db == nil {
		return 1, nil
	}
	result := make(chan eventResult, 1)
	if err := s.enqueue(event{kind: eventDelete, blockID: blockID, result: result}); err != nil {
		return 0, err
	}
	completed := <-result
	return completed.generation, completed.err
}

func (s *Store) deleteHistory(blockID string) (uint64, error) {
	var generation uint64
	err := s.withTx(func(tx *sql.Tx) error {
		if err := tx.QueryRow(`SELECT current_visibility_generation FROM journal_state WHERE wave_block_id=?`, blockID).Scan(&generation); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		generation++
		if _, err := tx.Exec(`INSERT INTO journal_state(wave_block_id,current_visibility_generation) VALUES(?,?) ON CONFLICT(wave_block_id) DO UPDATE SET current_visibility_generation=excluded.current_visibility_generation`, blockID, generation); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE command_records SET visibility_generation=? WHERE wave_block_id=? AND state=?`, generation, blockID, string(commandjournal.StateRunning)); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM command_records WHERE wave_block_id=? AND state<>?`, blockID, string(commandjournal.StateRunning))
		return err
	})
	return generation, err
}

func (s *Store) recoverStaleRunning(at time.Time) error {
	_, err := s.db.Exec(`UPDATE command_records SET state=?,completion_reason=?,finish_hook_sequence=0,finished_at_ms=?,success=NULL,exit_code=NULL,output_state=?,output_completeness=CASE WHEN output_truncated<>0 THEN 'truncated' ELSE 'unknown' END,output_attribution=? WHERE state=?`, string(commandjournal.StateAborted), string(commandjournal.CompletionReason("app_restart_recovery")), at.UnixMilli(), string(commandjournal.OutputStateClosed), commandjournal.OutputAttributionUnknown, string(commandjournal.StateRunning))
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE command_records SET output_state=?,output_completeness=CASE WHEN output_truncated<>0 THEN 'truncated' ELSE 'unknown' END,output_attribution=? WHERE state=? AND output_state=?`, string(commandjournal.OutputStateClosed), commandjournal.OutputAttributionUnknown, string(commandjournal.StateFinished), string(commandjournal.OutputStatePending))
	return err
}

func (s *Store) ReadOutput(commandID string) ([]byte, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	rows, err := s.db.Queryx(`SELECT raw_bytes FROM command_output_chunks WHERE command_id=? ORDER BY chunk_index ASC`, commandID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var output []byte
	for rows.Next() {
		var chunk []byte
		if err := rows.Scan(&chunk); err != nil {
			return nil, err
		}
		output = append(output, chunk...)
	}
	return output, rows.Err()
}

func (s *Store) ReadRecord(commandID string) (*commandjournal.CommandRecord, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	var r commandjournal.CommandRecord
	var protocol int
	var started, finished sql.NullInt64
	var success, exit sql.NullInt64
	var state, reason, mode, source, hostID, runspaceID string
	var captureContract int
	var truncated int
	err := s.db.QueryRow(`SELECT id,wave_block_id,session_epoch,protocol_version,start_hook_sequence,finish_hook_sequence,command,cwd,state,completion_reason,started_at_ms,finished_at_ms,success,exit_code,visibility_generation,output_total_bytes,output_stored_bytes,output_truncated,output_completeness,output_attribution,output_text_safety,output_state,execution_mode,output_source,runtime_host_id,runtime_runspace_id,capture_contract_version FROM command_records WHERE id=?`, commandID).Scan(&r.ID, &r.WaveBlockID, &r.SessionEpoch, &protocol, &r.StartHookSequence, &r.FinishHookSequence, &r.Command, &r.Cwd, &state, &reason, &started, &finished, &success, &exit, &r.VisibilityGeneration, &r.OutputTotalBytes, &r.OutputStoredBytes, &truncated, &r.OutputCompleteness, &r.OutputAttribution, &r.OutputTextSafety, &r.OutputState, &mode, &source, &hostID, &runspaceID, &captureContract)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.OutputTruncated = truncated != 0
	r.State = commandjournal.CommandState(state)
	r.CompletionReason = commandjournal.CompletionReason(reason)
	r.ProtocolVersion = protocol
	r.ExecutionMode = terminalruntime.ExecutionMode(mode)
	r.OutputSource = terminalruntime.OutputSource(source)
	r.RuntimeHostID = hostID
	r.RuntimeRunspaceID = runspaceID
	r.CaptureContractVersion = captureContract
	r.StartedAt = time.UnixMilli(started.Int64)
	if finished.Valid {
		v := time.UnixMilli(finished.Int64)
		r.FinishedAt = &v
	}
	if success.Valid {
		v := success.Int64 != 0
		r.Success = &v
	}
	if exit.Valid {
		v := int(exit.Int64)
		r.ExitCode = &v
	}
	return &r, nil
}

type OutputRead struct {
	Data         []byte
	TotalBytes   int64
	StoredBytes  int64
	Truncated    bool
	Completeness string
	Attribution  string
	TextSafety   string
	State        string
}

func (s *Store) ReadOutputWithMetadata(commandID string) (*OutputRead, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	tx, err := s.db.Beginx()
	if err != nil {
		return nil, err
	}
	var total, stored int64
	var truncated int
	var completeness, attribution, textSafety, state string
	err = tx.QueryRow(`SELECT output_total_bytes,output_stored_bytes,output_truncated,output_completeness,output_attribution,output_text_safety,output_state FROM command_records WHERE id=?`, commandID).Scan(&total, &stored, &truncated, &completeness, &attribution, &textSafety, &state)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return nil, nil
	}
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	rows, err := tx.Queryx(`SELECT raw_bytes FROM command_output_chunks WHERE command_id=? ORDER BY chunk_index ASC`, commandID)
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	var data []byte
	for rows.Next() {
		var chunk []byte
		if err := rows.Scan(&chunk); err != nil {
			_ = rows.Close()
			_ = tx.Rollback()
			return nil, err
		}
		data = append(data, chunk...)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		_ = tx.Rollback()
		return nil, err
	}
	_ = rows.Close()
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &OutputRead{Data: data, TotalBytes: total, StoredBytes: stored, Truncated: truncated != 0, Completeness: completeness, Attribution: attribution, TextSafety: textSafety, State: state}, nil
}

func (s *Store) ReadVisibleRecords(blockID string) ([]commandjournal.CommandRecord, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	rows, err := s.db.Queryx(`SELECT id,wave_block_id,session_epoch,protocol_version,start_hook_sequence,finish_hook_sequence,command,cwd,state,completion_reason,started_at_ms,finished_at_ms,success,exit_code,visibility_generation,output_total_bytes,output_stored_bytes,output_truncated,output_completeness,output_attribution,output_text_safety,output_state,execution_mode,output_source,runtime_host_id,runtime_runspace_id,capture_contract_version FROM command_records WHERE wave_block_id=? AND visibility_generation=COALESCE((SELECT current_visibility_generation FROM journal_state WHERE wave_block_id=?),0) ORDER BY started_at_ms ASC`, blockID, blockID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []commandjournal.CommandRecord
	for rows.Next() {
		var r commandjournal.CommandRecord
		var protocol int
		var started, finished sql.NullInt64
		var success, exit sql.NullInt64
		var state, reason, mode, source, hostID, runspaceID string
		var captureContract int
		var truncated int
		if err := rows.Scan(&r.ID, &r.WaveBlockID, &r.SessionEpoch, &protocol, &r.StartHookSequence, &r.FinishHookSequence, &r.Command, &r.Cwd, &state, &reason, &started, &finished, &success, &exit, &r.VisibilityGeneration, &r.OutputTotalBytes, &r.OutputStoredBytes, &truncated, &r.OutputCompleteness, &r.OutputAttribution, &r.OutputTextSafety, &r.OutputState, &mode, &source, &hostID, &runspaceID, &captureContract); err != nil {
			return nil, err
		}
		r.OutputTruncated = truncated != 0
		r.State = commandjournal.CommandState(state)
		r.CompletionReason = commandjournal.CompletionReason(reason)
		r.ProtocolVersion = protocol
		r.ExecutionMode = terminalruntime.ExecutionMode(mode)
		r.OutputSource = terminalruntime.OutputSource(source)
		r.RuntimeHostID = hostID
		r.RuntimeRunspaceID = runspaceID
		r.CaptureContractVersion = captureContract
		r.StartedAt = time.UnixMilli(started.Int64)
		if finished.Valid {
			v := time.UnixMilli(finished.Int64)
			r.FinishedAt = &v
		}
		if success.Valid {
			v := success.Int64 != 0
			r.Success = &v
		}
		if exit.Valid {
			v := int(exit.Int64)
			r.ExitCode = &v
		}
		records = append(records, r)
	}
	return records, rows.Err()
}

// CountRecords is a diagnostic/read-model helper used by persistence
// validation; it does not alter journal state.
func (s *Store) CountRecords(blockID string) (int, error) {
	if s == nil || s.db == nil {
		return 0, nil
	}
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM command_records WHERE wave_block_id=?`, blockID).Scan(&count)
	return count, err
}
