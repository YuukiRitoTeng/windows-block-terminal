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
	"github.com/wavetermdev/waveterm/pkg/util/migrateutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	DefaultFileName       = "command-journal.sqlite"
	DefaultMaxOutputBytes = 10 * 1024 * 1024
	DefaultMaxChunkBytes  = 256 * 1024
)

type Options struct {
	Enabled        bool
	MaxOutputBytes int64
	MaxChunkBytes  int
	ErrorHandler   func(error)
}

type eventKind int

const (
	eventStarted eventKind = iota
	eventOutput
	eventFinished
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
	db             *sqlx.DB
	path           string
	maxOutputBytes int64
	maxChunkBytes  int
	errorHandler   func(error)
	mu             sync.Mutex
	cond           *sync.Cond
	queue          []event
	closed         bool
	closeOnce      sync.Once
	closeErr       error
	done           chan struct{}
	degraded       error
}

func DefaultPath() string {
	return filepath.Join(wavebase.GetWaveDataDir(), DefaultFileName)
}

func OpenDefault(opts Options) (*Store, error) {
	return Open(DefaultPath(), opts)
}

func Open(path string, opts Options) (*Store, error) {
	if !opts.Enabled {
		return &Store{maxOutputBytes: effectiveLimit(opts.MaxOutputBytes, DefaultMaxOutputBytes), maxChunkBytes: effectiveChunk(opts.MaxChunkBytes, DefaultMaxChunkBytes)}, nil
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
		errorHandler:   opts.ErrorHandler,
		done:           make(chan struct{}),
	}
	store.cond = sync.NewCond(&store.mu)
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
	if len(data) == 0 {
		return nil
	}
	return s.enqueue(event{kind: eventOutput, commandID: commandID, data: append([]byte(nil), data...)})
}
func (s *Store) RecordFinished(record commandjournal.CommandRecord) error {
	return s.enqueue(event{kind: eventFinished, record: record})
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
	return <-ack
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
		s.closeErr = s.db.Close()
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
		s.mu.Unlock()
		result := s.process(e)
		err := result.err
		if err != nil {
			s.mu.Lock()
			s.degraded = err
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

func (s *Store) process(e event) eventResult {
	switch e.kind {
	case eventStarted:
		return eventResult{err: s.insertStarted(e.record)}
	case eventOutput:
		return eventResult{err: s.appendOutput(e.commandID, e.data)}
	case eventFinished:
		return eventResult{err: s.updateFinished(e.record)}
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
	_, err := s.db.Exec(`UPDATE command_records SET visibility_generation=? WHERE id=?`, generation, commandID)
	return err
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
		_, err := tx.Exec(`INSERT OR IGNORE INTO command_records
 (id,wave_block_id,session_epoch,protocol_version,start_hook_sequence,finish_hook_sequence,command,cwd,state,completion_reason,started_at_ms,visibility_generation)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, r.ID, r.WaveBlockID, r.SessionEpoch, 1, r.StartHookSequence, 0, r.Command, r.Cwd, string(r.State), string(r.CompletionReason), r.StartedAt.UnixMilli(), r.VisibilityGeneration)
		return err
	})
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
		_, err := tx.Exec(`UPDATE command_records SET finish_hook_sequence=?,state=?,completion_reason=?,finished_at_ms=?,success=?,exit_code=?,visibility_generation=? WHERE id=?`, r.FinishHookSequence, string(r.State), string(r.CompletionReason), ms(r.FinishedAt), boolInt(r.Success), nullableInt(r.ExitCode), r.VisibilityGeneration, r.ID)
		return err
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
		_, err := tx.Exec(`UPDATE command_records SET finish_hook_sequence=0,state=?,completion_reason=?,finished_at_ms=?,success=NULL,exit_code=NULL,visibility_generation=? WHERE id=?`, string(r.State), string(r.CompletionReason), ms(r.FinishedAt), r.VisibilityGeneration, r.ID)
		return err
	})
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
	_, err := s.db.Exec(`UPDATE command_records SET state=?,completion_reason=?,finish_hook_sequence=0,finished_at_ms=?,success=NULL,exit_code=NULL WHERE state=?`, string(commandjournal.StateAborted), string(commandjournal.CompletionReason("app_restart_recovery")), at.UnixMilli(), string(commandjournal.StateRunning))
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

func (s *Store) ReadVisibleRecords(blockID string) ([]commandjournal.CommandRecord, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	generation, err := s.CurrentVisibilityGeneration(blockID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Queryx(`SELECT id,wave_block_id,session_epoch,protocol_version,start_hook_sequence,finish_hook_sequence,command,cwd,state,completion_reason,started_at_ms,finished_at_ms,success,exit_code,visibility_generation,output_total_bytes,output_stored_bytes,output_truncated FROM command_records WHERE wave_block_id=? AND visibility_generation=? ORDER BY started_at_ms ASC`, blockID, generation)
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
		var state, reason string
		var truncated int
		if err := rows.Scan(&r.ID, &r.WaveBlockID, &r.SessionEpoch, &protocol, &r.StartHookSequence, &r.FinishHookSequence, &r.Command, &r.Cwd, &state, &reason, &started, &finished, &success, &exit, &r.VisibilityGeneration, &r.OutputTotalBytes, &r.OutputStoredBytes, &truncated); err != nil {
			return nil, err
		}
		r.OutputTruncated = truncated != 0
		r.State = commandjournal.CommandState(state)
		r.CompletionReason = commandjournal.CompletionReason(reason)
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
