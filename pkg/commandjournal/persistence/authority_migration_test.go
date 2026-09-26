package persistence

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
	"github.com/wavetermdev/waveterm/pkg/util/migrateutil"
)

// historicalRecord is one pre-authority row: the provenance columns exactly as
// the producers wrote them before the authority column existed.
type historicalRecord struct {
	id           string
	outputSource string
	mode         string
	hostID       string
	runspaceID   string
	contract     int
	want         terminalruntime.Authority
}

// The backfill matrix. Hosted *interactive* commands are output_source = 'pty'
// with hosted runtime identity, so PTY output alone must never yield
// terminal-osc.
var authorityBackfillMatrix = []historicalRecord{
	{
		id: "hosted-structured", outputSource: "hostStructured", mode: "structured",
		hostID: "host-1", runspaceID: "runspace-1", contract: 1,
		want: terminalruntime.AuthorityHostedSidechannel,
	},
	{
		id: "hosted-interactive", outputSource: "pty", mode: "interactive",
		hostID: "host-1", runspaceID: "runspace-1", contract: 1,
		want: terminalruntime.AuthorityHostedSidechannel,
	},
	{
		id: "hosted-identity-only", outputSource: "pty", mode: "unknown",
		hostID: "host-1", runspaceID: "runspace-1", contract: 0,
		want: terminalruntime.AuthorityHostedSidechannel,
	},
	{
		id: "hosted-structured-source-only", outputSource: "hostStructured", mode: "unknown",
		want: terminalruntime.AuthorityHostedSidechannel,
	},
	{
		id: "osc-pty", outputSource: "pty", mode: "unknown",
		want: terminalruntime.AuthorityTerminalOSC,
	},
	{
		id: "ambiguous-no-provenance", outputSource: "unknown", mode: "unknown",
		want: terminalruntime.AuthorityUnknown,
	},
	{
		id: "ambiguous-pty-with-contract", outputSource: "pty", mode: "unknown", contract: 1,
		want: terminalruntime.AuthorityUnknown,
	},
	{
		id: "ambiguous-host-without-runspace", outputSource: "pty", mode: "unknown",
		hostID: "host-1",
		want:   terminalruntime.AuthorityUnknown,
	},
	{
		id: "ambiguous-runspace-without-host", outputSource: "pty", mode: "unknown",
		runspaceID: "runspace-1",
		want:       terminalruntime.AuthorityUnknown,
	},
	{
		id: "ambiguous-pty-with-hosted-mode", outputSource: "pty", mode: "unknown",
		hostID: "host-1", runspaceID: "runspace-1", contract: 0,
		want: terminalruntime.AuthorityHostedSidechannel,
	},
}

// openAtVersion builds a journal database that already contains the historical
// rows and is parked at schema version 4, so opening the store runs exactly the
// authority migration over them.
func openAtVersion(t *testing.T, rows []historicalRecord) (string, func()) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "authority.sqlite")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"000001_init.up.sql",
		"000002_output_contract.up.sql",
		"000003_output_state.up.sql",
		"000004_persistence_provenance.up.sql",
	} {
		data, err := os.ReadFile(filepath.Join("migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(data)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := db.Exec(`CREATE TABLE schema_migrations (version INTEGER NOT NULL PRIMARY KEY, dirty BOOLEAN NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO schema_migrations(version,dirty) VALUES(4,0)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if _, err := db.Exec(`INSERT INTO command_records
			(id,wave_block_id,session_epoch,protocol_version,start_hook_sequence,command,cwd,state,completion_reason,started_at_ms,visibility_generation,output_completeness,output_attribution,output_text_safety,output_state,execution_mode,output_source,runtime_host_id,runtime_runspace_id,capture_contract_version)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			row.id, "block", "epoch", 1, 1, "echo", `C:\`, "finished", "normal", 1, 0,
			"complete", "exclusive", "unknown", "closed",
			row.mode, row.outputSource, row.hostID, row.runspaceID, row.contract); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path, func() {}
}

// The migration recovers only what the historical provenance proves, and leaves
// everything else unknown.
func TestAuthorityMigrationBackfillMatrix(t *testing.T) {
	path, cleanup := openAtVersion(t, authorityBackfillMatrix)
	defer cleanup()

	store, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	for _, row := range authorityBackfillMatrix {
		record, err := store.ReadRecord(row.id)
		if err != nil || record == nil {
			t.Fatalf("%s: record=%#v err=%v", row.id, record, err)
		}
		if record.Authority != row.want {
			t.Errorf("%s: authority=%q want %q (source=%q mode=%q host=%q runspace=%q contract=%d)",
				row.id, record.Authority, row.want, row.outputSource, row.mode, row.hostID, row.runspaceID, row.contract)
		}
	}
}

// A hosted interactive row must not be mistaken for the in-band authority: both
// are PTY-attributed, and only the hosted runtime identity separates them.
func TestAuthorityMigrationHostedInteractiveIsNotTerminalOSC(t *testing.T) {
	row := historicalRecord{
		id: "hosted-interactive", outputSource: "pty", mode: "interactive",
		hostID: "host-1", runspaceID: "runspace-1", contract: 1,
	}
	path, cleanup := openAtVersion(t, []historicalRecord{row})
	defer cleanup()

	store, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	record, err := store.ReadRecord(row.id)
	if err != nil || record == nil {
		t.Fatalf("record=%#v err=%v", record, err)
	}
	if record.Authority != terminalruntime.AuthorityHostedSidechannel {
		t.Fatalf("hosted interactive row authority=%q want %q", record.Authority, terminalruntime.AuthorityHostedSidechannel)
	}
	if record.OutputSource != terminalruntime.OutputSourcePTY || record.ExecutionMode != terminalruntime.ExecutionModeInteractive {
		t.Fatalf("test row is not the hosted interactive shape: %#v", record)
	}
}

// An in-band record is only recovered when nothing hosted exists in its
// provenance: PTY output with a recovered capture contract stays unknown.
func TestAuthorityMigrationAmbiguousPTYStaysUnknown(t *testing.T) {
	path, cleanup := openAtVersion(t, []historicalRecord{
		{id: "ambiguous", outputSource: "pty", mode: "unknown", hostID: "host-1", runspaceID: "runspace-1", contract: 1},
	})
	defer cleanup()
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	// Strip the hosted identity but keep the capture contract: PTY alone, with a
	// contract the in-band producer never writes, proves nothing.
	if _, err := db.Exec(`UPDATE command_records SET runtime_host_id = '', runtime_runspace_id = ''`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE schema_migrations SET version = 4`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	record, err := store.ReadRecord("ambiguous")
	if err != nil || record == nil {
		t.Fatalf("record=%#v err=%v", record, err)
	}
	if record.Authority != terminalruntime.AuthorityUnknown {
		t.Fatalf("ambiguous PTY row was backfilled as %q", record.Authority)
	}
}

// The down migration removes the column and leaves the records readable by a
// schema-level reader.
func TestAuthorityMigrationDown(t *testing.T) {
	path, cleanup := openAtVersion(t, authorityBackfillMatrix)
	defer cleanup()

	store, err := Open(path, Options{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if !columnExists(t, db, "command_records", "authority") {
		t.Fatal("authority column missing after up migration")
	}

	m, err := migrateutil.MakeMigrate("command-journal", db, MigrationFS, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Steps(-1); err != nil {
		t.Fatalf("down migration failed: %v", err)
	}
	if columnExists(t, db, "command_records", "authority") {
		t.Fatal("authority column still present after down migration")
	}

	rows, err := db.Query(`SELECT id FROM command_records ORDER BY id`)
	if err != nil {
		t.Fatalf("records unreadable after down migration: %v", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		seen++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if seen != len(authorityBackfillMatrix) {
		t.Fatalf("down migration lost records: %d of %d", seen, len(authorityBackfillMatrix))
	}
}

func columnExists(t *testing.T, db *sql.DB, table string, column string) bool {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		if name == column {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return false
}

var _ = commandjournal.StateFinished
